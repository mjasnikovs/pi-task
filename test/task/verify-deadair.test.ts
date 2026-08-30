/**
 * DEAD AIR in the validation gate.
 *
 * The gap is structural. At `agent_end` the implementation widget is cleared, and
 * the gate's first UI — the verify child's loader — only appears once that CHILD
 * starts, which is after a whole-repo static-analysis run and every deterministic
 * probe. A SYNCHRONOUS health run makes it worse than slow: it blocks the event
 * loop, and pi-tui schedules its renders on `process.nextTick`
 * (pi-tui/dist/tui.js), so not even a notify can paint.
 *
 * These tests hold the two halves: the deterministic stage REPORTS itself, and
 * the gate keeps painting while it runs.
 */
import {describe, expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {runWorkVerification} from '../../src/task/verify-work.js'
import {buildGateDeps} from '../../src/task/gate-deps.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {getConfig} from '../../src/config/config.js'

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
        // A repo whose only static check sleeps, so the health run IS the gap. No
        // task file, so the gate returns straight after it: this exercises the
        // pre-child stage alone, with no model child involved.
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
            // startAutoLoader repaints on a WIDGET_REFRESH_MS interval (widget.ts),
            // so a health run of more than twice that must have drawn more than
            // once. An event loop blocked in a synchronous check draws zero.
            expect(handle.captured.widgets.length).toBeGreaterThanOrEqual(2)
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })
})
