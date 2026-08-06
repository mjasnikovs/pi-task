/**
 * STEP 1 for nexttask 13 — how much of the WIRING class the shipped
 * surviving-unknown guard (`src/task/unknown-routing.ts`) already catches,
 * measured over every recorded run BEFORE any regex changes.
 *
 * Methodology rule this satisfies: measure the base rate BEFORE changing code
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md; nexttask 7, which was
 * refuted at STEP 0 for exactly this reason).
 *
 * CORPUS. Every `<tree>/.pi-tasks/TASK_*.md` under ~/hub, ~/tmp and ~/.cache, plus
 * — for trees that TRACK `.pi-tasks/` (mx5 does) — every historical version of
 * those files, read with `git show <rev>:<path>`. Nothing is ever checked out over
 * a worktree (memory/never-git-stash-concurrent-sessions.md). Walker copied from
 * `scripts/autoanswer-narrowing-baserate.ts`.
 *
 * The corpus is A/B-replicated: tens of thousands of task files carry only a few
 * hundred DISTINCT questions, because trial directories replay one task dozens of
 * times. Both denominators are reported. DISTINCT is the honest one for recall.
 *
 * LABELS. `scripts/fixtures/unknown-routing-labels.json` carries one hand label per
 * distinct question, applying nexttask 13's rule literally:
 *
 *     is_wiring_truth is TRUE iff a wrong answer yields a program that BUILDS,
 *     TYPE-CHECKS, STARTS, and fails only when two components talk.
 *
 * That excludes anything a compiler catches (export names, response shapes behind
 * an RPC type, module aliases), anything that fails loudly at build or boot, and
 * anything that merely degrades (wording, limits, layout, status-code nuance). It
 * includes non-type-checked couplings: base URLs, route prefixes, mount paths,
 * ports, origins, static-asset serving, CSS tokens another file consumes, the DB
 * the app reaches, and the entry a script is invoked through.
 *
 * The script FAILS LOUD if the corpus contains a question the fixture does not
 * label, so the labels cannot silently drift out of sync with the corpus.
 *
 * Read-only over the corpus: nothing is checked out, no tree is written to.
 *
 * Run: bun run scripts/unknown-routing-coverage-baserate.ts
 *      bun run scripts/unknown-routing-coverage-baserate.ts --split   (STEP 2)
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {isIntegrationUnknown} from '../src/task/unknown-routing.js'

const HOME = os.homedir()
const SPLIT = process.argv.includes('--split')
const SEARCH_ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]
const HERE = path.dirname(new URL(import.meta.url).pathname)
const FIXTURES = path.join(HERE, 'fixtures')

// ─── the two mx5 forms of the question that motivated the task ───────────────
// Form A is the KNOWN-UNKNOWN as `refine` wrote it into ~/hub/mx5/.pi-tasks/
// TASK_0016.md:36. Form B is the grill question at :115 that carried it into the
// `(auto)` answer at :116, which compose froze as "The `hc` base URL must be
// hardcoded to `/api`" (:130) and src/client/api.ts:95 obeyed. Form B is also in
// the corpus on its own; form A never reaches the grill Q&A section, so it is
// injected here — named, so STEP 3 can require both.
const MX5_FORMS: {name: string; q: string}[] = [
    {
        name: 'mx5-form-a-known-unknown',
        q:
            'What is the expected base URL for the `hc` client at runtime? Should it default to '
            + '`/api` (relative, same-origin) or accept a configurable base URL via an environment '
            + 'variable? The spec says "API (Hono RPC, `/api`)" but doesn\'t specify whether the '
            + 'client should hardcode this or make it configurable.'
    },
    {
        name: 'mx5-form-b-grill-question',
        q:
            'Base URL — Research confirms: server runs same-origin, SPA serves from same origin, '
            + 'relative URLs like /api work without base URL argument. The spec says "API (Hono '
            + 'RPC, /api)". This is resolved: use /api.'
    }
]

// ─── corpus discovery (copied from scripts/autoanswer-narrowing-baserate.ts) ──

interface TaskDoc {
    label: string
    root: string
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
        stdio: ['ignore', 'pipe', 'ignore']
    })
}

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

function section(text: string, name: string): string {
    const i = text.indexOf(`\n## ${name}`)
    if (i < 0) return ''
    const rest = text.slice(i + 1)
    const nl = rest.indexOf('\n')
    const body = nl < 0 ? '' : rest.slice(nl + 1)
    const end = body.indexOf('\n## ')
    return end < 0 ? body : body.slice(0, end)
}

/** Every `(auto)`-answered grill question in one task file. */
function autoQuestions(text: string): string[] {
    const out: string[] = []
    let q: string | null = null
    for (const line of section(text, 'grill Q&A').split('\n')) {
        const mq = /^Q\d+:\s*(.+)$/.exec(line)
        if (mq) {
            q = mq[1].trim()
            continue
        }
        const ma = /^A\d+:\s*(.+)$/.exec(line)
        if (ma && q !== null) {
            if (/\(auto\)$/.test(ma[1].trim())) out.push(q)
            q = null
        }
    }
    return out
}

