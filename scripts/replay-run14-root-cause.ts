/**
 * Run-14 replay for the ROOT-CAUSE REPAIR CHANNEL (nexttask item 5) —
 * deterministic, NO model involved (the whole channel is host-side).
 *
 * Reproduces the mx5 run of 2026-07-18→19. TASK_0007 shipped `test/teardown.ts`
 * with parameterized table names in its TRUNCATE statements. That one bug then
 * FAILed two later, unrelated tasks — TASK_0013 and TASK_0019 — and BOTH ended in
 * an enforce-revert, destroying the enforce pass's edits over a defect neither task
 * created. The ledger recorded the same root cause twice and NOTHING scheduled a
 * fix, so the bug outlived ~24h of the run.
 *
 * Fixture: the two VERBATIM FAIL reasons from run 14's `.pi-tasks/accept-debt.md`,
 * plus run 14's real provenance map and the files each task actually touched, fed
 * through the shipped detection → queue → merge → plan-insert chain against a REAL
 * throwaway .pi-tasks dir. Ground truth is the resulting plan file on disk.
 *
 * Arms:
 *   baseline  — the run-14 behavior, replayed structurally: two debts recorded,
 *               plan unchanged, nothing scheduled.
 *   treatment — the shipped channel: EXACTLY ONE `repair test/teardown.ts` step,
 *               naming both blamed tasks, spliced in after the finished step (not
 *               appended at the end), scoped to the one file with VERIFY pinned to
 *               the failing command.
 *   negatives — run 14's environment-blamed FAIL (TASK_0006) and its
 *               spec-quote-only FAIL (TASK_0010) must schedule nothing.
 *
 * Run: bun scripts/replay-run14-root-cause.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {buildAutoBody, insertTaskAfter, parseTaskList, checkOffTask} from '../src/task/auto-io.js'
import {writeTaskFile, readTaskFile} from '../src/task/task-io.js'
import type {TaskFrontMatter} from '../src/task/task-types.js'
import {
    buildRepairScopeFence,
    buildRepairTitle,
    drainRepairQueue,
    findRepairCandidate,
    mergeRepairCandidates,
    planHasRepairFor,
    recordRepairCandidate
} from '../src/task/root-cause-repair.js'

// ─── Verbatim run-14 ledger entries ──────────────────────────────────────────

const FAILS = {
    TASK_0013:
        'work did not verify: test/teardown.ts has a pre-existing bug (parameterized table names in '
        + 'TRUNCATE statements) causing the afterAll teardown to fail with "syntax error at or near $1", '
        + 'which means `AGENT=1 bun test test/invite.test.ts` exits non-zero despite all 10 actual tests '
        + 'passing — the VERIFY command therefore fails',
    TASK_0019:
        'work did not verify: The shipped `bun test test/photos.test.ts` exits with code 1 due to a '
        + 'pre-existing teardown bug in `test/teardown.ts` (created by TASK_0007) that uses parameterized '
        + 'queries for table names in TRUNCATE statements, causing PostgreSQL syntax errors — this task '
        + 'did not modify the teardown',
    TASK_0006:
        'work unobserved: Runtime behavioral checks (admin insert, idempotency, row verification) could '
        + 'not execute because no PostgreSQL database server is available in this environment (no binary, '
        + 'no Docker, no listener on port 5432). Static checks, type-checking, linting, and env-var '
        + 'validation all pass.',
    TASK_0010:
        'work did not verify: package.json was modified (added "dev" script and dependencies '
        + '@hono/zod-validator, hono, zod) despite the spec explicitly forbidding it: "Preserve all '
        + 'existing files on disk (`src/server/db.ts`, `src/server/seed.ts`, `package.json`, '
        + '`tsconfig.json`, `eslint.config.js`). Do not'
} as const

/** Run 14's real provenance: TASK_0007 created the teardown. */
const PROVENANCE: Record<string, string> = {
    'test/teardown.ts': 'TASK_0007',
    'test/invite.test.ts': 'TASK_0013',
    'test/photos.test.ts': 'TASK_0019',
    'src/server/db.ts': 'TASK_0002',
    'src/server/seed.ts': 'TASK_0002'
}

/** What each task's own work actually touched (never the teardown). */
const TOUCHED: Record<string, string[]> = {
    TASK_0013: ['test/invite.test.ts', 'src/server/routes/invite.ts'],
    TASK_0019: ['test/photos.test.ts', 'src/server/routes/photos.ts'],
    TASK_0006: ['src/server/seed-admin.ts'],
    TASK_0010: ['package.json', 'src/server/index.ts']
}

/** The run-14 plan slice around the two failing steps. */
const PLAN = [
    'Invite flow API + tests',
    'Photo upload routes + tests',
    'Marketplace listing page',
    'Admin moderation page'
]

