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
import {failClassOfReason, isHealthClass} from './verify-work.js'

/** A path-like token: at least one directory separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@-]+[\\/])+[\w.@-]+\.\w+/g

/** The failing check, and what its output named. */
export interface HealthRed {
    command: string
    exitCode: number | null
    kind?: HealthCommandResult['kind']
    /** Set when the suite found no tests rather than failed one. */
    gap?: HealthCommandResult['gap']
    /** The runner's failure summary, when it overruled an exit 0. */
    report?: string
    /** Repo-relative tracked paths the output named, in first-seen order. */
    files: string[]
}

export interface HealthRedOwners {
    /** Task ids whose commits introduced the named files; empty when nothing in
     *  the run owns them (a leftover, or a red the run started on). */
    owners: string[]
    /** The latest task accepted with this red (see owingTask). It keeps a second
     *  repair of the same files apart from the first, failed one. */
    regressedBy?: string | null
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
    mayRepair: (red: HealthRed) => boolean = () => true
): HealthRed[] {
    return (health.commands ?? [])
        .filter(isHealthRed)
        .map((failing): HealthRed => {
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
                ...(failing.kind === undefined ? {} : {kind: failing.kind}),
                ...(failing.gap === undefined ? {} : {gap: failing.gap}),
                ...(failing.report === undefined ? {} : {report: failing.report})
            }
        })
        .filter(mayRepair)
}

/** The first of {@link healthReds}, or null. */
export function healthRedSubject(
    health: HealthSignal & {output?: string},
    cwd: string,
    tracked: readonly string[] | null,
    mayRepair?: (red: HealthRed) => boolean
): HealthRed | null {
    return healthReds(health, cwd, tracked, mayRepair)[0] ?? null
}

type OpenDebt = {taskId?: string; reason: string; origin?: string}

/** Origins recording a red the task found rather than made. */
const FOUND_NOT_MADE: ReadonlySet<string> = new Set(['inherited-health', 'root-cause'])

/**
 * The open debts that record a task's own regression of this red: a health-class
 * FAIL saying the same of the command. A failing suite and one that found no tests
 * are different reds, and a debt that only quotes the command, an abandoned entry's
 * title say, is neither.
 */
function regressionsOf(red: HealthRed, openDebts: readonly OpenDebt[]): OpenDebt[] {
    const said =
        red.gap === undefined ? `\`${red.command}\` exited` : `\`${red.command}\` found no tests`
    return openDebts.filter(
        d =>
            !FOUND_NOT_MADE.has(d.origin ?? '')
            && isHealthClass(failClassOfReason(d.reason))
            && d.reason.includes(said)
    )
}

/**
 * May the checkpoint repair this red? A test command only when a task's regression
 * of it is owed: a suite can be red because a database is not up here, and a suite
 * that found no tests in part of itself is owed only by the task that lost that part.
 */
export function checkpointMayRepair(red: HealthRed, openDebts: readonly OpenDebt[]): boolean {
    return red.kind !== 'test' || regressionsOf(red, openDebts).length > 0
}

/** The latest task whose regression of this red is still open, or null. */
export function owingTask(red: HealthRed, openDebts: readonly OpenDebt[]): string | null {
    const owing = regressionsOf(red, openDebts)
        .map(d => d.taskId ?? '')
        .filter(id => TASK_ID_RE.test(id))
    return owing.sort((a, b) => taskOrdinal(a) - taskOrdinal(b)).at(-1) ?? null
}

/** An inner task id. An auto run's own id counts in a different sequence. */
const TASK_ID_RE = /^TASK_\d+$/

function taskOrdinal(id: string): number {
    return Number(id.slice('TASK_'.length))
}

// ─── Plan entry ──────────────────────────────────────────────────────────────

/**
 * The plan title, in one of two fixed shapes the parser below recovers:
 *   `repair src/a.ts, src/b.ts: \`bun run lint\` exits 1 (introduced by TASK_0033; regressed by TASK_0040)`
 *   `repair \`bun run lint\`: exits 1 (no task in this run owns it)`
 * The subject sits right after the prefix so it is both the dedup key and what
 * the scope fence pins.
 */
export function buildHealthRepairTitle(red: HealthRed & HealthRedOwners): string {
    const exits = `exits ${red.exitCode ?? '?'}${reportedSuffix(red)}`
    const said = [
        ...(red.owners.length > 0 ? [`introduced by ${red.owners.join(', ')}`] : []),
        ...(red.regressedBy && !red.owners.includes(red.regressedBy) ?
            [`regressed by ${red.regressedBy}`]
        :   [])
    ]
    const owner = said.length > 0 ? said.join('; ') : 'no task in this run owns it'
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
 *
 * `owedBy` is the latest task that regressed this check. The plan runs in order, so
 * an entry above the one that produced it ran, or was abandoned, before this red.
 */
export function planCoversHealthRed(
    entries: readonly PlanEntryRef[],
    red: HealthRed,
    repaired: ReadonlySet<string> = new Set(),
    owedBy: string | null = null
): boolean {
    const files = new Set(red.files.map(f => normalisePath(f).toLowerCase()))
    const owedAt = owedBy === null ? -1 : entries.findIndex(e => e.producedId === owedBy)
    return entries.some(({title: t, producedId}, at) => {
        if (producedId !== undefined && repaired.has(producedId)) return false
        if (at < owedAt) return false
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
        '  - Put the fix in files the repository tracks. Do not write or edit a file git',
        '    ignores (installed dependencies, build output, a local env file) by hand: a',
        '    fresh checkout does not have it.',
        "    Running the project's own install or build is allowed.",
        `  - The VERIFY block MUST be exactly: \`${subject.command}\` — the check that was`,
        '    red. It passing is the whole acceptance criterion.'
    ].join('\n')
}
