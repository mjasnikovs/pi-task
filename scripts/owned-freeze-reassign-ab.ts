/**
 * A/B-1 (deterministic, corpus) for nexttask 2 — does the DETACH/CLAIM pass move
 * the owned requirement to a task that can satisfy it, WITHOUT losing a single
 * quote and without creating a conflict anywhere else?
 *
 *     baseline    the ledger and specs exactly as the runs produced them
 *     treatment   the ledger after the pass, with every spec re-braced from it
 *
 * The pass is threaded over each tree in execution order, exactly as production
 * runs it:
 *
 *     for each task, in id order:
 *       CLAIM    from this task's own recorded REFINED prompt, any requirement an
 *                earlier task detached whose frozen path this task writes
 *       compose  spec = appendOwnedConstraints(pre-braces spec, my owned entries)
 *       DETACH   any owned requirement this spec's own category freeze makes
 *                unsatisfiable → marked pending, its stamped bullet removed
 *
 * `pre-braces(t)` is the recorded spec with every machine-stamped owned bullet
 * removed — what compose+critique produced before the braces ran. The baseline
 * reconstruction is asserted against the recorded spec (same set of stamped
 * bullets) before anything is scored: if the simulation cannot rebuild what the
 * run shipped, its treatment arm means nothing.
 *
 * WHY THE CLAIM READS THE REFINED PROMPT. At detach time the later tasks are
 * bare plan titles and none of run 19's 26 contains `src/server/index.ts`, so a
 * target rule that runs at detach time is blind in production. By its own
 * compose the claimant has a refined prompt that names the file and says it will
 * write it. This harness therefore uses each task's RECORDED refined prompt —
 * the same artifact production has at that moment, nothing later.
 *
 * PASS  the run-19 conflict is gone, the clause is present verbatim and still
 *       marked AUTHORITATIVE on the task that writes `src/server/index.ts`, and
 *       all five invariants hold.                                        exit 0
 * FAIL  a quote is lost, a conflict survives or appears, or an invariant
 *       breaks.                                                          exit 1
 * ABSTAIN  the recorded specs are unavailable.                           exit 2
 *
 * Run: bun run scripts/owned-freeze-reassign-ab.ts
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import {findOwnedFreezeConflicts, trackedSourceOracle} from '../src/task/owned-freeze-conflict.js'
import {
    detachUnsatisfiableRequirements,
    claimPendingRequirements,
    unclaimedPendingRequirements,
    type ReassignAction
} from '../src/task/owned-freeze-reassign.js'
import {
    appendOwnedConstraints,
    ownedForTitle,
    parseOwnedRequirements,
    type OwnedRequirement
} from '../src/task/requirements.js'
import {readSection} from './ab-corpus.js'

const HUB = path.join(os.homedir(), 'hub')
const STAMP_RE = /owned\s+requirement\s+from\s+the\s+source\s+design/i

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

interface Rec {
    id: string
    order: number
    /** The plan title — the ledger's join key (the stored `raw prompt`). */
    title: string
    /** What the task said it would do, at ITS OWN compose time. */
    refined: string
    /** The recorded spec, verbatim. */
    recorded: string
    /** The recorded spec minus every machine-stamped owned bullet. */
    preBraces: string
}

function stampedLines(spec: string): string[] {
    return spec.split('\n').filter(l => STAMP_RE.test(l))
}

function loadTree(dir: string): {recs: Rec[]; ledger: OwnedRequirement[]} | null {
    const tasksDir = path.join(dir, '.pi-tasks')
    if (!existsSync(tasksDir)) return null
    const ledgerFile = path.join(tasksDir, 'requirements-owned.md')
    const ledger = existsSync(ledgerFile) ?
        parseOwnedRequirements(readFileSync(ledgerFile, 'utf8'))
    :   []
    const recs: Rec[] = []
    for (const file of readdirSync(tasksDir)
        .filter(f => /^TASK_\d+\.md$/.test(f))
        .sort()) {
        const doc = readFileSync(path.join(tasksDir, file), 'utf8')
        const spec = section(doc, 'spec')
        if (spec.length === 0) continue
        recs.push({
            id: file.replace(/\.md$/, ''),
            order: parseInt(/(\d+)/.exec(file)?.[1] ?? '0', 10),
            title: section(doc, 'raw prompt'),
            refined: section(doc, 'refined prompt'),
            recorded: spec,
            preBraces: spec
                .split('\n')
                .filter(l => !STAMP_RE.test(l))
                .join('\n')
        })
    }
    return recs.length === 0 ? null : {recs, ledger}
}

function tracked(dir: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd: dir, encoding: 'utf8'})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

/** Re-brace every spec from a ledger — the arm's delivered specs. */
function compose(recs: Rec[], ledger: OwnedRequirement[]): Map<string, string> {
    const out = new Map<string, string>()
    for (const r of recs) {
        out.set(r.id, appendOwnedConstraints(r.preBraces, ownedForTitle(ledger, r.title)))
    }
    return out
}

