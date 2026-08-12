/**
 * STEP 0 for nexttask 7 — how often a grill AUTO-answer NARROWS a set the source
 * design enumerates, measured over every recorded run BEFORE any veto exists.
 *
 * Methodology rule this satisfies: measure the base rate BEFORE changing code
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md). nexttask 7 makes the
 * viability call explicit — "the `not-a-set` and `undecidable` counts decide
 * whether this task is viable. If set-selection questions are rare, the guard's
 * blast radius is tiny and the task should be closed as low-value — say so with
 * the numbers, do not build it anyway."
 *
 * Every `(auto)` answer in the corpus is classified by `scripts/answer-narrowing.ts`
 * — the veto's classifier, written to be wired into `phaseAutoAnswer` and left in
 * `scripts/` because STEP 0 REFUTED the lever and nothing wires it:
 *
 *     narrowing      the answer selects a strict subset of a set ONE design line
 *                    enumerates verbatim
 *     widening       the answer selects the whole enumerated set
 *     not-a-set      the question is not a two-option set selection
 *     undecidable    it is, but no design line enumerates the union under the
 *                    question's own subject
 *
 * CORPUS. Every `<tree>/.pi-tasks/TASK_*.md` under ~/hub, ~/tmp and ~/.cache, plus
 * — for trees that TRACK `.pi-tasks/` (mx5 does) — every historical version of
 * those files in git, each paired with the design document AS IT WAS at that
 * commit. That is what recovers runs 18 and 17: the live directory only ever
 * holds the newest run. History is read with `git show <rev>:<path>`, never by
 * checking anything out over a worktree (memory/open-debt-lifecycle-6a.md — a
 * replay that checked a tag out rewrote mx5's live ledger; memory/
 * never-git-stash-concurrent-sessions.md).
 *
 * The corpus is A/B-replicated: ~5.7k task files carry only ~220 DISTINCT
 * (question, answer) pairs, because trial directories replay one task dozens of
 * times. Both denominators are reported. DISTINCT is the honest one for blast
 * radius; INSTANCES is what a production run actually meets.
 *
 * The design document is resolved per task file from the `## raw prompt` section's
 * `@`-mention (`spec: @DESIGN/PROJECT.md`) — the same mention `readReferencedDocs`
 * resolves at grill time, so grounding here sees exactly what the wired veto would.
 *
 * Read-only over the corpus: nothing is checked out, no tree is written to.
 *
 * Run: bun run scripts/autoanswer-narrowing-baserate.ts
 *      bun run scripts/autoanswer-narrowing-baserate.ts --dump   (every classified
 *          pair, not just the narrowings — for the hand-read the task demands)
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    classifyAnswerNarrowing,
    type NarrowingClass,
    type NarrowingResult
} from './answer-narrowing.js'
import {readSection} from './ab-corpus.js'

const HOME = os.homedir()
const DUMP = process.argv.includes('--dump')
const SEARCH_ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]

// ─── corpus discovery ────────────────────────────────────────────────────────

interface TaskDoc {
    /** Where it came from, for the report. */
    label: string
    /** Project root — the parent of `.pi-tasks`. Design @-mentions resolve here. */
    root: string
    /** `git show` revision, when this doc is a historical blob. */
    rev: string | null
    text: string
}

function findTaskDirs(root: string, depth = 0, out: string[] = []): string[] {
    if (depth > 4) return out
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(root, {withFileTypes: true})
    } catch {
        return out
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name === 'node_modules' || e.name === '.git') continue
        const dir = path.join(root, e.name)
        if (e.name === '.pi-tasks') {
            out.push(dir)
            continue
        }
        findTaskDirs(dir, depth + 1, out)
    }
    return out
}

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // A prose @-mention is not a path; `git show` says so loudly and the caller
        // already treats the throw as "unresolved".
        stdio: ['ignore', 'pipe', 'ignore']
    })
}

/** Historical `.pi-tasks/TASK_*.md` blobs, for trees that track them. */
function historicalDocs(root: string): TaskDoc[] {
    const out: TaskDoc[] = []
    let tracked: string[]
    try {
        tracked = git(root, ['ls-files', '.pi-tasks'])
            .split('\n')
            .filter(p => /TASK_\d+\.md$/.test(p))
    } catch {
        return out
    }
    if (tracked.length === 0) return out
    let revs: string[]
    try {
        revs = git(root, ['log', '--format=%H', '--', '.pi-tasks']).split('\n').filter(Boolean)
    } catch {
        return out
    }
    for (const rev of revs) {
        let files: string[]
        try {
            files = git(root, ['ls-tree', '-r', '--name-only', rev, '.pi-tasks'])
                .split('\n')
                .filter(p => /TASK_\d+\.md$/.test(p))
        } catch {
            continue
        }
        for (const f of files) {
            let text: string
            try {
                text = git(root, ['show', `${rev}:${f}`])
            } catch {
                continue
            }
            out.push({label: `${path.basename(root)}@${rev.slice(0, 7)}:${f}`, root, rev, text})
        }
    }
    return out
}

