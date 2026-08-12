/**
 * LIVE A/B against the real local model (llama-server @ 127.0.0.1:8080 via pi):
 * PROMPT 5 — YOLO MODE, the grill dialog seam (the one YOLO site the model is
 * actually in the loop for; the gate/final-gate sites are deterministic policy
 * over an unchanged model path and are covered by unit tests).
 *
 * Drives the REAL phaseGrill — real grill-gen children, real research-backed
 * auto-answers — over the verbatim mx5 run-13 TASK_0018 inputs (whose APIS
 * section lists ONLY Bun.build/Bun.spawn, the trap that produced the
 * `Bun.mkdirSync` hallucination).
 *
 *   baseline  — yoloMode OFF: today's behaviour. A surfaced question reaches
 *               SessionUI.ask.
 *   treatment — yoloMode ON: the site must take the recommendation (or skip)
 *               BEFORE the prompt is built.
 *
 * GROUND TRUTH, mechanical, never model self-report — the ctx is a fake whose
 * picker has NOTHING queued, so reaching it is observable two ways at once:
 * `captured.selects` records the attempt, and the unanswered picker makes
 * phaseGrill throw USER_CANCELLED. Per trial we record:
 *   promptsReached — captured.selects.length (MUST be 0 under YOLO)
 *   completed      — phaseGrill returned a transcript instead of throwing
 *   stamped        — every auto-picked answer line carries the (YOLO) marker
 *   promotedApi    — findSynthesizedApis flags an unverified API identifier in
 *                    an answer YOLO ACCEPTED (must be 0: the anti-synthesis
 *                    demotion has to come back as a skip, not an accept)
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-yolo-ab.ts <baseline|treatment> [TRIALS]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {phaseGrill} from '../src/task/phases.js'
import type {PhaseDeps} from '../src/task/child-runner.js'
import {USER_CANCELLED} from '../src/task/child-runner.js'
import {findSynthesizedApis} from '../src/task/api-synthesis.js'
import {reportArm} from './ab-verdict.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import {getConfig} from '../src/config/config.js'
import {YOLO_STAMP} from '../src/task/yolo.js'
import type {WidgetState} from '../src/task/widget.js'
import {requirePreconditions} from './ab-preflight.js'

const ROOT = '/home/edgars/tmp/yolo-ab'
const TRIAL_TIMEOUT_MS = 45 * 60_000

type Mode = 'baseline' | 'treatment'
type Fixture = 'api' | 'wiring'

const REFINED_18 = `GOAL
  Create \`build.ts\` at the project root that implements the client build pipeline: (1) run \`@tailwindcss/cli\` to compile \`src/client/index.css\` into \`dist/app.css\` using the exact command \`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css\`; (2) run \`Bun.build\` with entrypoints \`["src/client/main.tsx"]\`, output directory \`"dist"\`, and options \`minify\` and \`splitting\` enabled, producing the bundled JS/TSX artifacts. The file must be a standalone ESM module invocable via \`bun build.ts\` that performs both steps sequentially (CSS first, then JS).

CONSTRAINTS
  - File path must be exactly \`build.ts\` at the project root (matching the repo layout in §3 and the cross-slice contract \`"build.ts"\` [anchor: §3. Repo layout]).
  - Tailwind CLI invocation must use the exact command form pinned by the design: \`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css\` [anchor: §9. Build & run].
  - \`Bun.build\` options must include \`entrypoints: ["src/client/main.tsx"]\`, \`outdir: "dist"\`, \`minify\`, and \`splitting\` — exactly as specified in §9.
  - Do NOT create or modify \`src/client/main.tsx\`, \`src/client/index.css\`, or any other client source file — those are owned by steps 22+ and do not exist yet.
  - Do NOT modify \`tsconfig.json\` — it already includes \`"build.ts"\` in its \`include\` array (step 1).
  - Do NOT add a \`build\` script to \`package.json\` — that is step 21's job. This step only creates the \`build.ts\` file itself.
  - Preserve all existing \`package.json\` dependencies and devDependencies as-is; do not add or remove any entries.
  - Use \`Bun.spawn\` or \`Bun.exec\` (or equivalent Bun API) to invoke the Tailwind CLI subprocess, confirming the correct API against current Bun docs per the cross-cutting requirement to verify APIs before writing code.
  - The module must be ESM-compatible (\`verbatimModuleSyntax\` is enabled in tsconfig).

KNOWN-UNKNOWNS
  - Should \`build.ts\` create the \`dist/\` directory if it doesn't exist, or assume it already exists? (The design is silent; \`Bun.build\` typically creates \`outdir\` automatically, but \`@tailwindcss/cli\` may require the parent directory to exist.)
  - Should \`build.ts\` export any function(s) for programmatic reuse by later dev/watch scripts (step 21), or be purely a top-level script that runs on invocation? The design says "in \`build.ts\`" without specifying exports.
  - What error handling behavior is expected if the Tailwind CLI subprocess fails — should \`build.ts\` abort before running \`Bun.build\`, or let each step fail independently?`

const RESEARCH_18 = `FILES
tsconfig.json  TypeScript config confirming build.ts is in include list, ESM settings, verbatimModuleSyntax
package.json  Project dependencies including @tailwindcss/cli and @types/bun for type checking
DESIGN/PROJECT.md  Design spec defining the build pipeline requirements (§9 Build & run)
seed.ts  Existing pattern for ESM module with import.meta.main guard and top-level execution
bunfig.toml  Bun configuration that may affect build/test behavior
.gitignore  Confirms dist/ is excluded from version control, validating it as build output directory

APIS
Bun.build  (entrypoints: string[], outdir: string, minify?: boolean | MinifyOptions, splitting?: boolean) => Promise<BuildResult>
Bun.spawn  (cmd: string[], options?: SpawnOptions) => Subprocess<{stdin: Writable, stdout: Readable, stderr: Readable}>

CONTEXT
- \`tsconfig.json\` already includes \`"build.ts"\` in its \`include\` array, so TypeScript will type-check it; \`verbatimModuleSyntax: true\` means the file must use proper ESM syntax (no default imports without explicit interop).
- \`package.json\` has \`"type": "module"\`, confirming \`build.ts\` runs as ESM under Bun.
- \`@tailwindcss/cli\` is already a devDependency at version \`4.3.2\`.
- The Tailwind CLI invocation uses \`bunx\` (Bun's npx equivalent), which resolves \`@tailwindcss/cli\` from node_modules — no need to spawn \`npx\` or install globally.
- Per Bun subprocess API docs: \`Bun.spawn\` is async and preferred for apps; \`Bun.spawnSync\` blocks and is better for CLI tools — since \`build.ts\` runs sequentially (CSS then JS), either works, but \`Bun.spawn\` with await keeps it non-blocking-friendly.
- Per Bun bundler docs: \`Bun.build\` accepts \`minify\` as either \`true\` (boolean shorthand) or an object; the spec says just \`minify\` (likely boolean). Same for \`splitting\` — boolean enables code splitting.
- \`Bun.build\` creates the \`outdir\` automatically if it doesn't exist, but \`@tailwindcss/cli\` may require the parent directory of \`-o\` output to already exist — \`dist/\` may need to be created before the CSS step.
- No \`src/client/\` directory or files currently exist in the repo (only server-side code under \`src/server/\`, shared schema, and tests); \`build.ts\` must not create those client source files, only orchestrate the build of whatever exists at runtime.

VERIFIED-TOOLING
  eslint
  tsc --noEmit
  bun test`

const QUESTION_18 =
    'Should build.ts create the dist/ directory before running the Tailwind CLI (which may require it to exist), or assume it will already be present?'


// ─── Fixture 2: an INTEGRATION/wiring task ───────────────────────────────────
// The run-13 fixture above turned out to be auto-answerable end to end (the model
// ANSWERed all 3 questions, so no site ever reached the picker and the arms are
// indistinguishable on it). This second fixture targets the shipped SURFACING
// path instead: isIntegrationUnknown (a build/tooling surface + wiring intent)
// with research that grounds no external docs ⇒ phaseAutoAnswer refuses the guess
// and routes the question to the human. That is the state YOLO has to take over.

const REFINED_WIRE = `GOAL
  Wire the already-built client bundle into the existing Hono server so a browser
  request for the app is served by the same process that serves the API. The build
  step already emits \`dist/app.css\` and \`dist/main.js\`; this task is ONLY the
  serving/wiring layer inside \`src/server/index.ts\`.

CONSTRAINTS
  - Do NOT modify \`build.ts\`, \`src/client/**\`, or any API route handler.
  - The API routes already mounted under \`/api\` must keep working unchanged.
  - No new dependencies may be added; use what the server already imports.

VERIFY
  \`\`\`bash
  bun run build && bun run src/server/index.ts &
  sleep 2
  curl -sf http://localhost:3000/ | grep -q '<div id="root"'
  curl -sf http://localhost:3000/main.js | head -c 20
  \`\`\`
`

const RESEARCH_WIRE = `FILES
  - src/server/index.ts — creates the Hono app, mounts \`/api\` routes, exports default {fetch, port}.
  - build.ts — emits dist/app.css and dist/main.js (no HTML entry is produced).
  - package.json — scripts: build, dev, test. Dependencies: hono.

APIS
  (none verified — no documentation worker returned a grounded section for this task)

UNKNOWNS
  - How the built assets are meant to reach the browser: a static-file middleware,
    an explicit per-asset route, or a catch-all fallback — the design does not say.
`

// ─── Harness ─────────────────────────────────────────────────────────────────

function makeDeps(dir: string, abort: AbortController): PhaseDeps {
    const logPath = path.join(dir, 'trial.log')
    const log = (m: string): void => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    return {
        cwd: dir,
        taskId: 'TASK_AB',
        signal: abort.signal,
        onChildOutput: line => log(line),
        logDebug: msg => log(`[debug] ${msg}`)
    }
}

/** Answer lines the grill transcript recorded ("A1: …"). */
function answerLines(transcript: string): string[] {
    return transcript.split('\n').filter(l => /^A\d+:/.test(l))
}