interface ConflictKey {
    id: string
    quote: string
    paths: string
}

function conflictsOf(
    recs: Rec[],
    specs: Map<string, string>,
    ledger: OwnedRequirement[],
    isSource: (p: string) => boolean
): ConflictKey[] {
    const out: ConflictKey[] = []
    for (const r of recs) {
        for (const c of findOwnedFreezeConflicts(specs.get(r.id) ?? '', {
            owned: ownedForTitle(ledger, r.title),
            isSource
        })) {
            out.push({id: r.id, quote: c.requirement.trim(), paths: c.paths.join(',')})
        }
    }
    return out
}

const bag = (xs: string[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
    return m
}

function sameBag(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (b.get(k) !== v) return false
    return true
}

interface Pass {
    ledger: OwnedRequirement[]
    specs: Map<string, string>
    actions: ReassignAction[]
}

/** The pass, threaded over the tree in execution order. */
function runPass(
    recs: Rec[],
    ledger: OwnedRequirement[],
    isSource: (p: string) => boolean
): Pass {
    let cur = ledger.map(o => ({...o}))
    const actions: ReassignAction[] = []
    const specs = new Map<string, string>()
    for (const r of recs) {
        const claimed = claimPendingRequirements({intent: r.refined, title: r.title, ledger: cur})
        cur = claimed.ledger
        actions.push(...claimed.actions)
        const spec = appendOwnedConstraints(r.preBraces, ownedForTitle(cur, r.title))
        const detached = detachUnsatisfiableRequirements({
            spec,
            title: r.title,
            ledger: cur,
            isSource
        })
        cur = detached.ledger
        actions.push(...detached.actions)
        specs.set(r.id, detached.spec)
    }
    return {ledger: cur, specs, actions}
}

interface TreeVerdict {
    label: string
    conflictsBefore: number
    conflictsAfter: number
    actions: ReassignAction[]
    unclaimed: OwnedRequirement[]
    failures: string[]
    changedSpecs: string[]
}

function runTree(dir: string): TreeVerdict | null {
    const loaded = loadTree(dir)
    if (!loaded) return null
    const {recs, ledger} = loaded
    const isSource = tracked(dir)
    const failures: string[] = []

    const baseSpecs = compose(recs, ledger)
    // Fidelity: the reconstruction must carry the same stamped bullets the run
    // shipped. (Order inside CONSTRAINTS may differ; the SET may not.)
    for (const r of recs) {
        const got = bag(stampedLines(baseSpecs.get(r.id) ?? '').map(l => l.trim()))
        const want = bag(stampedLines(r.recorded).map(l => l.trim()))
        if (!sameBag(got, want)) failures.push(`reconstruction mismatch on ${r.id}`)
    }
    const before = conflictsOf(recs, baseSpecs, ledger, isSource)

    const pass = runPass(recs, ledger, isSource)
    const after = conflictsOf(recs, pass.specs, pass.ledger, isSource)

    // ── invariants ──────────────────────────────────────────────────────────
    // inv-no-requirement-loss — quote multiset over the ledger, on text.
    if (!sameBag(bag(ledger.map(o => o.quote)), bag(pass.ledger.map(o => o.quote)))) {
        failures.push('inv-no-requirement-loss: quote multiset changed')
    }
    // …and no quote was silently edited.
    for (const o of pass.ledger) {
        if (!ledger.some(b => b.quote === o.quote)) {
            failures.push(`inv-no-requirement-loss: quote altered — "${o.quote.slice(0, 60)}"`)
        }
    }

    // inv-no-new-conflict — every treatment conflict was already in baseline.
    const beforeKeys = new Set(before.map(c => `${c.quote}|${c.paths}`))
    for (const c of after) {
        if (!beforeKeys.has(`${c.quote}|${c.paths}`)) {
            failures.push(`inv-no-new-conflict: ${c.id} — "${c.quote.slice(0, 70)}"`)
        }
    }

    // inv-single-owner — no quote owned by two titles, and nothing both owned
    // and pending.
    const owners = new Map<string, Set<string>>()
    for (const o of pass.ledger) {
        if ((o.pending ?? []).length > 0) continue
        owners.set(o.quote, (owners.get(o.quote) ?? new Set<string>()).add(o.title.trim()))
    }
    for (const [q, s] of owners) {
        if (s.size > 1) failures.push(`inv-single-owner: "${q.slice(0, 60)}" owned by ${s.size} tasks`)
    }

    // inv-idempotent — a second pass over the treatment result changes nothing.
    const again = runPass(
        recs.map(r => ({...r, preBraces: pass.specs.get(r.id) ?? r.preBraces})),
        pass.ledger,
        isSource
    )
    if (again.actions.length > 0) {
        failures.push(`inv-idempotent: ${again.actions.length} action(s) on the second pass`)
    }
    for (const r of recs) {
        if ((again.specs.get(r.id) ?? '') !== (pass.specs.get(r.id) ?? '')) {
            failures.push(`inv-idempotent: ${r.id} spec changed on the second pass`)
        }
    }

    // inv-noop-when-clean — only tasks that lost or gained a requirement differ.
    const touched = new Set<string>()
    for (const a of pass.actions) {
        if (a.kind === 'unresolved') continue
        const title = a.kind === 'claim' ? a.by : a.from
        const t = recs.find(r => r.title.trim() === title.trim())
        if (t) touched.add(t.id)
    }
    const changedSpecs = recs
        .filter(r => (pass.specs.get(r.id) ?? '') !== (baseSpecs.get(r.id) ?? ''))
        .map(r => r.id)
    for (const id of changedSpecs) {
        if (!touched.has(id)) failures.push(`inv-noop-when-clean: ${id} changed with no action`)
    }

    return {
        label: path.basename(dir),
        conflictsBefore: before.length,
        conflictsAfter: after.length,
        actions: pass.actions,
        unclaimed: unclaimedPendingRequirements(pass.ledger),
        failures,
        changedSpecs
    }
}

// ── the pre-registered run-19 expectation ───────────────────────────────────
const EXPECT = {
    tree: 'mx5',
    from: 'TASK_0015',
    /** nexttask2.md nominates TASK_0014; STEP 0 shows it has already RUN when the
     *  conflict becomes detectable, and that no plan TITLE names the path at all.
     *  TASK_0017 claims it from its own refined prompt. */
    to: 'TASK_0017',
    quoteFragment: 'serves `/api` + static `dist/`'
}

if (!existsSync(HUB)) {
    console.log('ABSTAIN — no ~/hub trees on disk')
    process.exit(2)
}

const trees = readdirSync(HUB)
    .map(d => path.join(HUB, d))
    .filter(d => existsSync(path.join(d, '.pi-tasks')))
    .sort()

const verdicts: TreeVerdict[] = []
for (const dir of trees) {
    const v = runTree(dir)
    if (v) verdicts.push(v)
}
if (verdicts.length === 0) {
    console.log('ABSTAIN — no recorded specs')
    process.exit(2)
}

let failed = false
for (const v of verdicts) {
    console.log(`\n## ${v.label}`)
    console.log(`   conflicts baseline → treatment   ${v.conflictsBefore} → ${v.conflictsAfter}`)
    console.log(`   specs changed                    ${v.changedSpecs.join(', ') || '(none)'}`)
    for (const a of v.actions) {
        console.log(
            `   ${a.kind.toUpperCase().padEnd(10)} "${a.quote.slice(0, 55)}…"`
            + (a.kind === 'claim' ? ` ← ${a.by.slice(0, 40)}`
              : a.kind === 'unresolved' ? ` — ${a.reason}`
              : ` (frozen ${a.paths.join(', ')})`)
        )
    }
    for (const o of v.unclaimed) {
        console.log(`   UNCLAIMED  "${o.quote.slice(0, 55)}…" — pending ${(o.pending ?? []).join(', ')}`)
    }
    if (v.conflictsAfter > v.conflictsBefore) v.failures.push('conflicts increased')
    for (const f of v.failures) console.log(`   FAIL ${f}`)
    if (v.failures.length > 0) failed = true
}

// The delivered-clause check on the nominated pair.
const mx5 = trees.find(d => path.basename(d) === EXPECT.tree)
if (mx5) {
    const loaded = loadTree(mx5)!
    const isSource = tracked(mx5)
    const pass = runPass(loaded.recs, loaded.ledger, isSource)
    console.log('\n## run-19 pre-registered expectation')

    const claim = pass.actions.find(a => a.kind === 'claim' && a.quote.includes(EXPECT.quoteFragment))
    const target = loaded.recs.find(r => r.id === EXPECT.to)!
    if (!claim) {
        console.log('   FAIL the §9 Build & run clause was never claimed')
        failed = true
    } else if (claim.kind === 'claim' && claim.by.trim() !== target.title.trim()) {
        console.log(`   FAIL claimed by "${claim.by.slice(0, 70)}", expected ${EXPECT.to}`)
        failed = true
    }
    const targetSpec = pass.specs.get(EXPECT.to) ?? ''
    const line = targetSpec.split('\n').find(l => l.includes(EXPECT.quoteFragment))
    const ok = line !== undefined && /AUTHORITATIVE/.test(line)
    console.log(`   ${ok ? 'OK  ' : 'FAIL'} clause on ${EXPECT.to}: ${line?.trim().slice(0, 110) ?? '(absent)'}`)
    if (!ok) failed = true
    const gone = !(pass.specs.get(EXPECT.from) ?? '').includes(EXPECT.quoteFragment)
    console.log(`   ${gone ? 'OK  ' : 'FAIL'} clause no longer stamped on ${EXPECT.from}`)
    if (!gone) failed = true
}

console.log(`\n## VERDICT ${failed ? 'FAIL' : 'PASS'}`)
process.exit(failed ? 1 : 0)
