/**
 * root-cause-repair tests — the mx5 run 14 fixture A/B (PROMPT item 5).
 *
 * The FAIL reasons below are VERBATIM from run 14's `.pi-tasks/accept-debt.md`.
 * TASK_0013 and TASK_0019 both ended in an enforce-revert over the SAME cause —
 * TASK_0007's `test/teardown.ts` TRUNCATE bug — and nothing ever scheduled a fix,
 * so it survived ~24h. The contract this file pins:
 *
 *   - both FAILs resolve to `test/teardown.ts` (not to the test file each names in
 *     passing, and not to the paths the spec boilerplate quotes),
 *   - the two together yield EXACTLY ONE repair task, correctly scoped,
 *   - the environment-blamed FAIL (TASK_0006, "no PostgreSQL … in this
 *     environment") and the this-task-touched-it FAIL (TASK_0010) yield none.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    buildRepairScopeFence,
    buildRepairTitle,
    drainRepairQueue,
    extractFailingCommand,
    findAccusedFile,
    findRepairCandidate,
    isEnvironmentAttributed,
    mergeRepairCandidates,
    parseRepairQueue,
    parseRepairTitleFile,
    planHasRepairFor,
    recordRepairCandidate,
    repairQueueFile,
    type RepairCandidate
} from './root-cause-repair.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-root-cause-'))
}

// ─── Verbatim mx5 run 14 ledger entries ──────────────────────────────────────

const TASK_0013_FAIL =
    'work did not verify: test/teardown.ts has a pre-existing bug (parameterized table names in '
    + 'TRUNCATE statements) causing the afterAll teardown to fail with "syntax error at or near $1", '
    + 'which means `AGENT=1 bun test test/invite.test.ts` exits non-zero despite all 10 actual tests '
    + 'passing — the VERIFY command therefore fails'

const TASK_0019_FAIL =
    'work did not verify: The shipped `bun test test/photos.test.ts` exits with code 1 due to a '
    + 'pre-existing teardown bug in `test/teardown.ts` (created by TASK_0007) that uses parameterized '
    + 'queries for table names in TRUNCATE statements, causing PostgreSQL syntax errors — this task '
    + 'did not modify the teardown'

/** Environment-attributed: no file edit repairs a missing database server. */
const TASK_0006_FAIL =
    'work unobserved: Runtime behavioral checks (admin insert, idempotency, row verification) could '
    + 'not execute because no PostgreSQL database server is available in this environment (no binary, '
    + 'no Docker, no listener on port 5432). Static checks, type-checking, linting, and env-var '
    + 'validation all pass.'

/** Names sibling files only inside the spec's own "Preserve all existing files" quote. */
const TASK_0010_FAIL =
    'work did not verify: package.json was modified (added "dev" script and dependencies '
    + '@hono/zod-validator, hono, zod) despite the spec explicitly forbidding it: "Preserve all '
    + 'existing files on disk (`src/server/db.ts`, `src/server/seed.ts`, `package.json`, '
    + '`tsconfig.json`, `eslint.config.js`). Do not'

/** run 14's provenance: TASK_0007 created the teardown; everything else is older. */
const RUN14_PROVENANCE: Record<string, string> = {
    'test/teardown.ts': 'TASK_0007',
    'test/invite.test.ts': 'TASK_0013',
    'test/photos.test.ts': 'TASK_0019',
    'src/server/db.ts': 'TASK_0002',
    'src/server/seed.ts': 'TASK_0002'
}
const run14IntroducedBy = (rel: string): string | null => RUN14_PROVENANCE[rel] ?? null

