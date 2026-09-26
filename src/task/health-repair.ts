/**
 * health-repair — a red static check at a pre-task checkpoint becomes a repair
 * entry in the running plan, BEFORE the next planned task builds on it.
 *
 * The failure this closes: red enters the tree by three doors — a task whose
 * regression was accepted, a leftover from an abandoned run swept in by the
 * checkpoint commit, a repo that was red when the run began — and none of them is
 * a gate. The health baseline (health-baseline.ts) stops the NEXT task being
 * blamed, but blaming nobody is not fixing it: every later task inherits the red,
 * and only the run-end gate re-checks it. All three doors pass the checkpoint,
 * which already measures health for the baseline, so that one measurement is
 * where the repair is scheduled.
 *
 * The subject of a repair is what the health output NAMES: the tracked files the
 * failing command reported, or the command itself when it named none. The plan is
 * the dedup ledger — a title covering the same command, or any of the same files,
 * means no second entry, checked-off ones included, which is what stops a repair
 * that failed from being re-spawned.
 *
 * A red TEST command is repaired only when a task's regression of it is on the
 * debt ledger. A suite can also be red because a database is not up here, or
 * because its script is a placeholder `exit 1`, and no repair task can fix either.
 */
import type {HealthSignal} from './health-baseline.js'
import {isHealthRed, type HealthCommandResult} from './repo-health-check.js'
import {reportedSuffix} from './command-run.js'
import {parseRepairTitleFile} from './root-cause-repair.js'
import {failClassOfReason} from './verify-work.js'

/** A path-like token: at least one directory separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@-]+[\\/])+[\w.@-]+\.\w+/g

/** The failing check, and what its output named. */
export interface HealthRed {
    command: string
    exitCode: number | null
    /** The runner's failure summary, when it overruled an exit 0. */
    report?: string
    /** Repo-relative tracked paths the output named, in first-seen order. */
    files: string[]
}

export interface HealthRedOwners {
    /** Task ids whose commits introduced the named files; empty when nothing in
     *  the run owns them (a leftover, or a red the run started on). */
    owners: string[]
}

function normalisePath(p: string): string {
    return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim()
}

/**
 * Resolve a token the output printed to the ONE tracked file it names. Linters
 * print absolute paths, compilers print repo-relative ones, and a stack trace
 * prints `node_modules/...` — the tracked list is what tells a deliverable from
 * noise. An ambiguous suffix (two tracked `src/x.ts`) resolves to nothing rather
 * than to a guess.
 */
function resolveTracked(token: string, cwd: string, tracked: readonly string[]): string | null {
    let t = normalisePath(token)
    const root = normalisePath(cwd)
    if (root.length > 0 && t.startsWith(`${root}/`)) t = t.slice(root.length + 1)
    if (tracked.includes(t)) return t
    const bySuffix = tracked.filter(r => t.endsWith(`/${r}`))
    return bySuffix.length === 1 ? bySuffix[0] : null
}

/**
 * What a red health result is about: every red command that `mayRepair` admits,
 * in run order. Empty when there is none — a legacy baseline, a signal with no
 * per-command detail, or only reds no repair can fix — so nothing to pin to.
 *
 * A vanished suite is red here though it failed nothing and left `ok` true. It
 * is the regression the differential exists to catch, and without a subject
 * ACCEPT queued no repair for it and the checkpoint spliced none.
 */
export function healthReds(
    health: HealthSignal & {output?: string},
    cwd: string,
    tracked: readonly string[] | null,
    mayRepair: (c: HealthCommandResult) => boolean = () => true
): HealthRed[] {
    return (health.commands ?? [])
        .filter(c => isHealthRed(c) && mayRepair(c))
        .map(failing => {
            const files: string[] = []
            if (tracked) {
                for (const m of (failing.output ?? health.output ?? '').matchAll(PATH_TOKEN_RE)) {
                    const rel = resolveTracked(m[0], cwd, tracked)
                    if (rel !== null && !files.includes(rel)) files.push(rel)
                }
            }
            return {
                command: failing.cmd,
                exitCode: failing.exitCode,
                files,
                ...(failing.report === undefined ? {} : {report: failing.report})
            }
        })
}

/** The first of {@link healthReds}, or null. */
export function healthRedSubject(
    health: HealthSignal & {output?: string},
    cwd: string,
    tracked: readonly string[] | null,
    mayRepair?: (c: HealthCommandResult) => boolean
): HealthRed | null {
    return healthReds(health, cwd, tracked, mayRepair)[0] ?? null
}

/**
 * Is a red TEST command owed? True when an open debt records a task's regression
 * of it — an accepted `test suite:` FAIL naming the command. An inherited-health
 * debt does not count: every task in a run whose suite needs a missing database
 * records one.
 */
export function suiteRegressionOwed(
    cmd: string,
    openDebts: readonly {reason: string; origin?: string}[]
): boolean {
    return openDebts.some(
        d =>
            d.origin !== 'inherited-health'
            && failClassOfReason(d.reason) === 'test-suite'
            && d.reason.includes(`\`${cmd}\``)
    )
}

