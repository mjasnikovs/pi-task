/**
 * LIVE A/B against the real local model (llama-server @ 127.0.0.1:8080 via pi):
 * PROMPT 3 of the run-13 report — both model-facing seams.
 *
 * SEAM A (grill auto-answer anti-synthesis, Bug A): the verbatim mx5 TASK_0018
 * incident inputs — refined task + research whose APIS section lists ONLY
 * Bun.build/Bun.spawn, and the KNOWN-UNKNOWN question whose tempting answer is
 * the non-existent `Bun.mkdirSync` — plus a second synthetic fixture with the
 * same trap shape (Bun.copyFileSync vs a Bun.file/Bun.write research).
 *
 *   answer-baseline  — the pre-change flow: GRILL_AUTO_ANSWER_PROMPT with the
 *                      new API-GROUNDING RULE stripped (string surgery,
 *                      asserted), format-hint reprompt, parseAutoAnswer — no
 *                      guard.
 *   answer-treatment — the REAL phaseAutoAnswer as now shipped (belt + the
 *                      findSynthesizedApis re-ask guard).
 *
 * Metric per answer, mechanical (never model self-report): PROMOTED-
 * HALLUCINATION = answer kind is 'answered' AND findSynthesizedApis flags an
 * API-shaped identifier absent from research+question in a research-covered
 * namespace. Surfaced-as-UNKNOWN counts as NOT promoted (the guard's win
 * condition is exactly: cost a user question, never promote an invention).
 *
 * SEAM B (grep-theater VERIFY, Bug B): compose+critique on the verbatim
 * TASK_0018 inputs (including the promoted hallucinated A1, as in the
 * incident) over a fixture repo mirroring the mx5 tree at that step.
 *
 *   verify-baseline  — compose with the new runnable-deliverable VERIFY rule
 *                      stripped from COMPOSE_PROMPT (asserted) + the critique
 *                      flow EXACTLY as shipped before this change (all prior
 *                      probes, NO grep-theater probe).
 *   verify-treatment — the REAL phaseCompose + phaseCritique as now shipped.
 *
 * Metric per trial: findGrepOnlyVerify(delivered spec) — does the shipped
 * VERIFY block never execute the runnable deliverable it grep-asserts.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-api-synthesis-ab.ts \
 *        <answer-baseline|answer-treatment|verify-baseline|verify-treatment> [TRIALS]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {phaseAutoAnswer, phaseCompose} from '../src/task/phases.js'
import {phaseCritique} from '../src/task/phases.js'
import {
    runPhaseChild,
    runWithEmphasisRetry,
    prependHint,
    type PhaseDeps
} from '../src/task/child-runner.js'
import {
    GRILL_AUTO_ANSWER_PROMPT,
    GRILL_AUTO_FORMAT_HINT,
    COMPOSE_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT,
    appendNoThink
} from '../src/task/prompts.js'
import {parseAutoAnswer, autoAnswerHasTag, type AutoAnswer} from '../src/task/parsers.js'
import {
    parseVerifyBlock,
    stripSpecPreamble,
    isCritiqueClean
} from '../src/task/spec-validation.js'
import {findSkipEscapes, skipEscapeDefectText} from '../src/task/skip-escape.js'
import {findAbsenceConflicts, absenceProbeText} from '../src/task/verify-reconcile.js'
import {findFrozenPathConflicts, frozenConflictProbeText} from '../src/task/frozen-conflict.js'
import {findSynthesizedApis} from '../src/task/api-synthesis.js'
import {reportArm} from './ab-verdict.js'
import {findGrepOnlyVerify} from '../src/task/verify-quality.js'
import {requirePreconditions} from './ab-preflight.js'

const ROOT = '/home/edgars/tmp/api-synthesis-ab'
const TRIAL_TIMEOUT_MS = 30 * 60_000

// ─── SEAM A fixtures ─────────────────────────────────────────────────────────
// Fixture 1 is the mx5 TASK_0018 incident, verbatim (.pi-tasks/TASK_0018.md).

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

// Fixture 2: same trap shape, synthetic — research covers Bun.file/Bun.write,
// the tempting answer is a sync-fs-style `Bun.copyFileSync` / `Bun.cpSync`.
const REFINED_CP = `GOAL
  Extend \`build.ts\` so that after bundling it copies every file in \`public/\` (favicon.ico, robots.txt, fonts/) into \`dist/\` unchanged, preserving the directory structure. The copy step must use Bun APIs (no shelling out to \`cp\`), run after the JS bundle step, and be invocable via \`bun build.ts\`.

CONSTRAINTS
  - Use Bun APIs for the copy, not a subprocess.
  - Do NOT modify anything under \`public/\` — it is read-only input.
  - Preserve nested directory structure (\`public/fonts/inter.woff2\` → \`dist/fonts/inter.woff2\`).

KNOWN-UNKNOWNS
  - How should the static-asset copy step copy each file from public/ into dist/ using Bun APIs?`

const RESEARCH_CP = `FILES
build.ts  Existing build script with the Tailwind and Bun.build steps
public/  Static assets directory (favicon.ico, robots.txt, fonts/)

APIS
Bun.file  (path: string) => BunFile — lazy file reference with .exists(), .arrayBuffer(), .stream()
Bun.write  (dest: string | BunFile, input: Blob | string | BunFile | ArrayBuffer) => Promise<number> — writes/copies content, creating parent directories automatically
Bun.Glob  (pattern: string) => Glob — .scan(dir) async-iterates matching relative paths

CONTEXT
- \`Bun.write(dest, Bun.file(src))\` is the documented Bun idiom for copying a file; it creates missing parent directories automatically.
- \`new Bun.Glob("**/*").scan("public")\` yields every file path under public/ relative to it.

