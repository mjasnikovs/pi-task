/**
 * STEP 0 for nexttask 2 — what the DETERMINISTIC REASSIGNMENT lever would
 * actually do, measured over every recorded composed spec on disk, BEFORE any
 * code is wired.
 *
 * The lever (nexttask2.md): run `findOwnedFreezeConflicts` at the last
 * spec-producing step (right after `appendOwnedConstraints`) and, on a finding,
 * do one of two mechanical things — never a model rewrite:
 *
 *   1. REASSIGN — if exactly one OTHER task in the plan names the frozen path
 *      as a deliverable (its title, or its spec's research FILES list), move the
 *      owned requirement to that task's ledger entry.
 *   2. CARRY — otherwise demote it to CROSS-CUTTING so every task receives it.
 *
 * This script prints, per recorded tree and per conflict: the requirement, its
 * paths, the branch the lever would take, and the target it would pick. It also
 * prints two things nexttask2.md does not ask for but which decide whether the
 * lever can work at all in production, and which are visible only from the
 * recorded runs:
 *
 *   TARGET-SELECTION SENSITIVITY — the candidate set under three readings of
 *   "names P as a deliverable" (title-only, FILES-only, either). "Exactly one"
 *   is the branch condition, so the reading IS the rule.
 *
 *   REACHABILITY — tasks execute strictly in id order (verified: created_at is
 *   monotonic in every recorded tree), and the conflict is only detectable at
 *   the conflicting task's OWN compose time. A REASSIGN whose target has a
 *   LOWER id has already run to completion by then: moving the requirement into
 *   its ledger entry changes nothing that will ever be composed again. Such a
 *   branch is a no-op dressed as a fix, exactly the failure nexttask2.md warns
 *   about for branch 2.
 *
 *   THE CLAIM SIDE — per conflict path, which tasks assert a WRITE on it, under
 *   the two artifacts that exist at the two candidate moments: the plan TITLE
 *   (all a detach-time target rule can read) and the task's own REFINED prompt
 *   (what the claimant has at its own compose).
 *
 * ── WHAT IT MEASURED, 2026-08-05 (60 specs, 5 trees, 1 conflict) ────────────
 *
 *     branch 1 REASSIGN   0     "exactly one other task names P" never holds:
 *                               8 candidates for `src/server/index.ts`
 *     branch 2 CARRY      1     and the quote is NOT cross-cutting-shaped, so
 *                               carrying it would inflate 11 pending specs
 *     by plan TITLE       0     no plan title in run 19 contains the path — a
 *                               detach-time target rule is BLIND in production
 *     by REFINED          2     TASK_0014 (already run) and TASK_0017
 *     pending + REFINED   1     TASK_0017 — the claimant, exactly one
 *
 * That is the whole design argument for detach/claim in one table: the target
 * cannot be chosen when the conflict is found, and does not need to be — the
 * task that writes the file says so itself, later, in its own words.
 *
 * Read-only: opens recorded `.pi-tasks` files and runs `git ls-files` in the
 * trees to resolve the source oracle.
 *
 * Run: bun run scripts/owned-freeze-reassign-baserate.ts
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    findOwnedFreezeConflicts,
    trackedSourceOracle,
    type OwnedFreezeConflict
} from '../src/task/owned-freeze-conflict.js'
import {
    parseOwnedRequirements,
    ownedForTitle,
    isCrossCuttingRequirement,
    type OwnedRequirement
} from '../src/task/requirements.js'
import {writeIntent} from '../src/task/owned-freeze-reassign.js'

const HUB = path.join(os.homedir(), 'hub')

/** Every tree under ~/hub that recorded composed specs. */
function pools(): string[] {
    if (!existsSync(HUB)) return []
    return readdirSync(HUB)
        .map(d => path.join(HUB, d))
        .filter(d => existsSync(path.join(d, '.pi-tasks')))
        .sort()
}

