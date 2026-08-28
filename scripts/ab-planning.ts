/**
 * NOT A VERDICT HARNESS. This is a RECORDER: it drives the planning children and
 * writes per-rep JSONL to /tmp for a human to read. It renders no PASS/FAIL and
 * exits 0 on any outcome, deliberately — there is no lever under test here.
 * Harnesses that DO test a lever must end in scripts/ab-verdict.ts's report(),
 * so that a run which exercised nothing ABSTAINs instead of reading as a pass.
 *
 * A/B harness for /task-auto PLANNING children against the LIVE local model
 * (llama-server at 127.0.0.1:8080 — an HTTP API, so a pi child is just a
 * client; no second weights load).
 *
 * Loads a fixture from src/task/__fixtures__/planning/ into a temp dir, builds
 * the feature text exactly like planAuto does (expandFeatureMentions on an
 * @-mention), and drives the REAL planning child prompts through the REAL
 * child spawn path (runChild → pi --mode json). Per-mechanism A/B scripts
 * import the exported helpers and define their own old/new arms; the CLI here
 * is the smoke path for a single child × fixture × N reps.
 *
 * Usage:
 *   PI_BIN=pi bun scripts/ab-planning.ts <decompose|launch|contract> <fixture> [reps=1]
 *
 * Fixtures: mx5 | greenfield | existing | wiki | cli | prose | oneliner | contradiction
 *
 * PI_BIN is forced to `pi` when unset — an unset PI_BIN self-spawns the harness
 * (a known trap). Results stream to stdout and are appended as JSON lines under
 * /tmp/pi-task-ab/.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {runChild} from '../src/task/child-runner.js'
import {expandFeatureMentions} from '../src/task/auto-orchestrator.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {DECOMPOSE_SOURCE_RULE, reconcileTitleSources} from '../src/task/decompose-fidelity.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    capRequirements,
    enumerateObligationPassages,
    uncoveredPassages,
    extractionRetryHint,
    parseCoverageMap,
    accountCoverage,
    buildRequirementsLedger,
    type RequirementEntry
} from '../src/task/requirements.js'
import {prependHint} from '../src/task/child-runner.js'

/** The full NEW-arm extraction path: checklist floor + one forced retry on
 *  uncovered obligation-marked passages (mirrors planAuto exactly). */
export async function extractRequirementsNew(fx: LoadedFixture): Promise<RequirementEntry[]> {
    const passages = enumerateObligationPassages(fx.featureForModel)
    const once = async (hint: string | null): Promise<RequirementEntry[]> =>
        keepGroundedRequirements(
            parseRequirementLines(
                await runPlanningChild(
                    fx.cwd,
                    '',
                    prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(fx.featureForModel, passages))
                )
            ),
            fx.featureForModel
        )
    let entries = await once(null)
    const uncovered = uncoveredPassages(passages, entries)
    if (uncovered.length > 0) {
        entries = keepGroundedRequirements(
            [...entries, ...(await once(extractionRetryHint(uncovered)))],
            fx.featureForModel
        )
    }
    return capRequirements(entries, passages, fx.featureForModel)
}
import {
    LAUNCH_EXTRACT_PROMPT,
    enumerateScriptCandidates,
    parseScriptLines,
    keepGroundedScripts
} from '../src/task/launch-contract.js'
import {CONTRACT_EXTRACT_PROMPT, parseContractLines, keepGroundedContracts} from '../src/task/contracts.js'

const FIXTURES_DIR = fileURLToPath(new URL('../src/task/__fixtures__/planning', import.meta.url))

interface FixtureSpec {
    /** [source path relative to fixtures dir, dest path relative to tmp cwd] */
    files: Array<[string, string]>
    /** Copy this fixture subdirectory wholesale into the tmp cwd. */
    dir?: string
    feature: string
}

