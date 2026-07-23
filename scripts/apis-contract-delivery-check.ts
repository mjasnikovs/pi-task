/**
 * STAGE 2 STEP C — DELIVERY CHECK. Did the APIS output contract reach the prompt the CHILD
 * received, or only get built?
 *
 * WHY THIS IS NOT OPTIONAL. PROMPT 4's A/B verified per rep that phaseResearch BUILT a
 * non-empty block ("spec-urls: block 1002 chars"). That is a different claim from "the string
 * was concatenated into the prompt the model read", and the difference is the entire meaning
 * of that result: reporting "the lever does not work" when the truth is "the lever never
 * reached the model" would be a serious mis-report of a NEGATIVE result — and negative results
 * are the ones nobody re-checks. The equivalent check is what let PROMPT 4's FAIL be written
 * down as a fact about the model.
 *
 * WHAT IT CHECKS, and it checks BOTH ARMS because this A/B has a stripped baseline:
 *   treatment  the shipped path — the contract must be IN the assembled worker:apis prompt.
 *   baseline   the same dist with scripts/apis-contract-surgery.ts' STRIP_CONTRACT applied —
 *              the contract must be ABSENT. A baseline that silently kept the block would make
 *              both arms identical and the A/B could then only report "no effect".
 * Both are checked against the prompt PHASES ACTUALLY ASSEMBLED, dumped from a private dist
 * copy patched at the runner's prompt-assembly line, not against the prompt builder in
 * isolation.
 *
 * COST: two real research reps, ~7 minutes. Run before STEP D, not after.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/apis-contract-delivery-check.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {APIS_SEMANTICS_CONTRACT} from '../src/task/apis-contract.js'
import {buildPatchedDist, stubSearchExtension, type Surgery} from './spec-url-dist.js'
import {FIXTURES, CALLS_LOG_ENV, buildFixtureTree, writeStubExtension} from './spec-url-fixtures.js'
import {CONTRACT_MARKER, STRIP_CONTRACT, assertContractInPrompt} from './apis-contract-surgery.js'

const ROOT = path.resolve(process.env.DELIVERY_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-delivery'))
const DUMP_ENV = 'PI_TASK_PROMPT_DUMP'

const dumpPatch: Surgery = {
    file: 'task/phases.js',
    find: "        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt;",
    replace:
        '        const basePrompt = (p => { try { const s = process.env['
        + JSON.stringify(DUMP_ENV)
        + "]; if (s) require('node:fs').appendFileSync(s, '\\n===== ' + spec.label"
        + " + ' =====\\n' + p) } catch {} return p })"
        + "(typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt);",
    label: 'dump every assembled worker prompt to disk'
}

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error('REFUSING TO RUN: PI_BIN is unset (an unset PI_BIN forks the harness into itself).')
    process.exit(1)
}

fs.mkdirSync(ROOT, {recursive: true})
const stubSurgery = stubSearchExtension(writeStubExtension(ROOT))
const dists: Record<string, string> = {
    treatment: buildPatchedDist('apis-contract-delivery-treat', [stubSurgery, dumpPatch]),
    baseline: buildPatchedDist('apis-contract-delivery-base', [stubSurgery, dumpPatch, STRIP_CONTRACT])
}

let failed = false
for (const [arm, dist] of Object.entries(dists)) {
    const expectPresent = arm === 'treatment'
    // Cheap check first, against the loaded builder — if this is already wrong, the expensive
    // rep would only reproduce the same fault more slowly.
    await assertContractInPrompt(dist, expectPresent)

    const {phaseResearch} = (await import(path.join(dist, 'task', 'phases.js'))) as typeof import('../dist/task/phases.js')
    const f = FIXTURES[0]
    const dir = path.resolve(buildFixtureTree(path.join(ROOT, arm), f, 1))
    const dump = path.join(dir, 'prompts.txt')
    fs.rmSync(dump, {force: true})
    process.env[DUMP_ENV] = dump
    process.env[CALLS_LOG_ENV] = path.join(dir, 'calls.log')
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 30 * 60_000)
    try {
        await phaseResearch(
            {cwd: dir, taskId: f.taskId, signal: ac.signal, onChildOutput: () => {}, logDebug: () => {}},
            f.refined
        )
    } finally {
        clearTimeout(timer)
    }
    const text = fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : ''
    const apis = text.split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
    const present = apis.includes(CONTRACT_MARKER)
    // The FULL text, not just the marker: a truncated or re-wrapped block would pass a
    // first-line check while the model saw something other than the contract.
    const wholeBlock = apis.includes(APIS_SEMANTICS_CONTRACT)
    const ok = present === expectPresent && (!expectPresent || wholeBlock)
    console.log(
        `${arm.padEnd(10)} worker:apis prompt ${String(apis.length).padStart(6)} chars   `
            + `contract ${present ? 'PRESENT' : 'ABSENT '} (expected ${expectPresent ? 'PRESENT' : 'ABSENT'})   `
            + `whole block verbatim ${wholeBlock}   ${ok ? 'OK' : '*** FAILED ***'}`
    )
    if (arm === 'treatment') {
        console.log(`--- last 700 chars of the treatment APIS prompt ---\n${apis.slice(-700)}\n---`)
    }
    if (!ok) failed = true
}

if (failed) {
    console.error(
        '\nDELIVERY CHECK FAILED. Do NOT run the A/B: whatever it reported would be a fact '
            + 'about the plumbing, not about the model.'
    )
    process.exit(1)
}
console.log('\nDELIVERED — the contract reaches the assembled worker:apis prompt in the treatment arm and is absent in the baseline arm.')