describe('accusation extraction', () => {
    test('the blamed file is the one NEAREST the blame cue, not the first path named', () => {
        // TASK_0019 names photos.test.ts BEFORE teardown.ts; only teardown.ts is accused.
        expect(findAccusedFile(TASK_0019_FAIL)?.file).toBe('test/teardown.ts')
        expect(findAccusedFile(TASK_0013_FAIL)?.file).toBe('test/teardown.ts')
    })

    test('a path merely QUOTED from the spec is not an accusation', () => {
        // "Preserve all existing files on disk" must not read as "existing bug".
        expect(findAccusedFile(TASK_0010_FAIL)).toBeNull()
    })

    test('a FAIL with no blame cue accuses nothing', () => {
        expect(
            findAccusedFile('work did not verify: src/client/pages/admin.tsx renders no heading')
        ).toBeNull()
    })

    test('environment-attributed FAILs are vetoed', () => {
        expect(isEnvironmentAttributed(TASK_0006_FAIL)).toBe(true)
        expect(isEnvironmentAttributed(TASK_0013_FAIL)).toBe(false)
        expect(isEnvironmentAttributed(TASK_0019_FAIL)).toBe(false)
    })

    test('the failing command is lifted for the repair VERIFY', () => {
        expect(extractFailingCommand(TASK_0013_FAIL)).toBe('AGENT=1 bun test test/invite.test.ts')
        expect(extractFailingCommand(TASK_0019_FAIL)).toBe('bun test test/photos.test.ts')
        // Backticked prose is not a command.
        expect(extractFailingCommand('the `syntax error at or near $1` shows up')).toBeUndefined()
    })
})

describe('findRepairCandidate — run 14 fixture', () => {
    test('TASK_0013 attributes its FAIL to TASK_0007s teardown', async () => {
        const c = await findRepairCandidate({
            failReason: TASK_0013_FAIL,
            currentTaskId: 'TASK_0013',
            touched: ['test/invite.test.ts', 'src/server/routes/invite.ts'],
            introducedBy: run14IntroducedBy
        })
        expect(c?.file).toBe('test/teardown.ts')
        expect(c?.owner).toBe('TASK_0007')
        expect(c?.blamedTask).toBe('TASK_0013')
        expect(c?.verifyCommand).toBe('AGENT=1 bun test test/invite.test.ts')
        expect(c?.defect).toContain('TRUNCATE')
    })

    test('TASK_0019 attributes its FAIL to the same file', async () => {
        const c = await findRepairCandidate({
            failReason: TASK_0019_FAIL,
            currentTaskId: 'TASK_0019',
            touched: ['test/photos.test.ts', 'src/server/routes/photos.ts'],
            introducedBy: run14IntroducedBy
        })
        expect(c?.file).toBe('test/teardown.ts')
        expect(c?.owner).toBe('TASK_0007')
    })

    test('NEGATIVE: an environment-blamed FAIL yields no repair task', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0006_FAIL,
                currentTaskId: 'TASK_0006',
                touched: [],
                introducedBy: run14IntroducedBy
            })
        ).toBeNull()
    })

    test('NEGATIVE: a file THIS task touched is never somebody elses bug', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0013_FAIL,
                currentTaskId: 'TASK_0013',
                // This time the task itself edited the teardown.
                touched: ['test/teardown.ts'],
                introducedBy: run14IntroducedBy
            })
        ).toBeNull()
    })

    test('NEGATIVE: the task that CREATED the file is not blamed for it', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0013_FAIL,
                currentTaskId: 'TASK_0007',
                touched: [],
                introducedBy: run14IntroducedBy
            })
        ).toBeNull()
    })

    test('NEGATIVE: unknown provenance is not evidence', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0013_FAIL,
                currentTaskId: 'TASK_0013',
                touched: [],
                introducedBy: () => null
            })
        ).toBeNull()
    })

    test('NEGATIVE: an unreadable tree (touched === null) stands the channel down', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0013_FAIL,
                currentTaskId: 'TASK_0013',
                touched: null,
                introducedBy: run14IntroducedBy
            })
        ).toBeNull()
    })

    test('a throwing provenance lookup degrades to no candidate', async () => {
        expect(
            await findRepairCandidate({
                failReason: TASK_0013_FAIL,
                currentTaskId: 'TASK_0013',
                touched: [],
                introducedBy: () => {
                    throw new Error('git exploded')
                }
            })
        ).toBeNull()
    })
})