// ─── Factor B, verbatim, for the CEILING ─────────────────────────────────────
// nexttask 13 forbids touching Factor B, and `isIntegrationUnknown` is an AND of
// the two factors. So the highest recall any Factor-A edit can reach is the share
// of wiring questions Factor B already matches. That number decides whether STEP 3
// is reachable at all under the task's own constraint, so it is measured here
// rather than discovered at STEP 3.
const WIRING_INTENT_RE =
    /\b(?:wir(?:e|ed|ing)|integrat(?:e|ed|es|ing|ion)|hook(?:ed|s|ing)?\s+(?:it\s+|them\s+)?(?:up|in|into)|plug(?:ged|s|ging)?\s+(?:it\s+|them\s+)?(?:in|into)|configur(?:e|ed|es|ing|ation)|set[\s-]*up|register(?:ed|s|ing)?|mount(?:ed|s|ing)?|how\s+(?:to|do|does|should|is|are)|where\s+(?:to|should|does|is))\b/i

{
    // Guard against silent drift: the copy above must still be the shipped source.
    const src = fs.readFileSync(path.join(HERE, '..', 'src', 'task', 'unknown-routing.ts'), 'utf8')
    if (!src.includes(WIRING_INTENT_RE.source)) {
        console.error(
            'FATAL: the Factor-B copy in this script no longer matches src/task/unknown-routing.ts.'
        )
        process.exit(1)
    }
}

// ─── calibration ─────────────────────────────────────────────────────────────
// The three rows at the top of nexttask13.md. If the harness cannot reproduce
// false/true/false, every count below is meaningless.
const CALIBRATION: {q: string; expect: boolean}[] = [
    {q: MX5_FORMS[0].q, expect: false},
    {q: 'How should the vite plugin be wired into the build pipeline?', expect: true},
    {q: 'Should the hooks use useSWR, tanstack-query, or vanilla useState/useEffect?', expect: false}
]
for (const c of CALIBRATION) {
    if (isIntegrationUnknown(c.q) !== c.expect) {
        console.error(`FATAL: calibration row failed — expected ${c.expect} for: ${c.q.slice(0, 70)}`)
        process.exit(1)
    }
}

// ─── measurement ─────────────────────────────────────────────────────────────

interface LabelRow {
    q: string
    instances: number
    wiring: boolean
}

export interface CorpusRow {
    /** `mx5-form-a-known-unknown` etc. for the named injections, else null. */
    name: string | null
    question: string
    is_wiring_truth: boolean
    /** `isIntegrationUnknown(question)` as shipped today. */
    shipped: boolean
    /** Factor B alone — the ceiling any Factor-A-only edit can reach. */
    factor_b: boolean
    /** How many task files in the corpus carry this question. */
    instances: number
}

const labels: LabelRow[] = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'unknown-routing-labels.json'), 'utf8')
)
const labelOf = new Map(labels.map(l => [l.q, l.wiring]))

const docs = collect()
const instances = new Map<string, number>()
for (const doc of docs) {
    for (const q of autoQuestions(doc.text)) instances.set(q, (instances.get(q) ?? 0) + 1)
}

const unlabelled = [...instances.keys()].filter(q => !labelOf.has(q))
if (unlabelled.length > 0) {
    console.error(
        `FATAL: ${unlabelled.length} corpus question(s) carry no hand label. Add them to `
            + `scripts/fixtures/unknown-routing-labels.json — an unlabelled question would be `
            + `silently dropped from the denominator. First:\n  ${unlabelled[0].slice(0, 140)}`
    )
    process.exit(1)
}

const rows: CorpusRow[] = []
for (const [question, n] of instances) {
    rows.push({
        name: null,
        question,
        is_wiring_truth: labelOf.get(question) === true,
        shipped: isIntegrationUnknown(question),
        factor_b: WIRING_INTENT_RE.test(question),
        instances: n
    })
}
for (const form of MX5_FORMS) {
    const existing = rows.find(r => r.question === form.q)
    if (existing) {
        existing.name = form.name
        existing.is_wiring_truth = true
        continue
    }
    rows.push({
        name: form.name,
        question: form.q,
        is_wiring_truth: true,
        shipped: isIntegrationUnknown(form.q),
        factor_b: WIRING_INTENT_RE.test(form.q),
        instances: 0
    })
}
rows.sort((a, b) => (a.question < b.question ? -1 : a.question > b.question ? 1 : 0))

