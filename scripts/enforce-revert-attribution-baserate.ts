/**
 * STEP 0 — base rate for the ENFORCE-DIFFERENTIAL ATTRIBUTION lever (nexttask 4),
 * measured BEFORE the gate is changed. Deterministic, no model, no PI_BIN.
 *
 * Question: across every enforce-revert this project has recorded, how many would
 * the lever ("attribute the re-verify FAIL against the ENFORCE COMMIT's file set,
 * not the TASK's") flip from REVERT to KEEP — and how many would it wrongly keep?
 *
 * Pools:
 *   run 18  — TASK_0024, the incident this lever was designed on. One revert, the
 *             verbatim reason from `~/hub/mx5/.pi-tasks/accept-debt.md`, with the
 *             real enforce diff recoverable from `evidence/run18-enforce-revert`.
 *             Methodology rule 2: a lever measured on its own design sample proves
 *             nothing on its own, and this is stated in the report, not buried.
 *   run 14  — TASK_0013 and TASK_0019, both enforce-reverts, reasons verbatim from
 *             run 14's ledger (already fixtured in replay-run14-root-cause.ts).
 *             Their ENFORCE DIFFS ARE UNRECOVERABLE: run 14's reverts dropped those
 *             commits and `~/hub/mx5` has since been rebuilt by run 18, so no
 *             reflog holds them. They are reported as a CONDITIONAL pool — what the
 *             enforce diff would have had to contain to make the lever revert —
 *             never as a confirmed flip.
 *
 * Also measured, because it is the second half of why run 18 could not be
 * attributed: whether the SHIPPED root-cause extractor (findAccusedFile, which
 * requires a path separator) can see the file each reason names at all.
 *
 * Run: bun run scripts/enforce-revert-attribution-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {attributeEnforceFailure, extractFailingFiles, resolveNamedFile} from '../src/task/enforce-attribution.js'
import {findAccusedFile} from '../src/task/root-cause-repair.js'

const MX5 = process.env.MX5_REPO ?? path.join(os.homedir(), 'hub', 'mx5')

interface Incident {
    run: string
    taskId: string
    /** Verbatim recorded FAIL reason. */
    reason: string
    /** E — files the ENFORCE commit changed; null when unrecoverable. */
    enforceTouched: string[] | null
    /** T — files the TASK's own commit changed (the question the shipped code asks). */
    taskTouched: string[] | null
    /** What actually happened in the run. */
    reverted: boolean
    note?: string
}

// ─── run 18 (design sample) ──────────────────────────────────────────────────

/** Verbatim from `~/hub/mx5/.pi-tasks/accept-debt.md`, origin `enforce-revert`. */
const RUN18_REASON =
    'work did not verify: 1 of 51 Playwright CT tests fails (MyListings.spec.tsx:186 — "toggle Mark as '
    + 'Sold / Undo Sold updates listing status in-place") due to a pre-existing flaky locator collision '
    + "where getByText('SOLD', {exact: true}) resolves to 2 elements; however, this test file was NOT modified b"

/** Fallback when the mx5 repo is absent: the file sets read off the tagged commits. */
const RUN18_ENFORCE_FALLBACK = ['.pi-tasks/TASK_0024.md', 'src/client/pages/Admin.tsx']
const RUN18_REPO_FILES_FALLBACK = [
    'src/client/pages/Admin.tsx',
    'src/client/pages/MyListings.tsx',
    'src/client/pages/MyListings.spec.tsx',
    'src/client/pages/MyListings.stories.tsx'
]

// ─── run 14 (independent pool, enforce diffs unrecoverable) ──────────────────

const RUN14: Incident[] = [
    {
        run: 'run 14',
        taskId: 'TASK_0013',
        reason:
            'work did not verify: test/teardown.ts has a pre-existing bug (parameterized table names in '
            + 'TRUNCATE statements) causing the afterAll teardown to fail with "syntax error at or near $1", '
            + 'which means `AGENT=1 bun test test/invite.test.ts` exits non-zero despite all 10 actual tests '
            + 'passing — the VERIFY command therefore fails',
        enforceTouched: null,
        taskTouched: ['test/invite.test.ts', 'src/server/routes/invite.ts'],
        reverted: true,
        note: 'enforce diff unrecoverable (run 14 reverted it; repo rebuilt by run 18)'
    },
    {
        run: 'run 14',
        taskId: 'TASK_0019',
        reason:
            'work did not verify: The shipped `bun test test/photos.test.ts` exits with code 1 due to a '
            + 'pre-existing teardown bug in `test/teardown.ts` (created by TASK_0007) that uses parameterized '
            + 'queries for table names in TRUNCATE statements, causing PostgreSQL syntax errors — this task '
            + 'did not modify the teardown',
        enforceTouched: null,
        taskTouched: ['test/photos.test.ts', 'src/server/routes/photos.ts'],
        reverted: true,
        note: 'enforce diff unrecoverable (run 14 reverted it; repo rebuilt by run 18)'
    }
]

// ─── evidence loading ────────────────────────────────────────────────────────

function git(args: string[]): string | null {
    const r = spawnSync('git', args, {cwd: MX5, encoding: 'utf8'})
    if (r.error || r.status !== 0) return null
    return r.stdout
}

function haveEvidence(): boolean {
    return fs.existsSync(MX5) && git(['rev-parse', '--verify', 'evidence/run18-enforce-revert']) !== null
}

function filesOf(rev: string): string[] | null {
    const out = git(['show', '--name-only', '--format=', rev])
    if (out === null) return null
    return out
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
}

