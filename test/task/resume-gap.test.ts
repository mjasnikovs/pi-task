import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {decideResume, formatGap, UNATTENDED_STATES} from '../../src/task/resume-gap.js'
import {findResumableAutoDetailed} from '../../src/task/auto-io.js'
import {writeTaskFile} from '../../src/task/task-io.js'
import type {TaskFrontMatter, TaskState} from '../../src/task/task-types.js'

function fm(id: string, state: TaskState) {
    return {
        id,
        state,
        phase: 'done',
        created_at: 'T',
        updated_at: 'T',
        title: 't'
    } as unknown as TaskFrontMatter
}

const NOW = Date.parse('2026-07-19T06:01:00.000Z')

test('formatGap: coarsest two units', () => {
    expect(formatGap(0)).toBe('0s')
    expect(formatGap(45_000)).toBe('45s')
    expect(formatGap(180_000)).toBe('3m')
    expect(formatGap(200_000)).toBe('3m 20s')
    expect(formatGap(2 * 3_600_000)).toBe('2h')
    expect(formatGap(10 * 3_600_000 + 60_000)).toBe('10h 1m')
    expect(formatGap(52 * 3_600_000)).toBe('2d 4h')
})

test('decideResume: nothing resumable', () => {
    const d = decideResume(null, NOW, true)
    expect(d.resume).toBe(false)
    expect(d.banner).toBe('No resumable /task-auto run.')
})

test('decideResume: unattended refuses a failed run by name, attended continues it', () => {
    const cand = {id: 'TASK_AUTO_0001', state: 'failed' as TaskState, lastWriteMs: NOW - 60_000}
    const auto = decideResume(cand, NOW, true)
    expect(auto.resume).toBe(false)
    expect(auto.level).toBe('warning')
    expect(auto.banner).toContain('Not auto-resuming TASK_AUTO_0001')
    expect(auto.banner).toContain('state=failed')
    // A human typing the command has decided to continue — same run, resumes.
    expect(decideResume(cand, NOW, false).resume).toBe(true)
})

test('decideResume: unattended covers in-flight states only', () => {
    expect(UNATTENDED_STATES).toEqual(['in_progress'])
    for (const state of ['pending', 'cancelled', 'failed'] as TaskState[]) {
        const d = decideResume({id: 'A', state, lastWriteMs: NOW}, NOW, true)
        expect(d.resume).toBe(false)
    }
    expect(decideResume({id: 'A', state: 'in_progress', lastWriteMs: NOW}, NOW, true).resume).toBe(
        true
    )
})

test('decideResume: a long gap is reported as measured, with no cause attributed', () => {
    // The task file's last write and NOW are ten hours apart, which is what the
    // banner has to state.
    const lastWriteMs = Date.parse('2026-07-18T20:00:13.000Z')
    const d = decideResume({id: 'TASK_AUTO_0001', state: 'in_progress', lastWriteMs}, NOW, true)
    expect(d.resume).toBe(true)
    expect(d.banner).toContain('Resuming TASK_AUTO_0001 (state=in_progress)')
    expect(d.banner).toContain('10h ago')
    expect(d.banner).toContain('2026-07-18T20:00:13.000Z')
    expect(d.banner).toContain('unaccounted-for wall time')
    expect(d.banner).toContain('Nothing was rolled back')
    // No guess at WHY: the process cannot see the difference.
    expect(d.banner).not.toContain('host was')
    expect(d.banner).not.toContain('crash')
})

test('decideResume: a short hand-driven gap gets no unaccounted-time paragraph', () => {
    const d = decideResume(
        {id: 'TASK_AUTO_0001', state: 'in_progress', lastWriteMs: NOW - 40_000},
        NOW,
        false
    )
    expect(d.banner).toContain('last written 40s ago')
    expect(d.banner).not.toContain('unaccounted-for wall time')
})

test('decideResume: a future mtime is reported as clock skew, never as "0s ago"', () => {
    const d = decideResume(
        {id: 'TASK_AUTO_0001', state: 'in_progress', lastWriteMs: NOW + 3_600_000},
        NOW,
        false
    )
    expect(d.banner).toContain('in the future')
    expect(d.banner).toContain('clock moved')
    expect(d.banner).not.toContain('ago')
})

test('findResumableAutoDetailed: carries state and last-write time of the newest candidate', async () => {
    await withTmpTaskDir(async dir => {
        const before = Date.now()
        await writeTaskFile(dir, fm('TASK_AUTO_0001', 'completed'), '\n## tasks\n')
        await writeTaskFile(dir, fm('TASK_AUTO_0002', 'in_progress'), '\n## tasks\n')
        await new Promise(r => setTimeout(r, 10))
        await writeTaskFile(dir, fm('TASK_AUTO_0003', 'failed'), '\n## tasks\n')
        const found = await findResumableAutoDetailed(dir)
        expect(found?.id).toBe('TASK_AUTO_0003')
        expect(found?.state).toBe('failed')
        expect(found?.lastWriteMs).toBeGreaterThanOrEqual(before)
    })
})

// The newest run being unresumable says nothing about an in-flight run behind it.
// Picking the candidate by mtime across the HUMAN-resumable states and only THEN
// refusing on state lets one failed run shadow a genuinely in-flight one: the boot
// hook would refuse every restart while that run sat in dead air.
test('findResumableAutoDetailed: a failed newer run does not shadow an in-flight one', async () => {
    await withTmpTaskDir(async dir => {
        await writeTaskFile(dir, fm('TASK_AUTO_0002', 'in_progress'), '\n## tasks\n')
        await new Promise(r => setTimeout(r, 10))
        await writeTaskFile(dir, fm('TASK_AUTO_0003', 'failed'), '\n## tasks\n')

        // Attended: the human asked for the newest resumable run, failed included.
        expect((await findResumableAutoDetailed(dir))?.id).toBe('TASK_AUTO_0003')

        // Unattended: the in-flight run is the one a restart should pick up.
        const forHook = await findResumableAutoDetailed(dir, UNATTENDED_STATES)
        expect(forHook?.id).toBe('TASK_AUTO_0002')
        expect(decideResume(forHook, Date.now(), true).resume).toBe(true)
    })
})

test('findResumableAutoDetailed: with no in-flight run the hook still refuses by name', async () => {
    await withTmpTaskDir(async dir => {
        await writeTaskFile(dir, fm('TASK_AUTO_0003', 'failed'), '\n## tasks\n')
        expect(await findResumableAutoDetailed(dir, UNATTENDED_STATES)).toBeNull()
        // …and the refusal still names the run, rather than "nothing resumable".
        const newest = await findResumableAutoDetailed(dir)
        const d = decideResume(newest, Date.now(), true)
        expect(d.resume).toBe(false)
        expect(d.banner).toContain('Not auto-resuming TASK_AUTO_0003')
    })
})
