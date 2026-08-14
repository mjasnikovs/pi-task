/**
 * STEP 0 of nexttask 19 — the base rates that gate 19A and 19B, measured BEFORE
 * either lever exists. READ-ONLY: it opens `.pi-tasks` trees under ~/hub, ~/tmp
 * and ~/.cache and writes nothing anywhere.
 *
 * TWO QUESTIONS, and they are not the same question:
 *
 *   19A  How many times has the final gate DEMOTED a check to UNOBSERVED, and of
 *        those, how many demoted a check whose probe had actually OBSERVED the
 *        failure? A demotion of a probe that returned `skip` would mean the
 *        probes do NOT self-report their own blindness and the compensator in
 *        `isNonProgress` is still load-bearing — which forbids 19A.
 *
 *   19B  How many render-probe FAILs are recorded, and how many carry the
 *        console evidence the probe held at the moment it judged? The answer is
 *        the size of the class 19B closes.
 *
 * NEVER POOLED. Counts are reported per project, and the A/B harness trees under
 * ~/.cache are labelled for what they are: many independent RUNS of ONE project
 * shape (mx5), which is evidence of reproducibility and not of breadth — the
 * honesty rule nexttask 15 wrote down and this file inherits.
 *
 * POSITIVE CONTROLS, both mandatory. A zero only counts if the detector fires:
 *
 *   19A control  a synthetic demote trail whose demoted detail is a probe SKIP
 *                note — the classifier must label it SKIPPED. If it cannot, the
 *                "0 skip-class demotions" number is worthless and this script
 *                REFUSES to report (exit 2).
 *   19B control  the captured run-21 DOM — `judgeRenderedDom` must return
 *                ok:false on it, and the recorded-FAIL detector must fire on the
 *                text that verdict produces.
 *
 * Run: bun run scripts/gate-demote-baserate.ts
 * Exit 0 = counts reported. Exit 2 = a control did not trip; no counts reported.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {judgeRenderedDom} from '../src/task/render-check.js'

const HOME = os.homedir()
const ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]
const MAX_DEPTH = 6

/** The run-21 DOM this repo captured from the shipped mx5 bundle (318 bytes). */
const RUN21_DOM = path.join(import.meta.dirname, 'fixtures', 'run21-render', 'dom.html')

const rel = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)

// ─── corpus ──────────────────────────────────────────────────────────────────

/** Every `.pi-tasks` directory under the roots, without descending into one. */
function findTaskTrees(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        if (entries.some(e => e.name === '.pi-tasks' && e.isDirectory())) {
            found.push(path.join(dir, '.pi-tasks'))
            return
        }
        for (const e of entries) {
            if (!e.isDirectory() || e.isSymbolicLink()) continue
            if (e.name === 'node_modules') continue
            if (e.name.startsWith('.') && depth > 0) continue
            walk(path.join(dir, e.name), depth + 1)
        }
    }
    walk(root, 0)
    return found
}

/**
 * How a tree is LABELLED in the report. `~/hub/<name>` is a real project. Anything
 * under `~/.cache` or `~/tmp` is an A/B harness tree — one RUN of a project shape,
 * and the shape is named so the reader can see that 24 of them are 24 runs of mx5.
 */
interface Tree {
    dir: string
    project: string
    harness: boolean
}

function labelTree(taskDir: string): Tree {
    const dir = path.dirname(taskDir)
    const hub = path.join(HOME, 'hub')
    if (dir.startsWith(hub + path.sep)) {
        return {dir, project: path.relative(hub, dir).split(path.sep)[0]!, harness: false}
    }
    // Harness trees name their source shape in the leaf ("mx5-dfbdd6f-run-19-…",
    // "baseline-t1" under a harness whose whole corpus is mx5).
    const leaf = path.basename(dir)
    const shape = /^(mx5|iar1|gofer[a-z-]*|dace-pro|aiz-[a-z]+)/i.exec(leaf)?.[1]?.toLowerCase()
    return {dir, project: shape ?? 'mx5', harness: true}
}