// ─── Plan entry ──────────────────────────────────────────────────────────────

/**
 * The plan title, in one of two fixed shapes the parser below recovers:
 *   `repair src/a.ts, src/b.ts: \`bun run lint\` exits 1 (introduced by TASK_0033)`
 *   `repair \`bun run lint\`: exits 1 (no task in this run owns it)`
 * The subject sits right after the prefix so it is both the dedup key and what
 * the scope fence pins.
 */
export function buildHealthRepairTitle(red: HealthRed & HealthRedOwners): string {
    const exits = `exits ${red.exitCode ?? '?'}${reportedSuffix(red)}`
    const owner =
        red.owners.length > 0 ?
            `introduced by ${red.owners.join(', ')}`
        :   'no task in this run owns it'
    return red.files.length > 0 ?
            `repair ${red.files.join(', ')}: \`${red.command}\` ${exits} (${owner})`
        :   `repair \`${red.command}\`: ${exits} (${owner})`
}

export interface HealthRepairSubject {
    command: string
    files: string[]
}

const PATH = String.raw`(?:[\w.@-]+\/)*[\w.@-]+\.\w+`
const HEALTH_REPAIR_TITLE_RE = new RegExp(
    `^repair\\s+(?:\`([^\`]+)\`\\s*:\\s*exits|(${PATH}(?:,\\s*${PATH})*)\\s*:\\s*\`([^\`]+)\`\\s+exits)\\s`
)

/** The command and files a health-repair title names, or null for any other title. */
export function parseHealthRepairTitle(title: string): HealthRepairSubject | null {
    const m = HEALTH_REPAIR_TITLE_RE.exec(title.trim())
    if (!m) return null
    if (m[1] !== undefined) return {command: m[1].trim(), files: []}
    return {command: m[3].trim(), files: m[2].split(',').map(f => f.trim())}
}

/** A plan entry as coverage reads it: its title, and the task it produced. */
export interface PlanEntryRef {
    title: string
    producedId?: string
}

/**
 * Does the plan already carry a repair for this red? Same command, or any of the
 * same files — including a file-scoped root-cause repair (root-cause-repair.ts),
 * which pins the same file. Checked-off entries count: a repair that ran and
 * failed lands in the debt ledger, never in the plan a second time.
 *
 * `repaired` holds the tasks that closed a debt: their check went green, so the
 * same check red again is a new regression the next repair is for.
 */
export function planCoversHealthRed(
    entries: readonly PlanEntryRef[],
    red: HealthRed,
    repaired: ReadonlySet<string> = new Set()
): boolean {
    const files = new Set(red.files.map(f => normalisePath(f).toLowerCase()))
    return entries.some(({title: t, producedId}) => {
        if (producedId !== undefined && repaired.has(producedId)) return false
        const rootCause = parseRepairTitleFile(t)
        if (rootCause !== null && files.has(normalisePath(rootCause).toLowerCase())) return true
        const h = parseHealthRepairTitle(t)
        if (h === null) return false
        if (h.command === red.command) return true
        return h.files.some(f => files.has(normalisePath(f).toLowerCase()))
    })
}

/**
 * The extra scope fence a health-repair entry carries into refine. Without it
 * "repair src/a.ts" refines into "overhaul the client", and a fix child left free
 * to choose greens a linter fastest by suppressing it — which is how the red in
 * the run this closes was painted over the first time.
 */
export function buildHealthRepairFence(subject: HealthRepairSubject): string {
    const scope =
        subject.files.length > 0 ?
            [
                `  - ${subject.files.map(f => `\`${f}\``).join(', ')} ${subject.files.length > 1 ? 'are' : 'is'} the ONLY`,
                '    file(s) you may modify. Do not refactor, restructure, or "improve" anything else,',
                '    and do not create new files.'
            ]
        :   [
                '  - Modify only the files the command reports. Do not refactor, restructure, or',
                '    "improve" anything else, and do not create new files.'
            ]
    return [
        `REPAIR TASK — this step exists ONLY to make \`${subject.command}\` pass again. It`,
        'was created because that check was red before this step, and every later step',
        'would otherwise build on the red; it is not a feature step and must not grow into one.',
        '',
        'HARD CONSTRAINTS for this step (they override any broader reading of the title):',
        ...scope,
        '  - Fix the reported findings and nothing more. Do NOT redesign the build, the',
        '    lint configuration, the schema, or any shared infrastructure — a wider change',
        "    here would silently overwrite sibling tasks' shipped work.",
        '  - Do NOT suppress, disable, ignore or weaken the check to make it pass: no',
        '    disable comments, no ignore entries, no relaxed rules, no deleted or skipped',
        '    tests. A finding is fixed in the code it reports.',
        '  - Put the fix in files the repository tracks. A check made green by a file git',
        '    ignores (installed dependencies, build output, a local env file) is still',
        '    red on a fresh checkout.',
        `  - The VERIFY block MUST be exactly: \`${subject.command}\` — the check that was`,
        '    red. It passing is the whole acceptance criterion.'
    ].join('\n')
}
