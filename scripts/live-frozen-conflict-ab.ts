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
 * LIVE A/B against the real local model (llama-server @ 127.0.0.1:8080 via pi):
 * the compose/critique pipeline vs the UNSATISFIABLE freeze/requires-edit pair
 * (mx5 run 12 root cause, PROMPT 1 layer A).
 *
 * Reproduces the mx5 TASK_0020 incident inputs VERBATIM: the refined task whose
 * CONSTRAINTS carry the design's blanket freeze ("Do not modify `tsconfig.json`,
 * `eslint.config.js`, or `.prettierrc.cjs`; those are handled in steps 1–2"),
 * the research whose FILES/CONTEXT sections state the created files "must also
 * be included" in tsconfig / "won't be type-checked unless added", and the real
 * grill Q&A. Per trial a fresh fixture repo matching those claims is built and
 * the REAL phase functions run with a REAL pi child:
 *
 *   baseline  — compose (real phaseCompose) + the critique flow EXACTLY as
 *               shipped before this change (triage → CLEAN short-circuit or
 *               rewrite; same skip-escape/absence probes, NO frozen probe)
 *   treatment — compose (real phaseCompose) + the REAL phaseCritique as now
 *               shipped (the frozen-conflict probe forces the rewrite)
 *
 * Measured per trial, ALL grounded in deterministic extraction over the spec
 * text (findFrozenPathConflicts / extractProhibitions) — never in the model's
 * self-report:
 *   - draft pair:  does the compose draft carry the unsatisfiable pair
 *   - final pair:  does the delivered spec still carry it (the A/B metric)
 *   - resolution shape when resolved: scoped ownership (freeze carries an
 *     exception clause / tsconfig no longer frozen, creation kept) vs dropped
 *     creation (spec no longer creates the ct files)
 *
 * Compose does NOT always echo the requires-edit statement into the draft
 * (observed live: some drafts keep the blanket freeze + creation but drop the
 * research nuance — no textual pair, same eventual repo-red). So the script
 * also has a CONTROLLED critique-seam pair of modes, where the draft is FIXED
 * to the real mx5 TASK_0020 spec section verbatim (which carries the pair):
 *
 *   critique-baseline  — fixed pair-carrying draft → pre-change critique flow
 *   critique-treatment — fixed pair-carrying draft → real phaseCritique (probe)
 *
 * That isolates the model-behavior question the lever must win: given the pair
 * in the draft, does the forced finding make the rewrite actually resolve it?
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-frozen-conflict-ab.ts <baseline|treatment|critique-baseline|critique-treatment> [TRIALS]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {existsSync} from 'node:fs'
import {resolve} from 'node:path'
import {phaseCompose, phaseCritique} from '../src/task/phases.js'
import {reportArm} from './ab-verdict.js'
import {
    runPhaseChild,
    runWithEmphasisRetry,
    type PhaseDeps
} from '../src/task/child-runner.js'
import {CRITIQUE_PROMPT, CRITIQUE_TRIAGE_PROMPT} from '../src/task/prompts.js'
import {
    parseVerifyBlock,
    stripSpecPreamble,
    isCritiqueClean
} from '../src/task/spec-validation.js'
import {findSkipEscapes, skipEscapeDefectText} from '../src/task/skip-escape.js'
import {findAbsenceConflicts, absenceProbeText} from '../src/task/verify-reconcile.js'
import {findFrozenPathConflicts} from '../src/task/frozen-conflict.js'
import {extractProhibitions} from '../src/task/prohibition-probe.js'
import {requirePreconditions} from './ab-preflight.js'

const ROOT = '/home/edgars/tmp/frozen-conflict-ab'
const TRIAL_TIMEOUT_MS = 30 * 60_000

// ─── The incident inputs, verbatim from mx5 .pi-tasks/TASK_0020.md ───────────

const REFINED = `GOAL
  Create the Playwright React component-testing configuration file \`playwright-ct.config.ts\` at project root and establish the \`__screenshots__/\` directory as the visual baseline location for \`toHaveScreenshot\` comparisons. The config must use \`@playwright/experimental-ct-react\` (already listed in devDependencies as version \`1.61.1\`), target React 19 components, and be referenced by the future \`test:ct\` script (\`playwright test -c playwright-ct.config.ts\`) per §10 of the spec.

CONSTRAINTS
  - The config file path must be exactly \`playwright-ct.config.ts\` (cross-slice contract from §10 Testing — Client/component tests).
  - The visual baseline directory must be exactly \`__screenshots__/\` (cross-slice contract from §10 Testing — Client/component tests).
  - Do not create any \`.spec.tsx\` test files in this step; those belong to steps 23–32 which each own their component/page tests.
  - Do not modify \`package.json\` scripts here; the \`test:ct\` script is added in step 21.
  - Do not modify \`tsconfig.json\`, \`eslint.config.js\`, or \`.prettierrc.cjs\`; those are handled in steps 1–2.
  - Preserve all existing devDependencies including \`@playwright/experimental-ct-react: 1.61.1\` and \`playwright: 1.61.1\`.
  - Do not install or run Playwright browsers in this step; that is an operational concern outside the scope of configuration setup.
  - The config must be compatible with the existing TypeScript strict settings (verbatimModuleSyntax, ESNext target) and the single-project flat layout under \`src/\`.`

