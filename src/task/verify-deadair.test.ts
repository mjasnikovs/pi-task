/**
 * DEAD AIR in the validation gate.
 *
 * Reported live (2026-08-06): "/task-auto finishes implementing, then nothing
 * happens — the model looks stopped, the scrolling stops — and then the validation
 * gate pops up and it works."
 *
 * The window was real and it was structural: at `agent_end` the implementation
 * widget is cleared, and the gate's first UI (the verify child's loader) only
 * appears once the CHILD starts — after a whole-repo static-analysis run and ten
 * probes. That run was `spawnSync`, so the event loop was blocked too: even the
 * `verifying…` notify could not paint, because pi-tui schedules renders on
 * `process.nextTick`. MEASURED on real repos (scripts/verify-deadair-step0.ts):
 * 15s on mx5, 69s on aiz-client, with 0 of 686 expected 100ms timer ticks
 * delivered. A/B (scripts/verify-deadair-ab.ts, 12 reps on mx5): silent windows
 * ≥3s, baseline 12/12 → treatment 0/12.
 *
 * These tests hold the two halves of the fix: the deterministic stage REPORTS
 * itself, and the gate keeps painting while it runs.
 */
import {describe, expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {runWorkVerification} from './verify-work.js'
import {buildGateDeps} from './gate-deps.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {getConfig} from '../config/config.js'

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('the deterministic stage reports its progress', () => {
    test('every step names itself, in order, as it starts', async () => {
        const stages: string[] = []
        const out = await runWorkVerification({
            cwd: '/nowhere',
            spec: 'GOAL\nx\n\nVERIFY:\n```bash\ntrue\n```\n',
            onStage: s => stages.push(s),
            repoHealth: () => Promise.resolve({ok: true, reason: 'ok'}),
            probes: {
                substitution: () => Promise.resolve([]),
                prohibition: () => Promise.resolve([]),
                testAssembly: () => Promise.resolve([]),
                probeGaming: () => Promise.resolve([]),
                crossTaskDeletion: () => Promise.resolve([]),
                foreignPath: () => Promise.resolve([]),
                scriptEscape: () => Promise.resolve([]),
                runnerGlob: () => Promise.resolve([])
            },
            runChild: () => Promise.resolve('WORK-VERIFIED: PASS')
        })
        expect(out.ok).toBe(true)
        expect(stages[0]).toBe('repo health')
        expect(stages).toContain('substitution probe')
        expect(stages).toContain('cross-task deletion probe')
        expect(stages).toContain('runner-glob probe')
    })

    test('the repo-health step is announced BEFORE it finishes, not after', async () => {
        const stages: string[] = []
        let announcedDuringHealth = false
        await runWorkVerification({
            cwd: '/nowhere',
            spec: null,
            onStage: s => stages.push(s),
            repoHealth: async () => {
                announcedDuringHealth = stages.includes('repo health')
                await sleep(10)
                return {ok: true, reason: 'ok'}
            },
            runChild: () => Promise.resolve('WORK-VERIFIED: PASS')
        })
        expect(announcedDuringHealth).toBe(true)
    })

    test('a throwing progress hook cannot break the gate', async () => {
        const out = await runWorkVerification({
            cwd: '/nowhere',
            spec: null,
            onStage: () => {
                throw new Error('ui exploded')
            },
            repoHealth: () => Promise.resolve({ok: true, reason: 'ok'}),
            runChild: () => Promise.resolve('WORK-VERIFIED: PASS')
        })
        expect(out.ok).toBe(true)
    })
})

describe('the gate paints while the deterministic stage runs', () => {
    test('the loader is live during the repo-health run, before any child starts', async () => {
        // A repo whose only static check sleeps: the health run IS the window the
        // user stared at. No task file, so the gate returns right after it — this
        // measures the pre-child stage alone, with no model child involved.
        const dir = mkdtempSync(path.join(tmpdir(), 'deadair-'))
        try {
            writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({scripts: {lint: 'sleep 1.2'}})
            )
            const verifyWork = getConfig().verifyWork
            getConfig().verifyWork = true
            const handle = makeFakeCtx(dir)
            const deps = buildGateDeps({
                signal: new AbortController().signal,
                parentContextWindow: 100_000,
                runTask: () =>
                    Promise.resolve({
                        taskId: 'TASK_0001',
                        ctx: handle.ctx,
                        end: {kind: 'completed'}
                    })
            })
            try {
                const out = await deps.verify!(handle.ctx, dir, 'dead-air probe', 'TASK_0001')
                expect(out.ok).toBe(true)
            } finally {
                getConfig().verifyWork = verifyWork
            }
            // The loader refreshes every 500ms, so a ~1.2s health run must have
            // drawn at least twice. Before the fix this was zero — the loop was
            // blocked inside spawnSync and nothing could render at all.
            expect(handle.captured.widgets.length).toBeGreaterThanOrEqual(2)
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })
})