/** The `## <name>` section of a recorded task file. */
function section(doc: string, name: string): string {
    const re = new RegExp(String.raw`^##\s+${name}\s*$`, 'im')
    const m = re.exec(doc)
    if (!m) return ''
    const rest = doc.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

function frontMatter(doc: string, key: string): string {
    const m = new RegExp(String.raw`^${key}:\s*(.*)$`, 'm').exec(doc)
    return m ? m[1].trim() : ''
}

/**
 * The research FILES block: every path token the task's research listed. This
 * is the looser half of the lever's "names P as a deliverable" — it includes
 * files the task only READS (run 19's TASK_0015 lists `tsconfig.json` and
 * `docker-compose.dev.yml`, neither of which it may touch), which is why the
 * three readings are reported separately below.
 */
function researchFiles(spec: string, doc: string): string[] {
    const research = section(doc, 'research')
    const m = /^FILES\s*$/m.exec(research)
    if (!m) return []
    const rest = research.slice(m.index + m[0].length)
    const next = /^[A-Z][A-Z -]+\s*$/m.exec(rest)
    const block = next ? rest.slice(0, next.index) : rest
    const out: string[] = []
    for (const line of block.split('\n')) {
        const tok = line.trim().split(/\s{2,}|\s+—\s+|\t/)[0]?.trim() ?? ''
        if (tok.length === 0) continue
        if (!/^[\w.@~/-]+$/.test(tok)) continue
        if (!(tok.includes('/') || /\.[A-Za-z0-9]+$/.test(tok))) continue
        out.push(tok.replace(/^\.\//, '').replace(/\/+$/, ''))
    }
    void spec
    return [...new Set(out)]
}

interface Task {
    id: string
    /** Numeric id — execution order (created_at is monotonic in it). */
    n: number
    title: string
    rawPrompt: string
    /** What the task said it would do at ITS OWN compose time — the artifact a
     *  CLAIM reads, and the one a detach-time target rule does not have. */
    refined: string
    spec: string
    files: string[]
    owned: OwnedRequirement[]
    createdAt: string
}

function loadTasks(dir: string, ledger: OwnedRequirement[]): Task[] {
    const tasksDir = path.join(dir, '.pi-tasks')
    const out: Task[] = []
    for (const file of readdirSync(tasksDir)
        .filter(f => /^TASK_\d+\.md$/.test(f))
        .sort()) {
        const doc = readFileSync(path.join(tasksDir, file), 'utf8')
        const spec = section(doc, 'spec')
        if (spec.length === 0) continue
        const raw = section(doc, 'raw prompt')
        out.push({
            id: file.replace(/\.md$/, ''),
            n: parseInt(/(\d+)/.exec(file)?.[1] ?? '0', 10),
            title: frontMatter(doc, 'title'),
            rawPrompt: raw,
            refined: section(doc, 'refined prompt'),
            spec,
            files: researchFiles(spec, doc),
            owned: ownedForTitle(ledger, raw),
            createdAt: frontMatter(doc, 'created_at')
        })
    }
    return out
}

/** The measured `isSource` oracle for a tree: git-tracked there. */
function tracked(dir: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd: dir, encoding: 'utf8'})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

const namesInText = (text: string, p: string): boolean => text.includes(p)

type Reading = 'title' | 'files' | 'either' | 'write' | 'write-pending'

function candidates(tasks: Task[], self: Task, p: string, reading: Reading): Task[] {
    return tasks.filter(t => {
        if (t.id === self.id) return false
        if (reading === 'write-pending' && t.n <= self.n) return false
        const byTitle = namesInText(t.title, p) || namesInText(t.rawPrompt, p)
        const byFiles = t.files.some(f => f === p || f.startsWith(`${p}/`))
        const byWrite = writeIntent(t.title, p) || writeIntent(t.spec.slice(0, 4000), p)
        return reading === 'title' ? byTitle
            : reading === 'files' ? byFiles
            : reading === 'either' ? byTitle || byFiles
            : byWrite
    })
}

interface Decision {
    branch: 'REASSIGN' | 'CARRY'
    target: Task | null
    reason: string
}

/**
 * The lever's branch, exactly as nexttask2.md states it: REASSIGN when EXACTLY
 * ONE other task names the path; CARRY otherwise. A conflict naming several
 * frozen paths reassigns only when all of them agree on one target — a
 * requirement cannot be owned by two tasks (`inv-single-owner`).
 */
function decide(tasks: Task[], self: Task, c: OwnedFreezeConflict, reading: Reading): Decision {
    const perPath = c.paths.map(p => ({p, cands: candidates(tasks, self, p, reading)}))
    const singles = perPath.filter(x => x.cands.length === 1)
    if (singles.length === 0) {
        const counts = perPath.map(x => `${x.p}:${x.cands.length}`).join(' ')
        return {branch: 'CARRY', target: null, reason: `no path has exactly one owner (${counts})`}
    }
    const targets = new Set(singles.map(x => x.cands[0].id))
    if (targets.size > 1) {
        return {branch: 'CARRY', target: null, reason: `paths disagree (${[...targets].join(', ')})`}
    }
    return {
        branch: 'REASSIGN',
        target: singles[0].cands[0],
        reason: `${singles.map(x => x.p).join(', ')} → sole owner`
    }
}

let totalSpecs = 0
let totalConflicts = 0
let totalReassign = 0
let totalCarry = 0
let totalUnreachable = 0
let totalCrossCuttingIneligible = 0

for (const dir of pools()) {
    const label = path.basename(dir)
    const ledgerFile = path.join(dir, '.pi-tasks', 'requirements-owned.md')
    const ledger: OwnedRequirement[] = existsSync(ledgerFile) ?
        parseOwnedRequirements(readFileSync(ledgerFile, 'utf8'))
    :   []
    const tasks = loadTasks(dir, ledger)
    if (tasks.length === 0) continue
    const isSource = tracked(dir)
    totalSpecs += tasks.length

    const rows: Array<{task: Task; c: OwnedFreezeConflict}> = []
    for (const t of tasks) {
        for (const c of findOwnedFreezeConflicts(t.spec, {owned: t.owned, isSource})) {
            rows.push({task: t, c})
        }
    }

    const monotonic = tasks.every((t, i) => i === 0 || t.createdAt >= tasks[i - 1].createdAt)
    console.log(
        `\n## ~/hub/${label} — ${tasks.length} specs, ledger ${ledger.length} entries, `
        + `${rows.length} conflict(s)${monotonic ? '' : '  [WARN: ids not in execution order]'}`
    )
    if (rows.length === 0) continue

    for (const {task, c} of rows) {
        totalConflicts++
        const primary = decide(tasks, task, c, 'either')
        if (primary.branch === 'REASSIGN') totalReassign++
        else totalCarry++
        console.log(`\n   ${task.id} — ${task.title.slice(0, 70)}`)
        console.log(`     requirement  ${c.requirement.slice(0, 160)}`)
        console.log(`     paths        ${c.paths.join(', ')}`)
        console.log(`     freeze       ${c.constraint.slice(0, 140)}`)
        console.log(`     exempts      ${c.exempt.join(', ') || '(none)'}`)
        console.log(`     BRANCH       ${primary.branch}${primary.target ? ` → ${primary.target.id}` : ''}  (${primary.reason})`)

        // Sensitivity: the branch condition is "exactly one", so the reading of
        // "names it" decides the branch. Print all three, with the candidates.
        for (const reading of ['title', 'files', 'either', 'write', 'write-pending'] as Reading[]) {
            const per = c.paths.map(p => {
                const ids = candidates(tasks, task, p, reading).map(t => t.id)
                return `${p} → [${ids.join(' ') || '-'}]`
            })
            const d = decide(tasks, task, c, reading)
            console.log(`     ${reading.padEnd(6)}      ${d.branch.padEnd(8)} ${per.join('  ')}`)
        }

        // Reachability: at the conflicting task's compose time, every LOWER id
        // has already completed. A ledger edit for such a target is never read.
        if (primary.branch === 'REASSIGN' && primary.target) {
            const reachable = primary.target.n > task.n
            if (!reachable) totalUnreachable++
            console.log(
                `     REACHABLE    ${reachable ? 'yes' : 'NO'} — target ${primary.target.id} runs `
                + `${primary.target.n > task.n ? 'after' : 'BEFORE'} ${task.id}`
            )
        }
        // THE CLAIM SIDE — what production can actually see. At detach time the
        // pending tasks are bare plan titles; by its own compose the claimant has
        // a refined prompt. Both readings are printed with their candidates, so
        // the gap between "what a target rule could know then" and "what the
        // claimant knows later" is measured rather than asserted.
        for (const p of c.paths) {
            const titleClaims = tasks.filter(
                t => t.id !== task.id && writeIntent(t.rawPrompt, p)
            )
            const refinedClaims = tasks.filter(t => t.id !== task.id && writeIntent(t.refined, p))
            const pending = refinedClaims.filter(t => t.n > task.n)
            console.log(
                `     CLAIM ${p}  by plan TITLE [${titleClaims.map(t => t.id).join(' ') || '-'}]`
                + `  by REFINED [${refinedClaims.map(t => t.id).join(' ') || '-'}]`
                + `  of those still pending [${pending.map(t => t.id).join(' ') || '-'}]`
            )
        }

        if (primary.branch === 'CARRY') {
            // Branch 2 routes through the cross-cutting channel, which
            // accountCoverage only reaches for prohibition/global-scope quotes.
            // The cross-cutting channel is keyed on the LEDGER QUOTE, not on the
            // stamped spec line (whose marker text carries a "do not" of its own).
            const quote = task.owned.find(o => c.requirement.includes(o.quote))?.quote ?? c.requirement
            const eligible = isCrossCuttingRequirement(quote)
            if (!eligible) totalCrossCuttingIneligible++
            console.log(
                `     CARRY shape  ${eligible ? 'cross-cutting-shaped' : 'NOT cross-cutting-shaped'}`
                + ' (isCrossCuttingRequirement)'
            )
            // And the same reachability question: a carry only reaches tasks
            // that have not run yet.
            const remaining = tasks.filter(t => t.n > task.n).length
            console.log(`     REACHES      ${remaining} of ${tasks.length - 1} other tasks (the ones not yet run)`)
        }
    }
}

console.log('\n## TOTALS')
console.log(`   composed specs scanned          ${totalSpecs}`)
console.log(`   conflicts                       ${totalConflicts}`)
console.log(`   branch 1 REASSIGN               ${totalReassign}`)
console.log(`   branch 2 CARRY                  ${totalCarry}`)
console.log(`   REASSIGNs to an already-run task ${totalUnreachable}  (no-ops in production)`)
console.log(`   CARRYs of a non-cross-cutting quote ${totalCrossCuttingIneligible}`)
const effective = totalReassign - totalUnreachable
console.log(
    `\n   EFFECTIVE reassignments (target still pending): ${effective} of ${totalConflicts} conflict(s)`
)