const RESEARCH = `FILES
playwright-ct.config.ts  Playwright React component-testing config file to be created at project root
__screenshots__/  Visual baseline directory for toHaveScreenshot comparisons at project root
tsconfig.json:18  Existing tsconfig include list already references \`playwright.config.ts\` — new \`playwright-ct.config.ts\` must also be included for type-checking compatibility
package.json  DevDependencies listing \`@playwright/experimental-ct-react: 1.61.1\` and \`playwright: 1.61.1\` that the config imports from
DESIGN/PROJECT.md:209  §10 Testing contract specifying \`playwright-ct.config.ts\` and \`__screenshots__/\` as cross-slice paths

APIS
defineConfig  Import from \`@playwright/experimental-ct-react\`, accepts a \`PlaywrightTestConfig\` object and returns it — used as \`export default defineConfig({...})\` in \`playwright-ct.config.ts\`
snapshotPathTemplate  String template on \`TestConfig\` controlling snapshot file paths

CONTEXT
- \`tsconfig.json\` already includes \`"playwright.config.ts"\` in its \`include\` array but NOT \`playwright-ct.config.ts\` — the new config file won't be type-checked unless added to \`include\`, however the task constraints forbid modifying \`tsconfig.json\` (handled in steps 1–2), so the agent must accept that \`playwright-ct.config.ts\` will not be covered by the project's \`tsc --noEmit\` check at this step.
- The project uses \`"type": "module"\` and \`"verbatimModuleSyntax": true\` — imports in \`playwright-ct.config.ts\` must use static \`import\` syntax.
- The project has no existing \`playwright/\` directory (no \`playwright/index.html\` or \`playwright/index.ts\`) — Playwright CT requires these scaffold files for rendering components; the config must reference them via \`ctTemplateDir: './playwright'\` or equivalent, meaning those files also need to exist.
- The \`__screenshots__/\` directory per DESIGN/PROJECT.md §10 is at project root level — the config must set \`snapshotPathTemplate\` to place baselines there.

VERIFIED-TOOLING
  bunx eslint .
  bunx tsc --noEmit
  bun test`

const QA = `Q1: Should the config include the mandatory Playwright CT scaffold files (playwright/index.html and playwright/index.ts) alongside playwright-ct.config.ts, or are those handled in a separate step?
A1: include them now, because configuring Playwright CT requires them—without playwright/index.html and playwright/index.ts, the config's ctTemplateDir reference is broken and playwright test -c playwright-ct.config.ts cannot render any component (auto)
Q2: Should the __screenshots__/ directory be created at project root (i.e., ./__screenshots__/) with a .gitkeep file to ensure it is tracked by Git, or should it be left uncreated for now since no test files exist yet to generate snapshots?
A2: create the directory at project root with a .gitkeep file so it is tracked by Git immediately (auto)`