VERIFIED-TOOLING
  tsc --noEmit
  bun test`

const QUESTION_CP =
    'How should the static-asset copy step copy each file from public/ into dist/ — is there a single Bun call that copies a file directly?'

interface AnswerFixture {
    name: string
    refined: string
    research: string
    question: string
}

const ANSWER_FIXTURES: AnswerFixture[] = [
    {name: 'mkdir-18', refined: REFINED_18, research: RESEARCH_18, question: QUESTION_18},
    {name: 'copy-cp', refined: REFINED_CP, research: RESEARCH_CP, question: QUESTION_CP}
]

// ─── SEAM B fixtures: the TASK_0018 compose inputs, verbatim ────────────────

const QA_18 = `Q1: Should build.ts create the dist/ directory before running the Tailwind CLI (which may require it to exist), or assume it will already be present?
A1: create the dist/ directory before running the Tailwind CLI using Bun.mkdirSync with { recursive: true } to ensure it exists (auto)
Q2: Should build.ts export any function(s) for programmatic reuse by later dev/watch scripts, or be purely a top-level script that runs on invocation?
A2: be purely a top-level script that runs on invocation (auto)`

// ─── Fixture repo (compose/critique children run with `read`) ───────────────

function buildFixture(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(path.join(dir, 'src', 'server'), {recursive: true})
    fs.mkdirSync(path.join(dir, 'DESIGN'), {recursive: true})
    const w = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content)
    w(
        'package.json',
        JSON.stringify(
            {
                name: 'mx5-fixture',
                private: true,
                type: 'module',
                scripts: {lint: 'eslint . && tsc --noEmit', test: 'bun test'},
                devDependencies: {'@tailwindcss/cli': '4.3.2', '@types/bun': '1.3.9'}
            },
            null,
            4
        ) + '\n'
    )
    w(
        'tsconfig.json',
        JSON.stringify(
            {
                compilerOptions: {
                    strict: true,
                    target: 'ESNext',
                    verbatimModuleSyntax: true,
                    moduleResolution: 'bundler',
                    types: ['bun']
                },
                include: ['src', 'build.ts', 'seed.ts']
            },
            null,
            4
        ) + '\n'
    )
    w('bunfig.toml', '[test]\nroot = "src"\n')
    w('.gitignore', 'node_modules/\ndist/\n')
    w('seed.ts', 'if (import.meta.main) console.log("seed")\n')
    w('src/server/index.ts', 'export const server = true\n')
    w(
        'DESIGN/PROJECT.md',
        [
            '# mx5 project',
            '',
            '## §3. Repo layout',
            '`build.ts` at project root; client sources under `src/client/`; output in `dist/`.',
            '',
            '## §9. Build & run',
            'Client CSS: `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`.',
            'Client JS: `Bun.build({ entrypoints: ["src/client/main.tsx"], outdir: "dist", minify, splitting })`.'
        ].join('\n')
    )
}

// ─── Pre-change arms (string surgery on the shipped prompts, asserted) ──────

const GRILL_BELT_MARKER = 'API-GROUNDING RULE:'
const COMPOSE_BELT_MARKER = '- Runnable deliverables (a build script, server, CLI'

/** Remove the paragraph/line starting at `marker` (through its terminating blank line / newline). */
function stripBeltParagraph(prompt: string, marker: string, wholeParagraph: boolean): string {
    const i = prompt.indexOf(marker)
    if (i < 0) throw new Error(`belt marker not found — surgery would be a no-op: ${marker}`)
    const end =
        wholeParagraph ?
            prompt.indexOf('\n\n', i)
        :   prompt.indexOf('\n', i)
    if (end < 0) throw new Error('belt paragraph end not found')
    return prompt.slice(0, i) + prompt.slice(end + (wholeParagraph ? 2 : 1))
}

/** phaseAutoAnswer EXACTLY as shipped before this change: no belt, no guard. */
async function autoAnswerBaseline(
    deps: PhaseDeps,
    refined: string,
    research: string,
    question: string
): Promise<AutoAnswer> {
    const basePrompt = stripBeltParagraph(
        GRILL_AUTO_ANSWER_PROMPT(refined, research, question),
        GRILL_BELT_MARKER,
        true
    )
    let text = await runPhaseChild(deps, 'grill-auto', 'read', basePrompt)
    if (!autoAnswerHasTag(text)) {
        text = await runPhaseChild(
            deps,
            'grill-auto',
            'read',
            prependHint(GRILL_AUTO_FORMAT_HINT, basePrompt)
        )
    }
    return parseAutoAnswer(text)
}

/** phaseCompose as shipped before this change: runnable-deliverable rule stripped. */
async function composeBaseline(
    deps: PhaseDeps,
    refined: string,
    research: string,
    qa: string
): Promise<string> {
    return runWithEmphasisRetry(
        deps,
        'compose',
        'read',
        problem =>
            stripBeltParagraph(
                COMPOSE_PROMPT(refined, research, qa, problem, ''),
                COMPOSE_BELT_MARKER,
                false
            ),
        text => {
            const stripped = stripSpecPreamble(text)
            if (parseVerifyBlock(stripped) === null) {
                return {ok: false, problem: 'VERIFY block has no runnable ```bash fenced commands'}
            }
            return {ok: true, value: stripped}
        },
        problem => new Error(`compose_invalid: ${problem}`)
    )
}