interface TrialResult {
    trial: number
    promptsReached: number
    completed: boolean
    answers: number
    stamped: number
    accepted: number
    skipped: number
    promotedApi: number
    error?: string
}

async function runTrial(mode: Mode, fixture: Fixture, trial: number): Promise<TrialResult> {
    const [refined, research, question] =
        fixture === 'api' ?
            [REFINED_18, RESEARCH_18, QUESTION_18]
        :   [REFINED_WIRE, RESEARCH_WIRE, 'How should the built client assets be served?']
    const dir = path.join(ROOT, `${mode}-${fixture}`, `t${trial}`)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    // The flag is set IN-PROCESS only — the user's ~/.config/pi-task/config.json
    // is never written, so a crashed trial cannot leave a machine in yolo mode.
    getConfig().yoloMode = mode === 'treatment'

    const handle = makeFakeCtx(dir)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    const widgetState = {lastLine: ''} as WidgetState
    let transcript = ''
    let error: string | undefined
    try {
        transcript = await phaseGrill(
            makeDeps(dir, abort),
            handle.ctx,
            widgetState,
            refined,
            research
        )
    } catch (e) {
        error = e instanceof Error ? e.message : String(e)
    } finally {
        clearTimeout(timer)
    }

    const lines = answerLines(transcript)
    const stamped = lines.filter(l => l.includes(YOLO_STAMP)).length
    const skipped = lines.filter(l => /\(skipped —/.test(l)).length
    const accepted = lines.filter(l => l.includes(YOLO_STAMP) && !/\(skipped —/.test(l))
    // Did an ACCEPTED answer smuggle an unverified API identifier through? The
    // detector is the same one the shipped demotion uses, run over the research
    // this trial actually had.
    const promotedApi = accepted.filter(
        l => findSynthesizedApis(l.replace(/^A\d+:\s*/, ''), question, research).length > 0
    ).length

    fs.writeFileSync(path.join(dir, 'transcript.txt'), transcript)
    const res: TrialResult = {
        trial,
        promptsReached: handle.captured.selects.length,
        completed: error === undefined,
        answers: lines.length,
        stamped,
        accepted: accepted.length,
        skipped,
        promotedApi,
        ...(error !== undefined && {error})
    }
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(res, null, 2))
    console.log(
        `[${mode}/${fixture} t${trial}] prompts=${res.promptsReached} completed=${res.completed} `
            + `answers=${res.answers} stamped=${res.stamped} accepted=${res.accepted} `
            + `skipped=${res.skipped} promotedApi=${res.promotedApi}`
            + (error !== undefined ? ` error=${error === USER_CANCELLED ? 'USER_CANCELLED (prompt reached, nothing queued)' : error}` : '')
    )
    return res
}

async function main(): Promise<void> {
    await requirePreconditions('live-yolo-ab', {model: {}, piBin: true, cacheOff: true})
    const mode = process.argv[2] as Mode
    if (mode !== 'baseline' && mode !== 'treatment') {
        console.error('usage: PI_BIN=$(command -v pi) bun run scripts/live-yolo-ab.ts <baseline|treatment> [api|wiring] [TRIALS]')
        process.exit(1)
    }
    const fixture = (process.argv[3] ?? 'wiring') as Fixture
    if (fixture !== 'api' && fixture !== 'wiring') {
        console.error('fixture must be api|wiring')
        process.exit(1)
    }
    const trials = parseInt(process.argv[4] ?? '3', 10)
    const results: TrialResult[] = []
    for (let t = 1; t <= trials; t++) results.push(await runTrial(mode, fixture, t))
    const sum = (f: (r: TrialResult) => number): number => results.reduce((a, r) => a + f(r), 0)
    console.log(
        `\n[${mode}/${fixture}] ${results.length} trials — prompts reached ${sum(r => r.promptsReached)}, `
            + `completed ${results.filter(r => r.completed).length}/${results.length}, `
            + `answers ${sum(r => r.answers)} (stamped ${sum(r => r.stamped)}, `
            + `accepted ${sum(r => r.accepted)}, skipped ${sum(r => r.skipped)}), `
            + `promoted-API ${sum(r => r.promotedApi)}`
    )
    fs.writeFileSync(path.join(ROOT, `${mode}-${fixture}.json`), JSON.stringify(results, null, 2))

    // A trial where the grill surfaced no question at all cannot distinguish "YOLO
    // answered it before the prompt" from "there was nothing to answer".
    const trialsWithQuestions = results.filter(r => r.answers > 0 || r.promptsReached > 0).length
    reportArm({
        name: 'live-yolo-ab',
        arm: `${mode}/${fixture}`,
        reps: results.length,
        targetShape: 'a grill question reaching SessionUI.ask (captured.selects records the attempt)',
        hits: results.filter(r => r.promptsReached > 0).length,
        witnessed: trialsWithQuestions,
        expect: mode === 'baseline' ? 'some' : 'none',
        invariants: [
            {
                // The anti-synthesis demotion must come back as a skip, never an accept.
                label: 'no unverified API identifier survives in a YOLO-ACCEPTED answer',
                ok: sum(r => r.promotedApi) === 0,
                detail: `${sum(r => r.promotedApi)} promoted`
            },
            {
                label: 'every YOLO-picked answer carries the (YOLO) stamp',
                ok: mode === 'baseline' || sum(r => r.stamped) === sum(r => r.accepted),
                detail: `${sum(r => r.stamped)} stamped of ${sum(r => r.accepted)} accepted`
            }
        ]
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