// The REAL mx5 TASK_0020 delivered spec, verbatim (.pi-tasks/TASK_0020.md ## spec)
// — the pair-carrying draft for the controlled critique-seam modes: blanket
// freeze + prose surrender ("Accept that … will not be covered … since
// `tsconfig.json` is not modified") + the creation the surrender is about.
const MX5_DRAFT = `GOAL
  Create the Playwright React component-testing configuration file \`playwright-ct.config.ts\` at project root along with the mandatory CT scaffold files (\`playwright/index.html\`, \`playwright/index.ts\`) and the visual baseline directory \`__screenshots__/\` with a \`.gitkeep\` placeholder. The config must import \`defineConfig\` from \`@playwright/experimental-ct-react\` (v1.61.1), target React 19 components, set \`snapshotPathTemplate\` to route all screenshots into \`__screenshots__/\`, and be ready for the future \`test:ct\` script (\`playwright test -c playwright-ct.config.ts\`) per §10 of the spec.

CONSTRAINTS
  - The config file path must be exactly \`playwright-ct.config.ts\` at project root (cross-slice contract from §10 Testing — Client/component tests).
  - The visual baseline directory must be exactly \`__screenshots__/\` at project root (cross-slice contract from §10 Testing — Client/component tests).
  - The scaffold directory must be exactly \`playwright/\` at project root containing \`index.html\` and \`index.ts\` (required by \`ctTemplateDir\`).
  - Do not create any \`.spec.tsx\` test files in this step; those belong to steps 23–32 which each own their component/page tests.
  - Do not modify \`package.json\` scripts here; the \`test:ct\` script is added in step 21.
  - Do not modify \`tsconfig.json\`, \`eslint.config.js\`, or \`.prettierrc.cjs\`; those are handled in steps 1–2.
  - Preserve all existing devDependencies including \`@playwright/experimental-ct-react: 1.61.1\` and \`playwright: 1.61.1\`.
  - Do not install or run Playwright browsers in this step; that is an operational concern outside the scope of configuration setup.
  - Import \`defineConfig\` from \`@playwright/experimental-ct-react\`, not from \`@playwright/test\`, to get React-specific types and fixtures.
  - Accept that \`playwright-ct.config.ts\` will not be covered by \`tsc --noEmit\` since \`tsconfig.json\` is not modified in this step; no error should be raised about this.
  - Do not add \`__screenshots__/\` to \`.gitignore\`; baseline images must be tracked by Git.

ACCEPTANCE
  - \`playwright-ct.config.ts\` exists at project root, imports \`defineConfig\` from \`@playwright/experimental-ct-react\`, and exports a default config object with \`snapshotPathTemplate\` pointing to \`__screenshots__/\`.
  - \`playwright/index.html\` exists at project root with a \`<div id="root">\` element for component rendering.
  - \`playwright/index.ts\` exists at project root as the CT entry-point script (minimal import of the HTML template).
  - \`__screenshots__/\` directory exists at project root and contains a \`.gitkeep\` file so it is tracked by Git.
  - No \`.spec.tsx\` test files were created in this step.
  - \`package.json\`, \`tsconfig.json\`, \`eslint.config.js\`, and \`.prettierrc.cjs\` remain unmodified.
  - Existing lint (\`bunx eslint .\`) and type-check (\`bunx tsc --noEmit\`) commands continue to pass without errors introduced by the new files, excluding the new \`playwright-ct.config.ts\` and \`playwright/\` files which are intentionally outside the existing tsconfig/eslint scope.

VERIFY:
\`\`\`sh
test -f playwright-ct.config.ts && grep -q '@playwright/experimental-ct-react' playwright-ct.config.ts && grep -q '__screenshots__' playwright-ct.config.ts
test -f playwright/index.html && grep -q '<div id="root">' playwright/index.html
test -f playwright/index.ts
test -d __screenshots__ && test -f __screenshots__/.gitkeep
bunx tsc --noEmit
bunx eslint . --ignore-pattern 'playwright-ct.config.ts' --ignore-pattern 'playwright/'
\`\`\``

// ─── Fixture repo matching the research claims (compose runs with `read`) ────

function buildFixture(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
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
                devDependencies: {
                    '@playwright/experimental-ct-react': '1.61.1',
                    playwright: '1.61.1'
                }
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
                    moduleResolution: 'bundler'
                },
                include: ['src', 'build.ts', 'playwright.config.ts', 'seed.ts']
            },
            null,
            4
        ) + '\n'
    )
    w('eslint.config.js', 'export default [/* typed eslint, parserOptions.project */]\n')
    w('.prettierrc.cjs', 'module.exports = {}\n')
    w('playwright.config.ts', 'export default {testDir: "./test"}\n')
    w('build.ts', 'console.log("build")\n')
    w('seed.ts', 'console.log("seed")\n')
    w('src/app.ts', 'export const app = true\n')
    w(
        'DESIGN/PROJECT.md',
        [
            '# mx5 project',
            '',
            '## Build steps',
            '1. **Scaffold** — single-package setup (package.json, tsconfig), ESLint + Prettier config.',
            '2. **Lint/format baseline** — eslint.config.js, .prettierrc.cjs finalized.',
            '20. **Playwright CT scaffold** — playwright-ct.config.ts, playwright/ template dir.',
            '',
            '## §10 Testing — Client/component tests',
            'Component tests use `playwright-ct.config.ts` at project root; visual baselines',
            'are committed under `__screenshots__/`.'
        ].join('\n')
    )
}