/** phaseCritique EXACTLY as shipped before this change (no grep-theater probe). */
async function critiqueBaseline(
    deps: PhaseDeps,
    spec: string,
    refined: string,
    qa: string,
    research: string
): Promise<string> {
    const skipEscapes = findSkipEscapes(spec)
    const skipDefects = skipEscapes.length > 0 ? skipEscapeDefectText(skipEscapes) : null
    const absenceConflicts = findAbsenceConflicts(spec, {
        fileExists: () => false,
        siblingTitles: [],
        contracts: ''
    })
    const absenceProbe = absenceConflicts.length > 0 ? absenceProbeText(absenceConflicts) : null
    const frozenConflicts = findFrozenPathConflicts(spec, research)
    const frozenProbe =
        frozenConflicts.length > 0 ? frozenConflictProbeText(frozenConflicts) : null
    let triageDefects: string | null = null
    if (parseVerifyBlock(spec) !== null) {
        let verdict: string | null
        try {
            verdict = await runPhaseChild(
                deps,
                'critique-triage',
                '',
                appendNoThink(CRITIQUE_TRIAGE_PROMPT(spec, refined, qa, ''))
            )
        } catch {
            verdict = null
        }
        if (verdict !== null) {
            if (isCritiqueClean(verdict)) {
                if (skipDefects === null && absenceProbe === null && frozenProbe === null) {
                    return spec
                }
            } else {
                triageDefects = verdict.trim()
            }
        }
    }
    const rewriteDefects =
        [skipDefects, absenceProbe, frozenProbe, triageDefects].filter(Boolean).join('\n\n')
        || null
    return runWithEmphasisRetry(
        deps,
        'critique',
        'read',
        problem => CRITIQUE_PROMPT(spec, refined, qa, problem !== null, rewriteDefects, ''),
        text => {
            const stripped = stripSpecPreamble(text)
            return parseVerifyBlock(stripped) ?
                    {ok: true, value: stripped}
                :   {ok: false, problem: 'no_verify_block'}
        },
        () => new Error('no_verify_block')
    )
}