/** Gate-trail lines of every TASK_*.md in a `.pi-tasks` tree. */
function trailLines(taskDir: string): string[] {
    let names: string[]
    try {
        names = fs.readdirSync(taskDir).filter(n => /^TASK_.*\.md$/.test(n))
    } catch {
        return []
    }
    const out: string[] = []
    for (const n of names) {
        let body: string
        try {
            body = fs.readFileSync(path.join(taskDir, n), 'utf8')
        } catch {
            continue
        }
        for (const line of body.split('\n')) {
            if (line.includes('final-gate')) out.push(line)
        }
    }
    return out
}

// ─── classifiers ─────────────────────────────────────────────────────────────

/** `final-gate: check DEMOTED to UNOBSERVED … : <detail>` — the demoted detail. */
const DEMOTE_RE = /final-gate: check DEMOTED to UNOBSERVED\b[^:]*(?::[^:]*)?: ([\s\S]+)$/

function demotedDetail(line: string): string | null {
    const m = DEMOTE_RE.exec(line)
    return m ? m[1]!.trim() : null
}

/**
 * Did the probe behind a demoted check OBSERVE, or was it blind?
 *
 * The probes answer this THEMSELVES and always have (`RenderOutcome` is
 * pass|fail|skip; `f648f5b` 2026-07-14 turned a render `skip` into "render check
 * UNOBSERVED: <reason>", `b0f90a7` 2026-07-19 turned an unenumerable boot into
 * "listener check UNOBSERVED: …"). So a demoted detail that CARRIES one of those
 * self-reports came from a blind probe; anything else is a failure a probe
 * returned after looking.
 *
 * This is a measurement of RECORDED HISTORY, not the lever: 19A threads the
 * probe's outcome class through the value, and never re-derives it from text.
 */
const BLIND_SELF_REPORTS = [
    'render check UNOBSERVED',
    'authenticated render check UNOBSERVED',
    'listener check UNOBSERVED',
    'boot check: this project'
]

function probeWasBlind(detail: string): boolean {
    const d = detail.toLowerCase()
    return BLIND_SELF_REPORTS.some(m => d.includes(m.toLowerCase()))
}

/** The exact sentence `judgeRenderedDom` emits for a blank page — never retyped. */
const EMPTY_BODY_DETAIL = judgeRenderedDom('<html><body></body></html>').detail

/** A recorded render-probe FAIL: the gate wraps the judge's detail in the boot line. */
function isRenderFail(line: string): boolean {
    return line.includes(EMPTY_BODY_DETAIL)
}

/**
 * Does a recorded render FAIL carry the page's console output? Chrome stamps
 * console lines as `[…:INFO:CONSOLE:<line>] "…"`, and 19B appends them under a
 * named heading. Either marker counts — the question is whether the CAUSE
 * travelled with the SYMPTOM, not how it was formatted.
 */
function carriesConsoleEvidence(line: string): boolean {
    return /INFO:CONSOLE:|console output:/i.test(line)
}

// ─── controls ────────────────────────────────────────────────────────────────

const controls: Array<[string, boolean]> = []

// 19A control — a synthetic demote of a check whose probe returned `skip`.
const SYNTHETIC_SKIP_DEMOTE =
    '- 2026-08-13T19:03:35.588Z final-gate: check DEMOTED to UNOBSERVED after 2 tree-changing '
    + "attempts returned an identical failure — carried as debt (origin final-gate) and re-checked by the next run's gate: "
    + 'boot check: `bun run dev` render check UNOBSERVED: no headless Chrome-family browser found on this box'
const synthDetail = demotedDetail(SYNTHETIC_SKIP_DEMOTE)
controls.push(['19A: the demote parser extracts a detail from a real trail line', synthDetail !== null])
controls.push([
    '19A: a demotion of a SKIPPED probe is classified SKIPPED',
    synthDetail !== null && probeWasBlind(synthDetail)
])
// …and the run-21 shape must classify the other way, or the classifier is a constant.
const RUN21_DETAIL =
    'boot check: `bun run dev` listens on :3000 but ' + EMPTY_BODY_DETAIL
