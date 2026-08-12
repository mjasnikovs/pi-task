/**
 * STEP 0 for nexttask 7 — the BASE RATE of the shape "an AUTHORITATIVE owned
 * requirement names a file that the same spec's CATEGORY freeze forbids
 * touching", measured over every composed spec on disk BEFORE anything is
 * wired.
 *
 * Methodology rule this satisfies: measure the base rate BEFORE changing code,
 * and never argue generality from the pool the rule was designed on
 * (VALIDATION-DEBT.md rules 2 and 3). The rule was designed while looking at mx5
 * run 18's TASK_0023, so mx5 is the DESIGN pool and cannot support generality.
 * gofer-pixel is an INDEPENDENT pool: a different project, a different design
 * doc, the same owned-requirement channel and the same category-freeze habit.
 *
 * The four counts nexttask 7 asks for, per pool:
 *
 *     N   specs carrying >= 1 owned requirement
 *     n1  of those, specs with a CATEGORY freeze
 *     n2  of those, an owned requirement names a path inside it   <- the target
 *     n3  of those, the requirement was actually MET in HEAD
 *
 * n2 is reported under BOTH readings, because the difference is the whole
 * precision question:
 *
 *   broad     every path-shaped token an owned requirement names
 *   source    only tokens git TRACKS in the tree — a requirement naming a file
 *             the task is about to create is not blocked by a freeze on the
 *             files already there, and route literals (`/api`) and build
 *             outputs (`dist/`, `dist/app.css`) drop out for free
 *
 * n3 cannot be computed from text: "was the behaviour actually shipped" is a
 * property of HEAD, not of the spec. Each pair therefore carries a hand-checked
 * verdict with its evidence recorded inline below (MET_VERDICTS); anything not
 * listed reports `unknown` rather than being silently counted as met.
 *
 * Read-only: it opens recorded `.pi-tasks` files and stats source trees.
 *
 * Run: bun run scripts/owned-vs-freeze-baserate.ts
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import {
    findCategoryFreezes,
    findOwnedFreezeConflicts,
    ownedRequirementLines,
    trackedSourceOracle,
    type OwnedFreezeConflict
} from '../src/task/owned-freeze-conflict.js'
import {parseOwnedRequirements, ownedForTitle, type OwnedRequirement} from '../src/task/requirements.js'
import {readSection} from './ab-corpus.js'

const HUB = path.join(os.homedir(), 'hub')

interface Pool {
    label: string
    dir: string
    /** DESIGN = the rule was written while looking at it, so it can only
     *  demonstrate the shape, never its generality. */
    role: 'design' | 'independent'
    note: string
}

const POOLS: Pool[] = [
    {
        label: 'mx5 run 18',
        dir: path.join(HUB, 'mx5'),
        role: 'design',
        note: 'the incident tree — TASK_0023 is the known member'
    },
    {
        label: 'gofer-pixel',
        dir: path.join(HUB, 'gofer-pixel'),
        role: 'independent',
        note: 'different project, different design doc, same owned channel'
    },
    // Trees that ran /task-auto without the owned channel: they contribute the
    // zero-owned-requirement denominator, so N is not silently flattering.
    {label: 'IAR1', dir: path.join(HUB, 'IAR1'), role: 'independent', note: 'no owned ledger'},
    {label: 'runner', dir: path.join(HUB, 'runner'), role: 'independent', note: 'no owned ledger'},
    {label: 'aiz-client', dir: path.join(HUB, 'aiz-client'), role: 'independent', note: 'no owned ledger'}
]

/**
 * Hand-checked "was it MET in HEAD" verdicts, keyed `<pool>/<task> <path>`.
 * Each carries the evidence that settles it — no verdict is asserted here that
 * was not read out of the tree.
 */
const MET_VERDICTS: Record<string, {met: boolean; evidence: string}> = {
    'mx5 run 18/TASK_0023 src/server/index.ts': {
        met: false,
        evidence:
            'nexttask 2: `bun run src/server/index.ts` exits 0 with no listener and no static '
            + 'route; the clause "serves `/api` + static `dist/`" is unimplemented at HEAD'
    }
}

/** The measured `isSource` oracle for a pool: git-tracked in that tree. */
const oracles = new Map<string, (p: string) => boolean>()
function tracked(dir: string): (p: string) => boolean {
    const hit = oracles.get(dir)
    if (hit) return hit
    // `git ls-files -- <p>` exits 0 and prints nothing for an untracked path, and
    // fails outright only when git or the repo is missing — the two cases the
    // oracle must tell apart.
    const o = trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd: dir, encoding: 'utf8'})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
    oracles.set(dir, o)
    return o
}

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

interface SpecRow {
    pool: string
    taskId: string
    ownedCount: number
    freezes: number
    conflictsBroad: OwnedFreezeConflict[]
    conflictsExisting: OwnedFreezeConflict[]
}