fs.writeFileSync(
    path.join(FIXTURES, 'unknown-routing-corpus.json'),
    JSON.stringify(rows, null, 1) + '\n'
)

// ─── report ──────────────────────────────────────────────────────────────────

const totalInstances = [...instances.values()].reduce((a, b) => a + b, 0)
const wiring = rows.filter(r => r.is_wiring_truth)
const pref = rows.filter(r => !r.is_wiring_truth)
const recallShipped = wiring.length === 0 ? 0 : wiring.filter(r => r.shipped).length / wiring.length
const ceiling = wiring.length === 0 ? 0 : wiring.filter(r => r.factor_b).length / wiring.length
const fpShipped = pref.length === 0 ? 0 : pref.filter(r => r.shipped).length / pref.length

const pct = (x: number) => `${(100 * x).toFixed(1)}%`

console.log('=== corpus')
console.log(`  task files scanned          ${docs.length}`)
console.log(`  (auto) answers              ${totalInstances} instances / ${instances.size} distinct`)
console.log(`  + named mx5 forms injected  ${rows.length - instances.size}`)
console.log(`  labelled rows               ${rows.length}`)
console.log('')
console.log('=== hand labels')
console.log(`  is_wiring_truth   ${String(wiring.length).padStart(4)}`)
console.log(`  preference        ${String(pref.length).padStart(4)}`)
console.log('')
console.log('=== the shipped classifier on those labels')
console.log(`  recall_shipped              ${wiring.filter(r => r.shipped).length}/${wiring.length}  ${pct(recallShipped)}`)
console.log(`  false-positive_shipped      ${pref.filter(r => r.shipped).length}/${pref.length}  ${pct(fpShipped)}`)
console.log('')
console.log('=== FACTOR-B CEILING (nexttask 13 forbids touching Factor B)')
console.log(`  wiring questions Factor B already matches   ${wiring.filter(r => r.factor_b).length}/${wiring.length}  ${pct(ceiling)}`)
console.log(`  ⇒ no Factor-A-only edit can exceed this recall.`)
for (const form of MX5_FORMS) {
    const r = rows.find(x => x.name === form.name)!
    console.log(`  ${form.name.padEnd(26)} factor_b=${r.factor_b}  shipped=${r.shipped}`)
}
console.log('')
console.log('=== every wiring question the shipped classifier MISSES')
for (const r of wiring.filter(x => !x.shipped)) {
    console.log(`  [B=${r.factor_b ? 'y' : 'n'}] x${String(r.instances).padStart(4)}  ${r.question.replace(/\s+/g, ' ').slice(0, 120)}`)
}
console.log('')
console.log('=== every preference question the shipped classifier CATCHES (false positives)')
for (const r of pref.filter(x => x.shipped)) {
    console.log(`  x${String(r.instances).padStart(4)}  ${r.question.replace(/\s+/g, ' ').slice(0, 120)}`)
}

console.log('')
console.log('=== verdict line')
console.log(
    `  recall_shipped ${pct(recallShipped)} over ${wiring.length} hand-labelled wiring questions `
        + `(${pref.length} preference), ${totalInstances} instances / ${instances.size} distinct. `
        + `Factor-B ceiling ${pct(ceiling)}.`
)

// ─── STEP 2 — deterministic 50/50 split by a hash of the question text ───────

if (SPLIT) {
    // FNV-1a. Deterministic across runs and machines; independent of corpus order,
    // so the holdout cannot drift when a new trial directory appears.
    const hash = (s: string): number => {
        let h = 0x811c9dc5
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i)
            h = Math.imul(h, 0x01000193) >>> 0
        }
        return h
    }
    // The named mx5 forms are pinned to the FIT half only if the hash says so —
    // STEP 3 requires them regardless of which half they land in, so no thumb on
    // the scale here.
    const fit = rows.filter(r => hash(r.question) % 2 === 0)
    const holdout = rows.filter(r => hash(r.question) % 2 === 1)
    fs.writeFileSync(
        path.join(FIXTURES, 'unknown-routing-corpus-fit.json'),
        JSON.stringify(fit, null, 1) + '\n'
    )
    fs.writeFileSync(
        path.join(FIXTURES, 'unknown-routing-corpus-holdout.json'),
        JSON.stringify(holdout, null, 1) + '\n'
    )
    console.log('')
    console.log('=== split')
    console.log(
        `  fit      ${fit.length} rows (${fit.filter(r => r.is_wiring_truth).length} wiring)`
    )
    console.log(
        `  holdout  ${holdout.length} rows (${holdout.filter(r => r.is_wiring_truth).length} wiring)`
            + `  — DO NOT OPEN until STEP 3`
    )
}

process.exit(0)
