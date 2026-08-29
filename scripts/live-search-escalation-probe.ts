/**
 * NOTE (reasoning profiles): this harness used to append Qwen3's `/no_think`
 * soft switch to its prompts, matching what the pipeline did at the time. That
 * switch has since been measured INERT — with server thinking on and
 * `/no_think` still in the prompt, Qwen3.8 emitted a median 17k-char trace
 * anyway (n=25) — and removed in favour of the `--thinking` flag
 * (src/config/reasoning.ts). Any number this file recorded BEFORE that change
 * was taken with the suffix present, and therefore at whatever thinking level
 * the session default happened to be — not at "no thinking".
 */
/**
 * LIVE PROBE against the real local model (llama-server @ 127.0.0.1:8080 via pi):
 * does a research worker actually escalate from pi-worker-docs to pi-worker-search
 * when the installed docs do not contain the answer?
 *
 * WHY THIS EXISTS. The mx5 run-13 audit recorded "0 search calls" and filed it as a
 * third occurrence of the runs 6/9 class, implying the directive → tool-exposure →
 * dispatch chain was broken somewhere. Re-reading the artifacts contradicted that:
 * run 13 made 539 pi-worker-docs, 15 pi-worker-fetch and 2 pi-worker-search calls;
 * the "use web search" directive is verbatim in requirements.md:5; the default exa
 * provider makes searchConfigured() true so the tools ARE in the APIS worker's
 * toolset; and both searches fired right after docs was exhausted. The one task that
 * looked pathological — TASK_0027, 68 docs calls, no search — turns out to have made
 * 63 of those against the PROJECT'S OWN SOURCE (module "."), which is not a
 * web-search question at all.
 *
 * This probe is the live half of that argument: it puts a real worker child in
 * exactly the state the audit assumed was failing and measures whether it escalates.
 * Result at the time of writing: 5/5 on both fixtures, i.e. the seam is saturated and
 * there is no escalation deficit to fix. Re-run it before believing any future "zero
 * search calls" report — a regression here would show as a rate below 5/5.
 *
 * SEAM. A real APIS worker child (runWorker, real tool loop, real model) with the
 * shipped RESEARCH_SEARCH_HINT. pi-worker-docs is STUBBED to return a real-shaped
 * answer that silently lacks the requested fact — deterministic, and the same text
 * however many times it is asked. pi-worker-search is STUBBED so no live network is
 * touched and, more importantly, so the metric is recorded by the TOOL LAYER.
 *
 * METRIC — unfakeable, never model self-report: each stub appends a line to calls.log
 * when INVOKED. A trial ESCALATED iff calls.log contains a pi-worker-search line. The
 * model's prose about what it "would" search is ignored entirely.
 *
 * Run (PI_BIN is mandatory — an unset PI_BIN self-spawns a fork bomb that has crashed
 * this machine twice):
 *   PI_BIN=$(command -v pi) FIXTURE=pointed|broad \
 *     bun run scripts/live-search-escalation-probe.ts [TRIALS]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {RESEARCH_SEARCH_HINT} from '../src/task/phases.js'
import {reportArm} from './ab-verdict.js'

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error(
        'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke '
            + 'this harness instead of pi — a fork bomb that has crashed this machine twice.\n'
            + 'Run as: PI_BIN=$(command -v pi) bun run scripts/live-search-escalation-probe.ts'
    )
    process.exit(1)
}

const trials = Number(process.argv[2] ?? '5')

// Fixtures live under /home/edgars/tmp — pi's trust root covers /home/edgars, /tmp is
// untrusted. /home/edgars/hub/mx5 is evidence and is never written to.
const ROOT = path.join(os.homedir(), 'tmp', 'search-escalation-probe')

/**
 * The stubbed research toolset, written as plain .mjs because pi loads extension
 * FILES at runtime (there is no TS pipeline inside the child).
 */
function writeExtension(dir: string): string {
    const file = path.join(dir, 'probe-research-ext.mjs')
    fs.writeFileSync(
        file,
        `import * as fs from 'node:fs'

const LOG = ${JSON.stringify(path.join(dir, 'calls.log'))}
const record = (line) => { try { fs.appendFileSync(LOG, line + '\\n') } catch {} }

// Real-shaped installed-types output that does NOT contain the SSE streaming helper
// being asked about. Identical for every query, so re-asking can never make progress —
// the state the audit assumed the worker gets stuck in.
const CANNED =
  'hono@4.6.3 — installed types\\n' +
  'export declare class Hono<E extends Env = Env> { get(path: string, ...handlers: H[]): this;\\n' +
  '  post(path: string, ...handlers: H[]): this; route(path: string, app: Hono): this }\\n' +
  'export type MiddlewareHandler = (c: Context, next: Next) => Promise<void>\\n' +
  'export interface Context { req: HonoRequest; json(o: unknown): Response;\\n' +
  '  text(t: string): Response; body(b: BodyInit | null): Response; header(n: string, v: string): void }'

export default function (pi) {
  pi.registerTool({
    name: 'pi-worker-docs',
    label: 'Pi Worker Docs',
    description:
      'Look up an INSTALLED npm package and return a focused, version-pinned answer ' +
      'from its .d.ts types and README. USE THIS BEFORE ANSWERING any question about ' +
      'how to use a library, what it exports, or its types/overloads/config.',
    parameters: {
      type: 'object',
      properties: {module: {type: 'string'}, query: {type: 'string'}},
      required: ['module', 'query']
    },
    executionMode: 'parallel',
    async execute(_id, params) {
      record('pi-worker-docs\\t' + params.module + '\\t' + params.query)
      return {content: [{type: 'text', text: CANNED}], details: {}}
    },
    renderCall: () => ({})
  })

  pi.registerTool({
    name: 'pi-worker-search',
    label: 'Pi Worker Search',
    description:
      'Search the live web and return ranked results with URLs. Use for external ' +
      'facts that may be missing from or newer than installed package docs.',
    parameters: {
      type: 'object',
      properties: {query: {type: 'string'}},
      required: ['query']
    },
    executionMode: 'parallel',
    async execute(_id, params) {
      record('pi-worker-search\\t' + params.query)
      return {
        content: [{type: 'text', text:
          '1. https://hono.dev/docs/helpers/streaming — streamSSE(c, async (stream) => {…}); ' +
          'stream.writeSSE({data, event, id}) and stream.sleep(ms).'}],
        details: {}
      }
    },
    renderCall: () => ({})
  })
}
`,
        'utf8'
    )
    return file
}