// ─── The pre-change critique flow (baseline arm) ─────────────────────────────
// Verbatim structure of phaseCritique BEFORE the frozen-conflict probe landed:
// same triage, same CLEAN short-circuit, same skip-escape/absence probes, same
// rewrite — only the frozen probe is absent. Registry/contracts are empty in
// the fixture, so the wiring probe (registry-gated) is a no-op exactly as it
// would have been live.
async function critiqueBaseline(
    deps: PhaseDeps,
    spec: string,
    refined: string,
    qa: string
): Promise<string> {
    const skipEscapes = findSkipEscapes(spec)
    const skipDefects = skipEscapes.length > 0 ? skipEscapeDefectText(skipEscapes) : null
    const absenceConflicts = findAbsenceConflicts(spec, {
        fileExists: p => existsSync(resolve(deps.cwd, p)),
        siblingTitles: [],
        contracts: ''
    })
    const absenceProbe = absenceConflicts.length > 0 ? absenceProbeText(absenceConflicts) : null
    let triageDefects: string | null = null
    if (parseVerifyBlock(spec) !== null) {
        let verdict: string | null
        try {
            verdict = await runPhaseChild(
                deps,
                'critique-triage',
                '',
                CRITIQUE_TRIAGE_PROMPT(spec, refined, qa, '')
            )
        } catch {
            verdict = null
        }
        if (verdict !== null) {
            if (isCritiqueClean(verdict)) {
                if (skipDefects === null && absenceProbe === null) return spec
            } else {
                triageDefects = verdict.trim()
            }
        }
    }
    const rewriteDefects =
        [skipDefects, absenceProbe, triageDefects].filter(Boolean).join('\n\n') || null
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

// ─── Trial ────────────────────────────────────────────────────────────────────

type Mode = 'baseline' | 'treatment' | 'critique-baseline' | 'critique-treatment'

interface TrialResult {
    draftPair: number
    finalPair: number
    tsconfigStillFrozenBlanket: boolean
    creationKept: boolean
    resolution: 'unresolved' | 'scoped-ownership' | 'dropped-creation' | 'freeze-removed'
    error?: string
}

/** Deterministic resolution classification over the delivered spec text. */
function classify(final: string, research: string): Omit<TrialResult, 'draftPair' | 'error'> {
    const finalConflicts = findFrozenPathConflicts(final, research)
    const finalPair = finalConflicts.length
    const prohibitions = extractProhibitions(final).filter(p =>
        p.path.replace(/^\.\//, '').endsWith('tsconfig.json')
    )
    // The same exception test the detector applies: a freeze line carrying a
    // scoped-ownership clause is no longer blanket.
    const exceptionRe =
        /\b(?:except|unless|beyond|other\s+than|apart\s+from|only\s+(?:to|for|if|when|where|edit|modify|change|touch|update)|may\s+(?:edit|modify|change|update|add))\b/i
    const blanket = prohibitions.filter(p => !exceptionRe.test(p.constraint))
    // A "You MAY edit `tsconfig.json` ONLY to …" grant line is the scoped shape
    // even though PROHIBITION_RE does not parse it as a prohibition (live
    // rewrites phrase the restriction as "any other change is forbidden").
    const mayOnly = final
        .split('\n')
        .some(
            l =>
                /tsconfig\.json/.test(l)
                && /\bmay\b[^\n]*\bonly\b/i.test(l)
                && /edit|modify|add|chang|updat/i.test(l)
        )
    const scoped = mayOnly || (prohibitions.length > 0 && blanket.length === 0)
    const creationKept = /playwright-ct\.config\.ts/.test(final)
    let resolution: TrialResult['resolution'] = 'unresolved'
    if (finalPair === 0) {
        if (!creationKept) resolution = 'dropped-creation'
        else if (scoped) resolution = 'scoped-ownership'
        else if (prohibitions.length === 0) resolution = 'freeze-removed'
        else resolution = 'scoped-ownership' // blanket freeze remains but no
        // requires-edit statement survives — reported below via finalPair anyway
    }
    if (finalPair === 0 && creationKept && blanket.length > 0 && !mayOnly) {
        // Pair gone only because the requires-edit/surrender text was dropped
        // while the blanket freeze + creation both remain: the repo will still
        // go permanently red at run time. Count it as UNRESOLVED — the metric
        // must not reward hiding the statement.
        resolution = 'unresolved'
    }
    return {
        finalPair,
        tsconfigStillFrozenBlanket: blanket.length > 0,
        creationKept,
        resolution
    }
}

async function runTrial(mode: Mode, n: number): Promise<TrialResult> {
    const dir = path.join(ROOT, `${mode}-t${n}`)
    buildFixture(dir)
    const logPath = path.join(dir, 'trial.log')
    const log = (m: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    const deps: PhaseDeps = {
        cwd: dir,
        taskId: 'TASK_AB',
        signal: abort.signal,
        onChildOutput: line => log(line),
        logDebug: msg => log(`[debug] ${msg}`)
    }
    try {
        let draft: string
        if (mode === 'critique-baseline' || mode === 'critique-treatment') {
            // Controlled seam: the FIXED, pair-carrying real mx5 spec as draft.
            draft = MX5_DRAFT
        } else {
            log(`=== compose start (${mode} t${n}) ===`)
            draft = await phaseCompose(deps, REFINED, RESEARCH, QA)
        }
        fs.writeFileSync(path.join(dir, 'draft.spec.md'), draft)
        const draftPair = findFrozenPathConflicts(draft, RESEARCH).length
        log(`=== draft pair conflicts: ${draftPair} ===`)
        const final =
            mode === 'baseline' || mode === 'critique-baseline' ?
                await critiqueBaseline(deps, draft, REFINED, QA)
            :   await phaseCritique(deps, draft, REFINED, QA, undefined, RESEARCH)
        fs.writeFileSync(path.join(dir, 'final.spec.md'), final)
        const c = classify(final, RESEARCH)
        log(`=== critique done — final pair conflicts: ${c.finalPair} (${c.resolution}) ===`)
        return {draftPair, ...c}
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log(`=== TRIAL ERROR: ${msg} ===`)
        return {
            draftPair: -1,
            finalPair: -1,
            tsconfigStillFrozenBlanket: false,
            creationKept: false,
            resolution: 'unresolved',
            error: msg
        }
    } finally {
        clearTimeout(timer)
    }
}

async function main(): Promise<void> {
    await requirePreconditions('live-frozen-conflict-ab', {model: {}, piBin: true, cacheOff: true})
    const mode = process.argv[2] as Mode
    const modes: Mode[] = ['baseline', 'treatment', 'critique-baseline', 'critique-treatment']
    if (!modes.includes(mode)) {
        console.error(
            'usage: PI_BIN=$(command -v pi) bun run scripts/live-frozen-conflict-ab.ts '
                + '<baseline|treatment|critique-baseline|critique-treatment> [TRIALS]'
        )
        process.exit(1)
    }
    // llama-server must be up — a dead endpoint burns the trial budget on retries.
    const trials = parseInt(process.argv[3] ?? '5', 10)
    let draftHadPair = 0
    let finalHadPair = 0
    let resolved = 0
    const resolutions: string[] = []
    for (let t = 1; t <= trials; t++) {
        const r = await runTrial(mode, t)
        if (r.error) {
            console.log(`[${mode} t${t}] ERROR: ${r.error.slice(0, 160)}`)
            resolutions.push('error')
            continue
        }
        if (r.draftPair > 0) draftHadPair++
        if (r.finalPair > 0) finalHadPair++
        if (r.draftPair > 0 && r.finalPair === 0 && r.resolution !== 'unresolved') resolved++
        resolutions.push(r.resolution)
        console.log(
            `[${mode} t${t}] draft pair=${r.draftPair} | final pair=${r.finalPair}`
                + ` | tsconfig blanket-frozen=${r.tsconfigStillFrozenBlanket}`
                + ` | creation kept=${r.creationKept} | resolution=${r.resolution}`
        )
    }
    console.log(`\n[${mode}] over ${trials} trials:`)
    console.log(`  compose draft carried the unsatisfiable pair: ${draftHadPair}/${trials}`)
    console.log(`  DELIVERED spec still carries the pair:        ${finalHadPair}/${trials}`)
    console.log(`  pair present in draft AND resolved by critique: ${resolved}/${trials}`)
    console.log(`  resolutions: ${resolutions.join(', ')}`)

    // The compose draft carrying the unsatisfiable pair IS the precondition: if the
    // draft never contains it, a clean DELIVERED spec is not the critique working.
    reportArm({
        name: 'live-frozen-conflict-ab',
        arm: mode,
        reps: trials,
        targetShape:
            'a DELIVERED spec that still carries the unsatisfiable frozen/requires-edit '
            + 'pair the compose draft introduced',
        hits: finalHadPair,
        witnessed: draftHadPair,
        expect: mode.endsWith('baseline') ? 'some' : 'none',
        invariants: [
            {
                label: 'no trial ended in a child error (errors are not evidence either way)',
                ok: !resolutions.includes('error'),
                detail: `${resolutions.filter(r => r === 'error').length}/${trials} errored`
            }
        ]
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