function repoFiles(): string[] | null {
    const out = git(['ls-files'])
    return out === null ? null : out.split('\n').map(l => l.trim()).filter(Boolean)
}

// ─── report ──────────────────────────────────────────────────────────────────

function intersects(a: string[], b: string[], files: string[] | null): string[] {
    const norm = (p: string): string => p.replace(/^\.\//, '').toLowerCase()
    const resolved = a.map(n => resolveNamedFile(n, files) ?? n)
    return resolved.filter(n =>
        b.some(x => norm(x) === norm(n) || norm(x).endsWith(`/${norm(n)}`) || norm(n).endsWith(`/${norm(x)}`))
    )
}

function main(): void {
    const live = haveEvidence()
    const files = live ? repoFiles() : RUN18_REPO_FILES_FALLBACK
    const enforce18 = (live ? filesOf('evidence/run18-enforce-revert') : null) ?? RUN18_ENFORCE_FALLBACK
    const task18 = (live ? filesOf('evidence/run18-task24') : null) ?? [
        'src/client/pages/MyListings.tsx',
        'src/client/pages/Admin.tsx'
    ]

    const incidents: Incident[] = [
        {
            run: 'run 18',
            taskId: 'TASK_0024',
            reason: RUN18_REASON,
            enforceTouched: enforce18,
            taskTouched: task18,
            reverted: true,
            note: live ? 'enforce diff read from evidence/run18-enforce-revert' : 'evidence tags absent — embedded fallback'
        },
        ...RUN14
    ]

    console.log(`evidence source: ${live ? `${MX5} (tags present)` : 'embedded fallback (mx5 repo/tags absent)'}`)
    console.log('')

    let wouldFlip = 0
    let wouldKeepWrongly = 0
    let conditional = 0
    let shippedExtractorBlind = 0

    for (const inc of incidents) {
        const named = extractFailingFiles(inc.reason)
        const resolved = named.map(n => resolveNamedFile(n, files) ?? n)
        const inE = inc.enforceTouched ? intersects(named, inc.enforceTouched, files) : null
        const inT = inc.taskTouched ? intersects(named, inc.taskTouched, files) : null
        const verdict = attributeEnforceFailure({
            failReason: inc.reason,
            enforceTouched: inc.enforceTouched,
            repoFiles: files
        })
        const accused = findAccusedFile(inc.reason)

        console.log(`── ${inc.run} ${inc.taskId}`)
        console.log(`   actual outcome            : ${inc.reverted ? 'REVERTED' : 'kept'}`)
        console.log(`   F  failing files named    : ${resolved.join(', ') || '(none)'}`)
        console.log(`   E  enforce diff           : ${inc.enforceTouched?.join(', ') ?? 'UNRECOVERABLE'}`)
        console.log(`   T  task commit            : ${inc.taskTouched ? `${inc.taskTouched.slice(0, 4).join(', ')}${inc.taskTouched.length > 4 ? ` (+${inc.taskTouched.length - 4} more)` : ''}` : 'unknown'}`)
        console.log(`   E ∩ F                     : ${inE === null ? 'unknown' : inE.join(', ') || 'EMPTY  → lever KEEPS'}`)
        console.log(`   T ∩ F                     : ${inT === null ? 'unknown' : inT.join(', ') || 'EMPTY  → shipped authorship test would keep'}`)
        console.log(`   lever verdict             : ${verdict.verdict.toUpperCase()} (${verdict.why})`)
        console.log(`   shipped extractor sees    : ${accused ? accused.file : 'NOTHING (no path-separator token in the reason)'}`)
        if (inc.note) console.log(`   note                      : ${inc.note}`)
        console.log('')

        if (!accused) shippedExtractorBlind++
        if (inc.enforceTouched === null) {
            conditional++
            continue
        }
        if (inc.reverted && verdict.verdict === 'keep') wouldFlip++
        if (!inc.reverted && verdict.verdict === 'keep') wouldKeepWrongly++
    }

    const measurable = incidents.filter(i => i.enforceTouched !== null)
    console.log('── SUMMARY')
    console.log(`   incidents with a recoverable enforce diff : ${measurable.length}`)
    console.log(`   reverts the lever would FLIP to keep      : ${wouldFlip} of ${measurable.filter(i => i.reverted).length}`)
    console.log(`   reverts it would WRONGLY keep             : ${wouldKeepWrongly}`)
    console.log(`   incidents that stay CONDITIONAL           : ${conditional} (enforce diff unrecoverable)`)
    console.log(`   reasons the SHIPPED extractor cannot see  : ${shippedExtractorBlind} of ${incidents.length}`)
    console.log('')
    console.log('   CAVEAT (methodology rule 2): the only pool with a recoverable enforce diff is run 18,')
    console.log('   the incident this lever was DESIGNED on — n=1, self-measured, and it proves only that')
    console.log('   the lever fires on its own design sample. Run 14 cannot confirm it: its enforce commits')
    console.log('   were destroyed by the very reverts under study. The A/B harnesses carry the weight.')
    console.log('')
    console.log('   For run 14 the conditional reads: the lever KEEPS unless the enforce diff itself touched')
    console.log('   one of the files each reason names — for TASK_0013 {test/teardown.ts, test/invite.test.ts},')
    console.log('   for TASK_0019 {test/photos.test.ts, test/teardown.ts}. A guideline/lint pass touching the')
    console.log('   teardown it did not write is possible, so neither is counted as a flip.')
}

main()