function scanPool(pool: Pool): SpecRow[] {
    const tasksDir = path.join(pool.dir, '.pi-tasks')
    if (!existsSync(tasksDir)) return []
    const ledgerFile = path.join(tasksDir, 'requirements-owned.md')
    const ledger: OwnedRequirement[] = existsSync(ledgerFile) ?
        parseOwnedRequirements(readFileSync(ledgerFile, 'utf8'))
    :   []
    const rows: SpecRow[] = []
    for (const file of readdirSync(tasksDir).filter(f => /^TASK_\d+\.md$/.test(f)).sort()) {
        const doc = readFileSync(path.join(tasksDir, file), 'utf8')
        const spec = section(doc, 'spec')
        if (spec.length === 0) continue
        const title = section(doc, 'raw prompt')
        const owned = ownedForTitle(ledger, title)
        const opts = {owned}
        rows.push({
            pool: pool.label,
            taskId: file.replace(/\.md$/, ''),
            ownedCount: ownedRequirementLines(spec, owned).length,
            freezes: findCategoryFreezes(spec).length,
            conflictsBroad: findOwnedFreezeConflicts(spec, opts),
            conflictsExisting: findOwnedFreezeConflicts(spec, {...opts, isSource: tracked(pool.dir)})
        })
    }
    return rows
}

function metVerdict(pool: string, taskId: string, p: string): {met: boolean | null; evidence: string} {
    const v = MET_VERDICTS[`${pool}/${taskId} ${p}`]
    return v ? {met: v.met, evidence: v.evidence} : {met: null, evidence: 'not hand-checked'}
}

let totalTargets = 0
let totalIndependentTargets = 0

for (const pool of POOLS) {
    const rows = scanPool(pool)
    if (rows.length === 0) {
        console.log(`\n## ${pool.label} — no recorded specs (${pool.dir})`)
        continue
    }
    const withOwned = rows.filter(r => r.ownedCount > 0)
    const n1 = withOwned.filter(r => r.freezes > 0)
    const n2broad = n1.filter(r => r.conflictsBroad.length > 0)
    const n2exist = n1.filter(r => r.conflictsExisting.length > 0)

    console.log(`\n## ${pool.label} (${pool.role}) — ${pool.note}`)
    console.log(`   specs                                     ${rows.length}`)
    console.log(`   N  with >= 1 owned requirement            ${withOwned.length}`)
    console.log(`   n1 of those, with a CATEGORY freeze       ${n1.length}`)
    console.log(`   n2 of those, owned path inside the freeze ${n2exist.length}   (broad reading: ${n2broad.length})`)

    let n3met = 0
    let n3unknown = 0
    for (const r of n2exist) {
        console.log(`\n   ${r.taskId} — ${r.conflictsExisting.length} pair(s)`)
        for (const c of r.conflictsExisting) {
            const verdicts = c.paths.map(p => metVerdict(pool.label, r.taskId, p))
            if (verdicts.some(v => v.met === true)) n3met++
            if (verdicts.every(v => v.met === null)) n3unknown++
            console.log(`     paths       ${c.paths.join(', ')}`)
            console.log(`     requirement ${c.requirement.slice(0, 150)}`)
            console.log(`     freeze      ${c.constraint.slice(0, 150)}`)
            console.log(`     exempts     ${c.exempt.join(', ') || '(none)'}`)
            for (const [i, v] of verdicts.entries()) {
                console.log(
                    `     met in HEAD ${c.paths[i]}: `
                    + `${v.met === null ? 'UNKNOWN' : v.met ? 'YES' : 'NO'} — ${v.evidence}`
                )
            }
        }
    }
    console.log(`\n   n3 requirement met in HEAD               ${n3met} met, ${n3unknown} unknown`)

    // What the broad reading adds, listed so the precision cost of dropping the
    // source oracle is visible rather than asserted.
    const broadOnly = rows.flatMap(r =>
        r.conflictsBroad.flatMap(c => {
            const kept = r.conflictsExisting.find(e => e.requirement === c.requirement)
            return c.paths.filter(p => !kept?.paths.includes(p)).map(p => `${r.taskId}:${p}`)
        })
    )
    console.log(`   broad-only paths (not tracked sources)   ${broadOnly.length}`)
    if (broadOnly.length > 0) console.log(`     ${broadOnly.join('  ')}`)

    totalTargets += n2exist.length
    if (pool.role === 'independent') totalIndependentTargets += n2exist.length
}

console.log('\n## VERDICT')
console.log(`   target-shape specs, all pools        ${totalTargets}`)
console.log(`   of which INDEPENDENT of the design   ${totalIndependentTargets}`)
if (totalTargets <= 1) {
    console.log(
        '   n2 <= 1: the rule is designed on a single instance and its generality is UNPROVEN.\n'
        + '   Per VALIDATION-DEBT.md rule 2, mx5 cannot argue it. Say so in the record.'
    )
} else if (totalIndependentTargets === 0) {
    console.log(
        '   every target is in the DESIGN pool: the shape is real but its generality rests\n'
        + '   entirely on mx5. Report it as such — do not claim a cross-project class.'
    )
} else {
    console.log('   the shape occurs outside the pool it was designed on.')
}