/**
 * `pointed` — a single unanswerable API question.
 * `broad`   — an IMPLEMENTATION research brief, the shape run 13's heaviest research
 *             task had, where no single question announces itself as external and
 *             grinding docs can feel like progress.
 * Both escalate 5/5, which is why no escalation guard was built.
 */
const FIXTURES: Record<string, string> = {
    pointed:
        'You are the APIS research worker for a task implementing server-sent events on a '
        + 'Hono server.\n\n'
        + 'Answer this, grounded in tool output only — do NOT answer from memory:\n'
        + "What is the exact signature of Hono's SSE streaming helper — the function name, "
        + 'what it takes, and how you write an event to the stream?\n\n'
        + 'Use pi-worker-docs for installed package APIs. When you have the answer, write it '
        + 'out with the exact signature and stop.',
    broad:
        'You are the APIS research worker for this task:\n\n'
        + '  Implement the live activity feed page — the server pushes updates over SSE and '
        + 'the page renders them as they arrive, with a reconnect indicator.\n\n'
        + 'Produce an APIS section: for every API this task will call, give the exact '
        + 'signature and how it is used, grounded in tool output only — never from memory.\n'
        + 'Cover at minimum: how the Hono server opens the event stream and writes events to '
        + 'it, and how a handler sets the response headers the stream needs.\n\n'
        + 'Use pi-worker-docs for installed package APIs. Write the APIS section and stop.'
}
const fixture = process.env.FIXTURE ?? 'pointed'
if (!(fixture in FIXTURES)) {
    console.error(`unknown FIXTURE=${fixture}; expected one of ${Object.keys(FIXTURES).join('|')}`)
    process.exit(1)
}
const PROMPT = FIXTURES[fixture] + RESEARCH_SEARCH_HINT

async function trial(n: number): Promise<{searched: boolean; docs: number}> {
    const dir = path.join(ROOT, `${fixture}-${n}`)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({name: 'probe-fixture', dependencies: {hono: '^4.6.3'}}, null, 2),
        'utf8'
    )
    const ext = writeExtension(dir)

    await runWorker({
        prompt: PROMPT,
    profile: 'adhoc', contextWindow: 'unknown',
        cwd: dir,
        tools: 'read,pi-worker-docs,pi-worker-search',
        extensions: [ext],
        onLine: () => {}
    })

    const logFile = path.join(dir, 'calls.log')
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
    const lines = log.split('\n')
    const docs = lines.filter(l => l.startsWith('pi-worker-docs')).length
    const searched = lines.some(l => l.startsWith('pi-worker-search'))
    console.log(`  trial ${n}: docs=${docs} search=${searched ? 'YES' : 'no'}`)
    return {searched, docs}
}

console.log(`live search-escalation probe — fixture=${fixture}, trials=${trials}`)
let escalated = 0
let researched = 0
for (let i = 1; i <= trials; i++) {
    // One child at a time, deliberately serial.
    const r = await trial(i)
    escalated += r.searched ? 1 : 0
    // Precondition: the child has to CONSULT docs before it can escalate FROM docs.
    // A trial where it never called docs at all measures nothing about escalation.
    researched += r.docs > 0 ? 1 : 0
}
console.log(`\nescalated to search in ${escalated}/${trials} trial(s)`)

reportArm({
    name: 'live-search-escalation-probe',
    arm: `probe/${fixture}`,
    reps: trials,
    targetShape:
        'a research worker escalating to pi-worker-search after the stubbed docs tool '
        + 'returns a real-shaped answer that lacks the requested fact',
    hits: escalated,
    witnessed: researched,
    expect: 'some',
    invariants: [
        {
            // Recorded at 5/5 on both fixtures; the seam is saturated, so anything
            // short of that is the regression this probe exists to catch.
            label: 'escalation is saturated (every trial escalates, as measured 2026-07-18)',
            ok: escalated === trials,
            detail: `${escalated}/${trials}`
        }
    ]
})