describe('A/B: run 14s two teardown debts produce exactly ONE scoped repair task', () => {
    test('dedup by file, both blamed tasks named, scoped to the one file', async () => {
        const candidates: RepairCandidate[] = []
        for (const [taskId, failReason, touched] of [
            ['TASK_0013', TASK_0013_FAIL, ['test/invite.test.ts']],
            ['TASK_0019', TASK_0019_FAIL, ['test/photos.test.ts']]
        ] as const) {
            const c = await findRepairCandidate({
                failReason,
                currentTaskId: taskId,
                touched: [...touched],
                introducedBy: run14IntroducedBy
            })
            if (c) candidates.push(c)
        }
        expect(candidates).toHaveLength(2) // two FAILs…

        const merged = mergeRepairCandidates(candidates)
        expect(merged).toHaveLength(1) // …ONE repair task.
        expect(merged[0].file).toBe('test/teardown.ts')
        expect(merged[0].owner).toBe('TASK_0007')
        expect(merged[0].blamed).toEqual(['TASK_0013', 'TASK_0019'])

        const title = buildRepairTitle(merged[0])
        expect(title.startsWith('repair test/teardown.ts: ')).toBe(true)
        expect(title).toContain('(root cause of TASK_0013, TASK_0019 debts)')
        // The title round-trips to the file, which is the plan-side dedup key.
        expect(parseRepairTitleFile(title)).toBe('test/teardown.ts')
        expect(planHasRepairFor([title], 'test/teardown.ts')).toBe(true)
        expect(planHasRepairFor([title], 'test/setup.ts')).toBe(false)

        // SCOPED: exactly one editable file, and VERIFY pinned to the failing command.
        const fence = buildRepairScopeFence(merged[0].file, merged[0].verifyCommand)
        expect(fence).toContain('`test/teardown.ts` is the ONLY file you may modify')
        expect(fence).toContain('AGENT=1 bun test test/invite.test.ts')
        expect(fence).toContain('do not create new files')
        expect(fence).toContain('Do not delete or weaken any existing test')
    })

    test('a plan that already carries the repair rejects a second one (cap 1 per run)', () => {
        const shipped = 'repair test/teardown.ts: pre-existing bug (root cause of TASK_0013 debts)'
        // Even checked-off, so a repair that itself FAILED is never re-spawned.
        expect(planHasRepairFor([`${shipped}`], 'test/teardown.ts')).toBe(true)
    })
})

describe('durable queue', () => {
    const candidate = (over: Partial<RepairCandidate> = {}): RepairCandidate => ({
        file: 'test/teardown.ts',
        owner: 'TASK_0007',
        defect: 'parameterized table names in TRUNCATE statements',
        blamedTask: 'TASK_0013',
        verifyCommand: 'AGENT=1 bun test test/invite.test.ts',
        ...over
    })

    test('records, round-trips, and drains once', async () => {
        const cwd = makeCwd()
        await recordRepairCandidate(cwd, candidate())
        await recordRepairCandidate(cwd, candidate({blamedTask: 'TASK_0019'}))
        // Same (file, task) twice is one record.
        await recordRepairCandidate(cwd, candidate())

        const stored = parseRepairQueue(fs.readFileSync(repairQueueFile(cwd), 'utf8'))
        expect(stored).toHaveLength(2)
        expect(mergeRepairCandidates(stored)).toHaveLength(1)

        const drained = await drainRepairQueue(cwd)
        expect(drained).toHaveLength(2)
        // Draining clears — the plan entry is the dedup key from here on.
        expect(await drainRepairQueue(cwd)).toEqual([])
    })

    test('a missing queue drains empty rather than throwing', async () => {
        expect(await drainRepairQueue(makeCwd())).toEqual([])
    })

    test('malformed lines are skipped, not thrown on', () => {
        expect(parseRepairQueue('garbage\n\nfile\towner\n')).toEqual([])
    })
})