function collect(): TaskDoc[] {
    const docs: TaskDoc[] = []
    const roots = new Set<string>()
    for (const searchRoot of SEARCH_ROOTS) {
        for (const dir of findTaskDirs(searchRoot)) {
            const root = path.dirname(dir)
            roots.add(root)
            let names: string[]
            try {
                names = fs.readdirSync(dir).filter(n => /^TASK_\d+\.md$/.test(n))
            } catch {
                continue
            }
            for (const n of names) {
                try {
                    docs.push({
                        label: path.join(dir, n).replace(HOME, '~'),
                        root,
                        rev: null,
                        text: fs.readFileSync(path.join(dir, n), 'utf8')
                    })
                } catch {
                    // unreadable — skip
                }
            }
        }
    }
    for (const root of roots) docs.push(...historicalDocs(root))
    return docs
}

// ─── task-file parsing ───────────────────────────────────────────────────────

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

interface Pair {
    q: string
    a: string
    tag: 'auto' | 'yolo' | 'human'
}

function grillPairs(text: string): Pair[] {
    const out: Pair[] = []
    let q: string | null = null
    for (const line of section(text, 'grill Q&A').split('\n')) {
        const mq = /^Q\d+:\s*(.+)$/.exec(line)
        if (mq) {
            q = mq[1].trim()
            continue
        }
        const ma = /^A\d+:\s*(.+)$/.exec(line)
        if (ma && q !== null) {
            const a = ma[1].trim()
            out.push({
                q,
                a,
                tag: /\(auto\)$/.test(a) ? 'auto' : /\(YOLO[^)]*\)$/i.test(a) ? 'yolo' : 'human'
            })
            q = null
        }
    }
    return out
}

const MENTION_RE = /(?:^|\s)@([^\s]+)/g
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/** The design doc this task cites, read the way readReferencedDocs reads it. */
function designFor(doc: TaskDoc, cache: Map<string, string>): {text: string; ref: string} {
    const raw = section(doc.text, 'raw prompt') + '\n' + section(doc.text, 'refined prompt')
    for (const m of raw.matchAll(MENTION_RE)) {
        const rel = m[1].replace(MENTION_TRAILING_PUNCT, '')
        if (rel === '') continue
        const key = `${doc.root} ${doc.rev ?? ''} ${rel}`
        const hit = cache.get(key)
        if (hit !== undefined) {
            // '' is the cached "this mention is not a readable file" — keep looking.
            if (hit !== '') return {text: hit, ref: rel}
            continue
        }
        let text: string
        try {
            text =
                doc.rev === null ?
                    fs.readFileSync(path.resolve(doc.root, rel), 'utf8')
                :   git(doc.root, ['show', `${doc.rev}:${rel}`])
        } catch {
            text = ''
        }
        cache.set(key, text)
        if (text !== '') return {text, ref: rel}
    }
    return {text: '', ref: '(none)'}
}

// ─── measurement ─────────────────────────────────────────────────────────────

interface Row {
    label: string
    designRef: string
    pair: Pair
    result: NarrowingResult
    /** Does any OTHER task in the same run mention the question's subject? The
     *  discriminator nexttask 7 names for a CORRECT narrowing: "an enumerated set
     *  in the design that no task owns". Reported, never a fire condition here. */
    subjectOwnedElsewhere: boolean | null
}

const rows: Row[] = []
const docs = collect()
const designCache = new Map<string, string>()

// Task titles per run, for the subject-ownership observation.
const titlesByRun = new Map<string, string[]>()
function runKey(doc: TaskDoc): string {
    return `${doc.root} ${doc.rev ?? 'live'}`
}
for (const doc of docs) {
    const m = /^title:\s*(.+)$/m.exec(doc.text.slice(0, doc.text.indexOf('\n---', 4) + 1))
    const key = runKey(doc)
    const list = titlesByRun.get(key) ?? []
    if (m) list.push(m[1])
    titlesByRun.set(key, list)
}