export const PLANNING_FIXTURES: Record<string, FixtureSpec> = {
    // Replicates run 11 exactly: same doc path, same one-line feature.
    mx5: {files: [['mx5-project.md', 'DESIGN/PROJECT.md']], feature: 'Implement @DESIGN/PROJECT.md'},
    greenfield: {files: [['small-greenfield.md', 'spec.md']], feature: 'Implement @spec.md'},
    existing: {files: [], dir: 'existing-codebase', feature: 'Implement @spec.md'},
    wiki: {files: [['cross-cutting-wiki.md', 'spec.md']], feature: 'Implement @spec.md'},
    cli: {files: [['cli-csv-tool.md', 'spec.md']], feature: 'Implement @spec.md'},
    prose: {files: [['unstructured-prose.md', 'spec.md']], feature: 'Implement @spec.md'},
    oneliner: {files: [], feature: ''}, // feature loaded from one-liner.txt below
    contradiction: {files: [['contradiction-spec.md', 'spec.md']], feature: 'Implement @spec.md'}
}

export interface LoadedFixture {
    name: string
    /** Temp working dir holding the fixture files (the child's cwd). */
    cwd: string
    /** The raw user feature text (with @-mentions, un-expanded). */
    feature: string
    /** The feature with @-mentioned docs inlined — what planning children see. */
    featureForModel: string
}

/** Materialize a fixture into a fresh temp dir and build its feature text. */
export async function loadPlanningFixture(name: string): Promise<LoadedFixture> {
    const spec = PLANNING_FIXTURES[name]
    if (!spec) {
        throw new Error(`unknown fixture "${name}" — one of: ${Object.keys(PLANNING_FIXTURES).join(', ')}`)
    }
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), `pi-task-ab-${name}-`))
    if (spec.dir) {
        await fsp.cp(path.join(FIXTURES_DIR, spec.dir), cwd, {recursive: true})
    }
    for (const [src, dest] of spec.files) {
        const target = path.join(cwd, dest)
        await fsp.mkdir(path.dirname(target), {recursive: true})
        await fsp.copyFile(path.join(FIXTURES_DIR, src), target)
    }
    const feature =
        name === 'oneliner' ?
            (await fsp.readFile(path.join(FIXTURES_DIR, 'one-liner.txt'), 'utf8')).trim()
        :   spec.feature
    const featureForModel = await expandFeatureMentions(cwd, feature)
    return {name, cwd, feature, featureForModel}
}

/** Run one planning child (real pi spawn) and return its text output. */
export async function runPlanningChild(
    cwd: string,
    tools: string,
    prompt: string,
    onLine?: (line: string) => void
): Promise<string> {
    if (!process.env.PI_BIN) process.env.PI_BIN = 'pi' // never self-spawn
    const r = await runChild({cwd, tools, prompt, signal: new AbortController().signal, onLine})
    if (r.exitCode !== 0) {
        throw new Error(`child exit ${r.exitCode}: ${r.stderr.slice(-400)}`)
    }
    return r.text
}

export interface RepResult {
    rep: number
    ms: number
    raw: string
    parsed: unknown
}

/** Append per-rep JSON lines under /tmp/pi-task-ab/ and echo a summary line. */
export async function recordRep(tag: string, r: RepResult): Promise<void> {
    const dir = path.join(os.tmpdir(), 'pi-task-ab')
    await fsp.mkdir(dir, {recursive: true})
    await fsp.appendFile(path.join(dir, `${tag}.jsonl`), JSON.stringify(r) + '\n')
}