function fm(id: string): TaskFrontMatter {
    return {
        id,
        state: 'in_progress',
        phase: 'done',
        created_at: 'T',
        updated_at: 'T',
        title: 'mx5 run14 replay'
    } as unknown as TaskFrontMatter
}

async function freshPlan(): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-run14-replay-'))
    await writeTaskFile(dir, fm('TASK_AUTO_0001'), buildAutoBody('mx5', '(none)', PLAN))
    // Step 1 finished; step 2 (the one that FAILed) is the current step.
    await checkOffTask(dir, 'TASK_AUTO_0001', 0, 'TASK_0013', PLAN[0])
    return dir
}

async function titles(dir: string): Promise<string[]> {
    return parseTaskList((await readTaskFile(dir, 'TASK_AUTO_0001')).body).map(e => e.title)
}

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
    if (!ok) failures++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
    console.log('\n=== run-14 replay: root-cause repair channel ===\n')

    // ── BASELINE: the run-14 behavior. Two debts, nothing scheduled. ─────────
    console.log('BASELINE (run-14 behavior — debts recorded, no repair scheduled):')
    const baseline = await freshPlan()
    const baselineTitles = await titles(baseline)
    check('plan unchanged (4 steps)', baselineTitles.length === 4)
    check(
        'no repair step for the root cause',
        !planHasRepairFor(baselineTitles, 'test/teardown.ts'),
        'the teardown bug survives the whole run'
    )

    // ── TREATMENT: detect → queue → drain → merge → splice. ──────────────────
    console.log('\nTREATMENT (shipped channel):')
    const dir = await freshPlan()
    let detected = 0
    for (const taskId of ['TASK_0013', 'TASK_0019'] as const) {
        const candidate = await findRepairCandidate({
            failReason: FAILS[taskId],
            currentTaskId: taskId,
            touched: TOUCHED[taskId],
            introducedBy: rel => PROVENANCE[rel] ?? null
        })
        if (candidate) {
            detected++
            await recordRepairCandidate(dir, candidate)
        }
    }
    check('both FAILs detected a root cause', detected === 2, `${detected}/2`)

    const merged = mergeRepairCandidates(await drainRepairQueue(dir))
    check('deduped to ONE repair (run 14 would have spawned two)', merged.length === 1)
    check('accused file is the teardown', merged[0]?.file === 'test/teardown.ts', merged[0]?.file)
    check('owner is TASK_0007', merged[0]?.owner === 'TASK_0007', merged[0]?.owner)
    check(
        'both blamed tasks carried',
        merged[0]?.blamed.join(',') === 'TASK_0013,TASK_0019',
        merged[0]?.blamed.join(',')
    )

    // Splice after the step that just finished (index 0), not at the end.
    const title = buildRepairTitle(merged[0])
    await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, title)
    const after = await titles(dir)
    check('plan grew by exactly one step', after.length === 5, `${after.length}`)
    check('repair sits BEFORE the next dependent task', after[1] === title, after[1])
    check('no existing step was rewritten or dropped', PLAN.every(t => after.includes(t)))

    // Idempotence: a retry (or a third debt naming the same file) adds nothing.
    await insertTaskAfter(dir, 'TASK_AUTO_0001', 0, title)
    check('re-insert is a no-op', (await titles(dir)).length === 5)
    check('plan-side dedup rejects a second repair', planHasRepairFor(after, 'test/teardown.ts'))

    // Scoping — otherwise refine re-expands this into "overhaul test infra".
    const fence = buildRepairScopeFence(merged[0].file, merged[0].verifyCommand)
    check(
        'fence pins ONE editable file',
        fence.includes('`test/teardown.ts` is the ONLY file you may modify')
    )
    check(
        'fence pins VERIFY to the failing command',
        fence.includes('AGENT=1 bun test test/invite.test.ts')
    )

    // ── NEGATIVE CONTROLS ───────────────────────────────────────────────────
    console.log('\nNEGATIVE CONTROLS (must schedule nothing):')
    for (const taskId of ['TASK_0006', 'TASK_0010'] as const) {
        const c = await findRepairCandidate({
            failReason: FAILS[taskId],
            currentTaskId: taskId,
            touched: TOUCHED[taskId],
            introducedBy: rel => PROVENANCE[rel] ?? null
        })
        check(
            `${taskId} (${taskId === 'TASK_0006' ? 'environment-blamed' : 'spec-quoted paths only'})`,
            c === null,
            c ? `spawned a repair for ${c.file}` : ''
        )
    }

    console.log(
        `\n${failures === 0 ? 'ALL CHECKS PASS' : `${failures} CHECK(S) FAILED`} — baseline→treatment: 0 → 1 scoped repair task for test/teardown.ts\n`
    )
    process.exit(failures === 0 ? 0 : 1)
}

void main()