for (const doc of docs) {
    const pairs = grillPairs(doc.text)
    if (pairs.length === 0) continue
    const design = designFor(doc, designCache)
    for (const pair of pairs) {
        if (pair.tag !== 'auto') continue
        const result = classifyAnswerNarrowing(pair.q, pair.a, design.text)
        let owned: boolean | null = null
        if (result.cls === 'narrowing') {
            const others = (titlesByRun.get(runKey(doc)) ?? []).filter(
                t => !doc.text.includes(`title: ${t}`)
            )
            owned =
                result.subjects.length === 0 ? null : (
                    others.some(t => result.subjects.some(s => t.includes(s)))
                )
        }
        rows.push({label: doc.label, designRef: design.ref, pair, result, subjectOwnedElsewhere: owned})
    }
}

// ─── report ──────────────────────────────────────────────────────────────────

const distinct = new Map<string, Row>()
for (const r of rows) {
    const k = `${r.pair.q} ${r.pair.a}`
    if (!distinct.has(k)) distinct.set(k, r)
}

function tally(list: Row[]): Record<NarrowingClass, number> {
    const t: Record<NarrowingClass, number> = {
        'not-a-set': 0,
        undecidable: 0,
        widening: 0,
        narrowing: 0
    }
    for (const r of list) t[r.result.cls]++
    return t
}

const all = rows
const dis = [...distinct.values()]
const tAll = tally(all)
const tDis = tally(dis)

console.log('=== corpus')
console.log(`  task files scanned        ${docs.length}`)
console.log(`  runs (root@rev)           ${titlesByRun.size}`)
console.log(`  (auto) answers            ${all.length} instances / ${dis.length} distinct`)
console.log(`  with a design resolved    ${dis.filter(r => r.designRef !== '(none)').length} distinct`)

const pct = (n: number, d: number) => (d === 0 ? '  0.0%' : `${((100 * n) / d).toFixed(1)}%`)
console.log('\n=== classification            instances            distinct')
for (const c of ['not-a-set', 'undecidable', 'widening', 'narrowing'] as NarrowingClass[]) {
    console.log(
        `  ${c.padEnd(24)} ${String(tAll[c]).padStart(6)} ${pct(tAll[c], all.length).padStart(7)}`
            + `      ${String(tDis[c]).padStart(4)} ${pct(tDis[c], dis.length).padStart(7)}`
    )
}

const setShaped = dis.length - tDis['not-a-set']
console.log(
    `\n  set-selection questions   ${setShaped} of ${dis.length} distinct `
        + `(${pct(setShaped, dis.length)}) — of those, ${tDis.narrowing} narrow and `
        + `${tDis.widening} widen; ${tDis.undecidable} ungrounded`
)

console.log('\n=== every NARROWING (hand-read these)')
const narrowings = dis.filter(r => r.result.cls === 'narrowing')
if (narrowings.length === 0) console.log('  (none)')
for (const r of narrowings) {
    const n = all.filter(
        x => x.pair.q === r.pair.q && x.pair.a === r.pair.a && x.result.cls === 'narrowing'
    ).length
    console.log(`\n  --- x${n}  ${r.label}   design=${r.designRef}`)
    console.log(`  Q       ${r.pair.q}`)
    console.log(`  A       ${r.pair.a}`)
    console.log(`  union   ${r.result.union.join(', ')}`)
    console.log(`  chosen  ${r.result.chosen.join(', ') || '(none)'}`)
    console.log(`  DROPPED ${r.result.missing.join(', ')}`)
    console.log(`  design  ${r.designRef}:${r.result.quoteLine}  ${r.result.quote}`)
    console.log(
        `  subject owned by another task in the run: `
            + `${r.subjectOwnedElsewhere === null ? 'unknown' : r.subjectOwnedElsewhere}`
    )
}

console.log('\n=== every WIDENING (the veto must leave these alone)')
for (const r of dis.filter(x => x.result.cls === 'widening')) {
    console.log(`\n  --- ${r.label}`)
    console.log(`  Q       ${r.pair.q}`)
    console.log(`  A       ${r.pair.a}`)
    console.log(`  union   ${r.result.union.join(', ')}`)
}

if (DUMP) {
    console.log('\n=== every set-shaped question that stayed UNDECIDABLE')
    for (const r of dis.filter(x => x.result.cls === 'undecidable')) {
        console.log(`\n  --- ${r.label}   design=${r.designRef}`)
        console.log(`  Q       ${r.pair.q}`)
        console.log(`  A       ${r.pair.a}`)
        console.log(`  union   ${r.result.union.join(', ')}`)
        console.log(`  chosen  ${r.result.chosen.join(', ') || '(none)'}`)
    }
}

console.log('\n=== verdict line')
console.log(
    `  ${tDis.narrowing} distinct narrowing(s) / ${setShaped} set-shaped / ${dis.length} distinct `
        + `auto-answers. ${tAll.narrowing} instance(s) across ${all.length}.`
)
