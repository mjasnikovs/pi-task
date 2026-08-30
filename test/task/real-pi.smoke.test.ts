/**
 * Smoke tests that spawn the REAL `pi` binary.
 *
 * The rest of the suite runs on fakeSpawn, which can only prove the orchestrator
 * parses what the fake emits. It cannot catch "we sent pi the wrong flags": a fake
 * child emits its JSON events whatever argv it was handed, so dropping
 * `--mode json` from `childArgs` would leave every unit test green. These launch
 * real pi through the orchestrator's own wiring, so argv and events are checked
 * against each other.
 *
 * They spawn a real model, so they are slow. `findPi` below skips them when `pi`
 * is not on PATH, and PI_SKIP_SMOKE=1 forces the skip.
 */

import {describe, expect, test, beforeAll, afterAll} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {phaseRefine} from '../../src/task/phases.js'
import {runWorker} from '../../src/workers/pi-worker-core.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'

function findPi(): string | null {
    if (process.env.PI_SKIP_SMOKE === '1') return null
    const r = spawnSync('which', ['pi'])
    if (r.status !== 0) return null
    return r.stdout.toString().trim()
}

const PI_PATH = findPi()
const itPi = PI_PATH ? test : test.skip

beforeAll(() => {
    if (PI_PATH) process.env.PI_BIN = PI_PATH
})

afterAll(() => {
    delete process.env.PI_BIN
})

describe('real pi smoke', () => {
    itPi(
        'phaseRefine drives the real pi binary end-to-end',
        async () => {
            await withTmpTaskDir(async cwd => {
                const deps = {
                    cwd,
                    taskId: 'TASK_SMOKE',
                    signal: new AbortController().signal
                }
                const refined = await phaseRefine(deps, 'run lint')
                // With `--mode json` missing, the runner reads no assistant text,
                // `refined` is empty, and the phase throws "refine child produced
                // no output" rather than reporting a flag problem.
                expect(refined.trim().length).toBeGreaterThan(0)
                // Loose shape check: refine is supposed to emit GOAL +
                // CONSTRAINTS + KNOWN-UNKNOWNS. We don't pin exact text
                // (model output varies), but the headings should appear.
                expect(refined).toMatch(/GOAL/)
                expect(refined).toMatch(/CONSTRAINTS/)
            })
        },
        120_000
    )

    itPi(
        'runWorker drives real pi through the timeout-wrapped spawn path',
        async () => {
            await withTmpTaskDir(async cwd => {
                // The research workers spawn pi through runWorker, which hands the
                // child an `AbortSignal.any` of the wall-clock timeout and the
                // command watchdog. A real spawn is what shows that wrapper leaves
                // the child wiring intact and that a healthy worker finishes without
                // a false loopHit or timedOut.
                const r = await runWorker({
                    prompt: 'Reply with the single word READY and nothing else.',
                    profile: 'adhoc',
                    contextWindow: 'unknown',
                    override: {
                        'worker-timeout': {timeoutMs: 90_000, progressCeilingMs: null, fanout: null}
                    },
                    cwd
                })
                expect(r.exitCode).toBe(0)
                expect(r.text.trim().length).toBeGreaterThan(0)
                expect(r.loopHit).toBeUndefined()
                expect(r.timedOut).toBeUndefined()
            })
        },
        120_000
    )
})
