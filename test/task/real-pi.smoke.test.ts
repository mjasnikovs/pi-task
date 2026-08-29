/**
 * Smoke tests that spawn the REAL `pi` binary.
 *
 * Why this file exists:
 *   The rest of the suite uses fakeSpawn, which can only assert that the
 *   orchestrator parses what the fake emits. It cannot catch "we sent pi
 *   the wrong flags" — which is exactly what regressed in 4e34f96 when
 *   `--mode json` was dropped from `childArgs`. None of the unit tests
 *   noticed; every fake child happily emitted JSON regardless of flags.
 *
 *   These tests launch real pi via the orchestrator's actual wiring. If
 *   the args we send no longer match the events we expect back, the test
 *   blows up with the same error the user sees in `/task`.
 *
 * Cost:
 *   Real pi takes ~3–10s per phase call. Tests skip cleanly when pi is
 *   not on PATH (CI, sandbox), and can be force-skipped with PI_SKIP_SMOKE=1.
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
                // The orchestrator's job is to turn the raw prompt into a
                // structured spec. If --mode json is missing, refined is
                // empty and the phase throws "refine child produced no
                // output" — same wedge as TASK_0005..0007.
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
                // The research workers spawn pi through runWorker, which now wraps
                // every run in a combined external-abort + wall-clock-timeout
                // signal. A real spawn confirms that wrapper does not break the
                // child wiring (right flags, json events parsed) and that a healthy
                // worker finishes well under the timeout — no false loopHit/timedOut.
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
