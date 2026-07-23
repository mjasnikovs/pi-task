/**
 * DELIVERY CHECK — did the spec-URL block reach the APIS worker's PROMPT, or only get built?
 *
 * WHY THIS EXISTS, and why it ran before the A/B's FAIL was written down. The A/B verified,
 * per rep, that phaseResearch BUILT a non-empty block ("spec-urls: block 1002 chars"). That
 * is not the same claim as "the string was concatenated into the prompt the child received",
 * and the difference is the whole meaning of the result: reporting "the lever does not work"
 * when the truth is "the lever never reached the model" would be a serious mis-report of a
 * negative result — and negative results are the ones nobody re-checks.
 *
 * RESULT 2026-07-22: DELIVERED. The worker:apis prompt is 19,473 chars and ends with the
 * block, the six ranked URLs, and hono.dev/docs/guides/rpc among them. So the A/B's
 * baseline 2/20 vs treatment 3/20 (p = 0.50) is a fact about the MODEL declining to act on an
 * instruction it was given, not about plumbing.
 *
 * HOW: patches the runner's own prompt-assembly line in a private dist copy to dump every
 * worker prompt to disk, then runs ONE real rep and greps. Needs the lever WIRED into
 * phases.ts — it is currently unwired (see spec-urls.ts), so re-wire before re-running.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/spec-url-prompt-delivery-check.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {buildPatchedDist, stubSearchExtension} from './spec-url-dist.js'
import {FIXTURES, CALLS_LOG_ENV, buildFixtureTree, writeStubExtension} from './spec-url-fixtures.js'

const ROOT = path.join(os.homedir(), 'tmp', 'spec-url-delivery-check')
const DUMP = path.join(ROOT, 'prompts.txt')

const stub = writeStubExtension(ROOT)
const dist = buildPatchedDist('spec-url-delivery', [
    stubSearchExtension(stub),
    {
        file: 'task/phases.js',
        find: "        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt;",
        replace:
            "        const basePrompt = (p => { try { (globalThis.__fsdump ??= require('node:fs'))"
            + `.appendFileSync(${JSON.stringify(DUMP)}, '\\n===== ' + spec.label + ' =====\\n' + p) } catch {} return p })`
            + "(typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt);",
        label: 'dump every worker prompt to disk'
    }
])
const {phaseResearch} = (await import(
    path.join(dist, 'task', 'phases.js')
)) as typeof import('../dist/task/phases.js')

const f = FIXTURES[0]
const dir = buildFixtureTree(ROOT, f, 1)
process.env[CALLS_LOG_ENV] = path.join(dir, 'calls.log')
fs.rmSync(DUMP, {force: true})
const ac = new AbortController()
setTimeout(() => ac.abort(), 20 * 60_000)
await phaseResearch(
    {cwd: dir, taskId: f.taskId, signal: ac.signal, onChildOutput: () => {}, logDebug: () => {}},
    f.refined
)
const text = fs.existsSync(DUMP) ? fs.readFileSync(DUMP, 'utf8') : ''
const apis = text.split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
console.log(`prompts dumped: ${text.length} chars; worker:apis prompt: ${apis.length} chars`)
console.log(`worker:apis prompt CONTAINS the block: ${apis.includes('SPEC-CITED DOCUMENTATION')}`)
console.log(`  contains the cited URL: ${apis.includes('https://hono.dev/docs/guides/rpc')}`)
console.log(`--- last 900 chars of the APIS prompt ---\n${apis.slice(-900)}`)
if (!apis.includes('SPEC-CITED DOCUMENTATION')) process.exit(1)
