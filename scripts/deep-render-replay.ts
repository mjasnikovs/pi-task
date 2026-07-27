/**
 * deep-render-replay — run the REAL final gate against a cloned project and print
 * its verdict plus wall time. Durable, re-runnable, no model time.
 *
 *   bun run scripts/deep-render-replay.ts <projectDir> [--port N] [--no-deep]
 *
 * --port N   boot the app on exactly N instead of a freshly reserved port. Needed
 *            for any client whose base URL is baked in at BUILD time (mx5 bakes
 *            process.env.APP_URL into the bundle), so that the served origin and
 *            the origin the client calls are the same one.
 * --no-deep  disable the authenticated deep-render probe — the before-arm for the
 *            I4 wall-clock invariant.
 * --trace-deep
 *            replace the probe with a recorder that drives nothing and report
 *            whether the gate reached it at all (the I1 evidence for non-served
 *            projects: detectsServedApp false ⇒ it must never be called).
 */
import {runFinalIntegrationGate} from '../src/task/final-gate'

const args = process.argv.slice(2)
const projectDir = args[0]
if (!projectDir) {
    console.error('usage: bun run scripts/deep-render-replay.ts <projectDir> [--port N] [--no-deep]')
    process.exit(3)
}
const portArg = args.indexOf('--port')
const port = portArg === -1 ? null : Number(args[portArg + 1])
const noDeep = args.includes('--no-deep')
const traceDeep = args.includes('--trace-deep')

let deepCalls = 0
const started = Date.now()
const out = await runFinalIntegrationGate(projectDir, 900_000, 15_000, {
    ...(port !== null ? {pickPort: () => Promise.resolve(port)} : {}),
    ...(noDeep || traceDeep ?
        {
            deepRenderProbe: () => {
                deepCalls += 1
                return Promise.resolve({
                    outcome: 'skip' as const,
                    note: 'deep probe disabled (baseline arm)'
                })
            }
        }
    :   {})
})
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n=== ${out.ok ? 'PASS' : 'FAIL'} in ${elapsed}s (deep probe ${noDeep ? 'OFF' : 'ON'})`)
if (traceDeep) console.log(`deep probe reached: ${deepCalls} time(s)`)
console.log(out.reason)
process.exit(out.ok ? 0 : 1)