controls.push([
    '19A: a demotion of an OBSERVING probe is classified OBSERVED',
    !probeWasBlind(RUN21_DETAIL)
])

// 19B control — the captured run-21 DOM really is judged EMPTY.
let run21Dom: string | null
try {
    run21Dom = fs.readFileSync(RUN21_DOM, 'utf8')
} catch {
    run21Dom = null
}
const judged = run21Dom === null ? null : judgeRenderedDom(run21Dom)
controls.push(['19B: the captured run-21 DOM is on disk', run21Dom !== null])
controls.push(['19B: `judgeRenderedDom` returns ok:false on it', judged !== null && !judged.ok])
controls.push([
    '19B: the recorded-FAIL detector fires on the text that verdict produces',
    judged !== null && isRenderFail(`boot check: \`bun run dev\` listens on :3000 but ${judged.detail}`)
])
controls.push([
    '19B: the console-evidence detector fires on a real Chrome stderr line',
    carriesConsoleEvidence(
        '[11506:11506:0814/090315.702981:INFO:CONSOLE:322] "Uncaught ReferenceError: process is not defined"'
    )
])
controls.push([
    '19B: …and does NOT fire on a FAIL that carries none',
    !carriesConsoleEvidence(RUN21_DETAIL)
])

console.log('CONTROLS')
for (const [label, ok] of controls) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
if (!controls.every(([, ok]) => ok)) {
    console.log('\nA CONTROL DID NOT TRIP — no counts reported. A zero from a dead detector is not a zero.')
    process.exit(2)
}

// ─── measurement ─────────────────────────────────────────────────────────────

interface Row {
    project: string
    harness: boolean
    trees: number
    gateLogs: number
    gateEpisodes: number
    demotes: number
    demotesObserved: number
    demotesSkipped: number
    renderFails: number
    renderFailsWithConsole: number
}

const rows = new Map<string, Row>()
const row = (t: Tree): Row => {
    const key = `${t.project}${t.harness ? ' (harness)' : ''}`
    let r = rows.get(key)
    if (!r) {
        r = {
            project: key,
            harness: t.harness,
            trees: 0,
            gateLogs: 0,
            gateEpisodes: 0,
            demotes: 0,
            demotesObserved: 0,
            demotesSkipped: 0,
            renderFails: 0,
            renderFailsWithConsole: 0
        }
        rows.set(key, r)
    }
    return r
}

const demoteSamples: Array<{tree: string; observed: boolean; detail: string}> = []
const renderFailSamples: Array<{tree: string; withConsole: boolean}> = []

const taskDirs = ROOTS.flatMap(findTaskTrees)
for (const taskDir of taskDirs) {
    const tree = labelTree(taskDir)
    const r = row(tree)
    r.trees += 1
    if (fs.existsSync(path.join(taskDir, 'final-gate-debug.log'))) r.gateLogs += 1
    for (const line of trailLines(taskDir)) {
        // A gate EPISODE is one verdict line ("final-gate: FAIL — …" / ": PASS").
        if (/final-gate: (?:FAIL —|PASS\b|UNOBSERVED\b)/.test(line)) r.gateEpisodes += 1
        const d = demotedDetail(line)
        if (d !== null) {
            r.demotes += 1
            const blind = probeWasBlind(d)
            if (blind) r.demotesSkipped += 1
            else r.demotesObserved += 1
            demoteSamples.push({tree: rel(tree.dir), observed: !blind, detail: d.slice(0, 160)})
        }
        if (isRenderFail(line)) {
            r.renderFails += 1
            const withConsole = carriesConsoleEvidence(line)
            if (withConsole) r.renderFailsWithConsole += 1
            renderFailSamples.push({tree: rel(tree.dir), withConsole})
        }
    }
}

const ordered = [...rows.values()].sort((a, b) =>
    a.harness === b.harness ? b.gateEpisodes - a.gateEpisodes : (
        Number(a.harness) - Number(b.harness)
    )
)