async function main(): Promise<void> {
    const [child, fixtureName, repsRaw] = process.argv.slice(2)
    const reps = repsRaw ? parseInt(repsRaw, 10) : 1
    if (!child || !fixtureName || !Number.isFinite(reps)) {
        console.error('usage: PI_BIN=pi bun scripts/ab-planning.ts <decompose|launch|contract> <fixture> [reps]')
        process.exit(2)
    }
    const fx = await loadPlanningFixture(fixtureName)
    console.log(`fixture ${fx.name}: cwd=${fx.cwd} feature=${fx.featureForModel.length} chars`)
    const tag = `${child}-${fixtureName}-${Date.now()}`
    for (let rep = 1; rep <= reps; rep++) {
        const t0 = Date.now()
        let raw: string
        let parsed: unknown
        if (child === 'decompose') {
            // OLD arm: the pre-source-rule prompt (rule stripped), no reconciliation.
            raw = await runPlanningChild(
                fx.cwd,
                'read',
                AUTO_DECOMPOSE_PROMPT(fx.featureForModel, '').replace(
                    '\n' + DECOMPOSE_SOURCE_RULE,
                    ''
                )
            )
            parsed = parseDecomposeList(raw)
        } else if (child === 'decompose-new') {
            raw = await runPlanningChild(fx.cwd, 'read', AUTO_DECOMPOSE_PROMPT(fx.featureForModel, ''))
            const plan = reconcileTitleSources(parseDecomposeList(raw), fx.featureForModel)
            parsed = plan
        } else if (child === 'launch') {
            // OLD arm: no candidates. NEW arm (launch-new): mechanical checklist.
            raw = await runPlanningChild(fx.cwd, '', LAUNCH_EXTRACT_PROMPT(fx.featureForModel))
            parsed = keepGroundedScripts(parseScriptLines(raw), fx.featureForModel)
        } else if (child === 'launch-new') {
            raw = await runPlanningChild(
                fx.cwd,
                '',
                LAUNCH_EXTRACT_PROMPT(
                    fx.featureForModel,
                    enumerateScriptCandidates(fx.featureForModel)
                )
            )
            parsed = keepGroundedScripts(parseScriptLines(raw), fx.featureForModel)
        } else if (child === 'contract') {
            // Contract extraction wants the task list; use a decompose pass first.
            const list = parseDecomposeList(
                await runPlanningChild(fx.cwd, 'read', AUTO_DECOMPOSE_PROMPT(fx.featureForModel, ''))
            )
            raw = await runPlanningChild(fx.cwd, '', CONTRACT_EXTRACT_PROMPT(fx.featureForModel, list))
            parsed = keepGroundedContracts(parseContractLines(raw), fx.featureForModel).map(e => e.quote)
        } else if (child === 'requirements') {
            // OLD arm: bare extraction, no checklist floor, no forced retry.
            raw = await runPlanningChild(fx.cwd, '', REQUIREMENT_EXTRACT_PROMPT(fx.featureForModel))
            parsed = keepGroundedRequirements(
                parseRequirementLines(raw),
                fx.featureForModel
            ).map(e => e.quote)
        } else if (child === 'requirements-new') {
            raw = ''
            parsed = (await extractRequirementsNew(fx)).map(e => e.quote)
        } else if (child === 'covmap') {
            // Full new coverage path: extract requirements (floor+retry),
            // decompose WITH the ledger, then map — the host-side accounting.
            const reqs = await extractRequirementsNew(fx)
            const plan = reconcileTitleSources(
                parseDecomposeList(
                    await runPlanningChild(
                        fx.cwd,
                        'read',
                        AUTO_DECOMPOSE_PROMPT(fx.featureForModel, '', buildRequirementsLedger(reqs))
                    )
                ),
                fx.featureForModel
            )
            raw = await runPlanningChild(fx.cwd, '', COVERAGE_MAP_PROMPT(reqs, plan.titles))
            const acc = accountCoverage(
                reqs,
                parseCoverageMap(raw, reqs.length, plan.titles.length)
            )
            parsed = {
                titles: plan.titles,
                mapped: acc.mapped.length,
                cross: acc.crossCutting.map(e => e.quote),
                unmapped: acc.unmapped.map(e => e.quote)
            }
        } else {
            console.error(`unknown child "${child}"`)
            process.exit(2)
        }
        const ms = Date.now() - t0
        await recordRep(tag, {rep, ms, raw, parsed})
        console.log(`rep ${rep}/${reps} (${ms}ms): ${JSON.stringify(parsed)}`)
    }
    console.log(`results: ${path.join(os.tmpdir(), 'pi-task-ab', tag + '.jsonl')}`)
}

if (import.meta.main) {
    main().catch(err => {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
    })
}