// ─── Trials ──────────────────────────────────────────────────────────────────

type Mode = 'answer-baseline' | 'answer-treatment' | 'verify-baseline' | 'verify-treatment'

function makeDeps(dir: string, abort: AbortController): PhaseDeps {
    const logPath = path.join(dir, 'trial.log')
    const log = (m: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    return {
        cwd: dir,
        taskId: 'TASK_AB',
        signal: abort.signal,
        onChildOutput: line => log(line),
        logDebug: msg => log(`[debug] ${msg}`)
    }
}

/** Per-fixture outcome: `completed` is the precondition, `hit` the target shape. */
type TrialTally = {completed: number; hit: number}

async function runAnswerTrial(mode: Mode, n: number, tally: TrialTally): Promise<void> {
    for (const fx of ANSWER_FIXTURES) {
        const dir = path.join(ROOT, `${mode}-${fx.name}-t${n}`)
        buildFixture(dir)
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
        try {
            const deps = makeDeps(dir, abort)
            const parsed =
                mode === 'answer-baseline' ?
                    await autoAnswerBaseline(deps, fx.refined, fx.research, fx.question)
                :   await phaseAutoAnswer(deps, fx.refined, fx.research, fx.question)
            const answerText =
                parsed.kind === 'answered' ? parsed.text : (parsed.suggested ?? '')
            const synth =
                parsed.kind === 'answered' ?
                    findSynthesizedApis(parsed.text, fx.question, fx.research)
                :   []
            const promoted = parsed.kind === 'answered'
            const hallucinated = synth.length > 0
            fs.writeFileSync(
                path.join(dir, 'result.json'),
                JSON.stringify(
                    {
                        fixture: fx.name,
                        promoted,
                        hallucinated,
                        identifiers: synth.map(s => s.identifier),
                        kind: parsed.kind,
                        answer: answerText,
                        raw: parsed.raw
                    },
                    null,
                    2
                )
            )
            tally.completed++
            if (promoted && hallucinated) tally.hit++
            console.log(
                `[${mode} ${fx.name} t${n}] kind=${parsed.kind}`
                    + ` promoted-hallucination=${promoted && hallucinated}`
                    + (synth.length > 0 ? ` [${synth.map(s => s.identifier).join(', ')}]` : '')
                    + ` | ${answerText.replace(/\s+/g, ' ').slice(0, 110)}`
            )
        } catch (e) {
            console.log(`[${mode} ${fx.name} t${n}] ERROR: ${String(e).slice(0, 160)}`)
        } finally {
            clearTimeout(timer)
        }
    }
}

async function runVerifyTrial(mode: Mode, n: number, tally: TrialTally): Promise<void> {
    const dir = path.join(ROOT, `${mode}-t${n}`)
    buildFixture(dir)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    try {
        const deps = makeDeps(dir, abort)
        const draft =
            mode === 'verify-baseline' ?
                await composeBaseline(deps, REFINED_18, RESEARCH_18, QA_18)
            :   await phaseCompose(deps, REFINED_18, RESEARCH_18, QA_18)
        fs.writeFileSync(path.join(dir, 'draft.spec.md'), draft)
        const draftTheater = findGrepOnlyVerify(draft).length > 0
        const final =
            mode === 'verify-baseline' ?
                await critiqueBaseline(deps, draft, REFINED_18, QA_18, RESEARCH_18)
            :   await phaseCritique(deps, draft, REFINED_18, QA_18, undefined, RESEARCH_18)
        fs.writeFileSync(path.join(dir, 'final.spec.md'), final)
        const finalFindings = findGrepOnlyVerify(final)
        const cmds = parseVerifyBlock(final) ?? []
        const executesDeliverable = cmds.some(c => /\bbun\s+(run\s+)?build(\.ts)?\b/.test(c.raw))
        // Precondition: a spec with a real VERIFY block actually came out the far
        // end. Judging "no theater" on a spec that has no VERIFY block is vacuous.
        if (cmds.length > 0) tally.completed++
        if (finalFindings.length > 0) tally.hit++
        console.log(
            `[${mode} t${n}] draft-theater=${draftTheater}`
                + ` | FINAL-theater=${finalFindings.length > 0}`
                + ` | final executes build=${executesDeliverable}`
                + (finalFindings.length > 0 ?
                    ` [${finalFindings.map(f => f.target).join(', ')}]`
                :   '')
        )
    } catch (e) {
        console.log(`[${mode} t${n}] ERROR: ${String(e).slice(0, 160)}`)
    } finally {
        clearTimeout(timer)
    }
}

async function main(): Promise<void> {
    await requirePreconditions('live-api-synthesis-ab', {model: {}, piBin: true, cacheOff: true})
    const mode = process.argv[2] as Mode
    const modes: Mode[] = [
        'answer-baseline',
        'answer-treatment',
        'verify-baseline',
        'verify-treatment'
    ]
    if (!modes.includes(mode)) {
        console.error(
            'usage: PI_BIN=$(command -v pi) bun run scripts/live-api-synthesis-ab.ts '
                + '<answer-baseline|answer-treatment|verify-baseline|verify-treatment> [TRIALS]'
        )
        process.exit(1)
    }
    const trials = parseInt(process.argv[3] ?? '5', 10)
    const answering = mode.startsWith('answer')
    const tally: TrialTally = {completed: 0, hit: 0}
    for (let t = 1; t <= trials; t++) {
        if (answering) await runAnswerTrial(mode, t, tally)
        else await runVerifyTrial(mode, t, tally)
    }

    // The answer arm runs every fixture per trial, so its denominator is trials ×
    // fixtures; the verify arm is one spec per trial.
    const reps = answering ? trials * ANSWER_FIXTURES.length : trials
    reportArm({
        name: 'live-api-synthesis-ab',
        arm: mode,
        reps,
        targetShape:
            answering ?
                'an ACCEPTED answer promoting an API identifier that appears nowhere in '
                + 'the research (the Bun.mkdirSync class)'
            :   'grep-only VERIFY theater surviving into the delivered spec',
        hits: tally.hit,
        witnessed: tally.completed,
        expect: mode.endsWith('baseline') ? 'some' : 'none'
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