console.log('\nCORPUS — per project, NEVER pooled')
console.log(`  ${'project'.padEnd(22)} trees  logs  episodes  demotes  obs  skip  renderFAIL  w/console`)
for (const r of ordered) {
    console.log(
        `  ${r.project.padEnd(22)}`
            + `${String(r.trees).padStart(5)}`
            + `${String(r.gateLogs).padStart(6)}`
            + `${String(r.gateEpisodes).padStart(10)}`
            + `${String(r.demotes).padStart(9)}`
            + `${String(r.demotesObserved).padStart(5)}`
            + `${String(r.demotesSkipped).padStart(6)}`
            + `${String(r.renderFails).padStart(12)}`
            + `${String(r.renderFailsWithConsole).padStart(11)}`
    )
}

const sum = (f: (r: Row) => number): number => [...rows.values()].reduce((a, r) => a + f(r), 0)
const realProjects = [...rows.values()].filter(r => !r.harness)
const harnessTrees = [...rows.values()].filter(r => r.harness)

console.log('\nWHAT THE HARNESS ROWS ARE')
console.log(
    `  ${harnessTrees.reduce((a, r) => a + r.trees, 0)} of the ${taskDirs.length} trees are A/B harness copies under `
        + `~/.cache and ~/tmp. They are independent RUNS of ONE project shape, not distinct projects: `
        + `evidence of REPRODUCIBILITY, never of breadth.`
)
console.log(
    `  Real projects with a .pi-tasks tree under ~/hub: ${realProjects.length} `
        + `(${realProjects.map(r => r.project).join(', ')})`
)

console.log('\n19A — THE DEMOTE CLASS')
console.log(`  final_gate_runs (final-gate-debug.log files)      ${sum(r => r.gateLogs)}`)
console.log(`  final_gate verdict episodes in task trails        ${sum(r => r.gateEpisodes)}`)
console.log(`  demote_episodes                                   ${sum(r => r.demotes)}`)
console.log(`  demote_episodes_where_the_probe_OBSERVED          ${sum(r => r.demotesObserved)}`)
console.log(`  demote_episodes_where_the_probe_SKIPPED           ${sum(r => r.demotesSkipped)}`)
for (const s of demoteSamples) {
    console.log(`    - ${s.observed ? 'OBSERVED' : 'SKIPPED '}  ${s.tree}`)
    console.log(`        ${s.detail}`)
}

console.log('\n19B — THE DISCARDED-EVIDENCE CLASS')
console.log(`  render_probe_FAILs                                ${sum(r => r.renderFails)}`)
console.log(`  render_probe_FAILs_carrying_console_evidence      ${sum(r => r.renderFailsWithConsole)}`)
const byTree = new Map<string, number>()
for (const s of renderFailSamples) byTree.set(s.tree, (byTree.get(s.tree) ?? 0) + 1)
console.log(`  distinct trees recording one                      ${byTree.size}`)

console.log('\nPRE-REGISTERED GATES')
const skipped = sum(r => r.demotesSkipped)
const gate19A = skipped === 0
console.log(
    `  19A ships iff demote_episodes_where_the_probe_SKIPPED == 0 → ${skipped} → `
        + `${gate19A ? 'SHIPS' : 'STOP — the compensator is still load-bearing; fix the probe instead'}`
)
console.log('  19B ships unconditionally (strictly additive, appends already-captured evidence to an existing FAIL).')
console.log(
    `      Its class size here is ${sum(r => r.renderFails)} recorded FAILs, `
        + `${sum(r => r.renderFailsWithConsole)} of which carry the cause.`
)

console.log('\nHONESTY')
console.log(
    '  In the ~/hub corpus alone the demote episode count is 1 and the render FAIL count is small. '
        + 'Neither 19A nor 19B is justified by FREQUENCY. 19A is justified by what the one episode DID '
        + '(released a blank-page product as `completed`); 19B by what it CANNOT do (append-only to an '
        + 'existing FAIL).'
)
process.exit(0)
