/**
 * STEP 0 item 2 — the LIVE baseline for F-2: does a TYPE-ONLY answer terminate research?
 *
 * WHAT F-2 IS, and what it is NOT. Escalation is NOT broken. scripts/live-search-
 * escalation-probe.ts measures that seam at 5/5 on both its fixtures, and run 15 agrees:
 * in TASK_0024 the worker went docs -> search -> fetch -> search, in that very run, on
 * this very model. An earlier reading of the artifacts said "no escalation" and it was
 * WRONG; do not re-adopt it.
 *
 * The actual defect is narrower. Escalation fires when the worker perceives a fact as
 * MISSING. A type signature is not missing — it is a well-formed, confident, on-topic
 * answer naming the very parameter asked about. So it TERMINATES the search while leaving
 * the semantics unknown. Is `baseUrl` an origin, or a mount prefix? The type cannot say.
 * In run 15's TASK_0027 the worker made 17 docs calls (4 to hono/client, 13 to `.`), ZERO
 * search, ZERO fetch, and worker:context then filled the semantic gap from memory — F-1,
 * which killed the product.
 *
 * ── WHY THIS HARNESS DOES NOT STUB pi-worker-docs ──────────────────────────────────────
 *
 * It did, at first, and the stub INVERTED the result. Measured 2026-07-22: with docs
 * stubbed to return the recorded type-only answer for EVERY query, the worker escalated
 * 8/8 on both fixtures — apparently disproving F-2. It disproved nothing. A stub that
 * answers "what are the listings routes?" with the `hc` type signature builds a WALL: an
 * obviously-broken tool, where escalating is the only sane response. That is the
 * escalation seam, already known saturated.
 *
 * F-2's mechanism needs the opposite conditions — docs mostly WORKING, one answer quietly
 * insufficient. Run 15's worker spent 13 of 17 calls on project source getting real,
 * useful answers; it never hit a wall and never noticed the gap.
 *
 * So this harness stubs NOTHING. It runs the real phaseResearch against the run's own
 * pre-TASK_0027 tree and records escalation at the TOOL LAYER. Across two runs (8 + 10
 * reps), 14 of 17 reps that consulted docs TERMINATED without escalating — the worker asks
 * "hc base URL parameter, how to construct client…", gets the type, and stops. F-2 is real
 * but NOT absolute: 3 reps DID escalate, and in one the worker fetched exactly
 * hono.dev/docs/guides/rpc — the spec-cited page that would have prevented the fatal bug.
 * That is the point of PROMPT 2: make the ~18% correct escalation reliable, not invent it.
 * (An earlier note here said "182 docs / 0 escalation across 8 reps"; that was the first
 * run only and read optimistically. The two-run aggregate is the honest number.)
 *
 * METRIC — mechanical, tool-layer, never model self-report. phaseResearch routes every
 * child tool call through onChildOutput (child-process.ts:319-325 emits at
 * tool_execution_start), so the trial log records `worker:apis: pi-worker-<tool>: …` for
 * each invocation. That is the SAME channel run 15 was audited from. A trial ESCALATED
 * iff its log gains a search or fetch line.
 *
 * THIS PROBE MUST FAIL LOUDLY IF THE BASELINE ESCALATES. Per nexxtasks: if the shipped
 * worker already escalates past a type-only answer, F-2's mechanism is wrong and PROMPT 2
 * is void. Stop and re-derive; do not "fix" a working seam.
 *
 * Run (PI_BIN mandatory — an unset PI_BIN self-spawns a fork bomb). `bun run build` first:
 * the probe imports from dist/ so the docs extension path resolves (see the import note).
 *   PI_BIN=$(command -v pi) bun run scripts/live-typeonly-answer-probe.ts [REPS]
 * To score an already-completed probe run instead of spending model time again:
 *   PROBE_DIR=~/tmp/context-attribution-probe bun run scripts/live-typeonly-answer-probe.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// From dist/, not src/ — phaseResearch resolves DOCS_EXTENSION_PATH relative to its own
// module as a .js, which exists only in the build. See live-context-attribution-probe.ts.
import {phaseResearch} from '../dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
import {reportArm, type Invariant} from './ab-verdict.js'
import {REFINED_27, buildPreTask27Tree} from './run15-fixture-tree.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS = Number(process.argv[2] ?? '8')
const ROOT = path.join(os.homedir(), 'tmp', 'typeonly-answer-probe')
const TRIAL_TIMEOUT_MS = 45 * 60_000

/** Tool-layer counts for one trial, read back from the debug log the run itself wrote. */
export interface TrialCounts {
    docs: number
    dotDocs: number
    search: number
    fetch: number
}

export function countToolCalls(log: string): TrialCounts {
    const lines = log.split('\n')
    const n = (re: RegExp): number => lines.filter(l => re.test(l)).length
    return {
        docs: n(/pi-worker-docs:/),
        dotDocs: n(/pi-worker-docs: \.(\s|$)/),
        search: n(/pi-worker-search:/),
        fetch: n(/pi-worker-fetch:/)
    }
}

async function main(): Promise<void> {
        await requirePreconditions('live-typeonly-answer-probe', {model: {}, piBin: true, cacheOff: true})

    const scoreOnly = process.env.PROBE_DIR
    const counts: TrialCounts[] = []

    if (scoreOnly) {
        // Score a completed run of the same real-flow fixture. The logs were written by
        // the shipped tool layer, so they are evidence of equal standing.
        console.log(`live-typeonly-answer-probe — SCORING EXISTING RUN ${scoreOnly}`)
        const dirs = fs
            .readdirSync(scoreOnly)
            .filter(d => /^trial-\d+$/.test(d))
            .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
        for (const d of dirs) {
            const lp = path.join(scoreOnly, d, 'trial.log')
            if (!fs.existsSync(lp)) continue
            const c = countToolCalls(fs.readFileSync(lp, 'utf8'))
            counts.push(c)
            console.log(
                `  ${d}: docs=${c.docs} (dot=${c.dotDocs}) search=${c.search} fetch=${c.fetch}`
                    + `  escalated=${c.search + c.fetch > 0 ? 'YES' : 'no'}`
            )
        }
    } else {
        console.log(
            `live-typeonly-answer-probe — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
                + `real phaseResearch, NOTHING stubbed, ${REPS} reps on the pre-TASK_0027 tree`
        )
        for (let t = 1; t <= REPS; t++) {
            const dir = buildPreTask27Tree(ROOT, t)
            const abort = new AbortController()
            const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
            const logPath = path.join(dir, 'trial.log')
            const deps: PhaseDeps = {
                cwd: dir,
                taskId: 'TASK_0027',
                signal: abort.signal,
                onChildOutput: l => fs.appendFileSync(logPath, l + '\n'),
                logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`)
            }
            const started = Date.now()
            try {
                await phaseResearch(deps, REFINED_27)
            } catch (e) {
                console.log(`  trial ${t}: ERROR ${String(e).slice(0, 140)}`)
            } finally {
                clearTimeout(timer)
            }
            const c = countToolCalls(
                fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
            )
            counts.push(c)
            console.log(
                `  trial ${t}/${REPS}: docs=${c.docs} (dot=${c.dotDocs}) search=${c.search}`
                    + ` fetch=${c.fetch}  escalated=${c.search + c.fetch > 0 ? 'YES' : 'no'}`
                    + `  [${((Date.now() - started) / 60000).toFixed(1)}m]`
            )
        }
    }

    // Precondition: the worker must CONSULT docs before it can terminate ON docs. A trial
    // that never called docs measures nothing about this seam — it did not "accept a type
    // signature and stop", it simply did not research. Such trials are excluded from BOTH
    // the numerator and the denominator; counting them as terminations would inflate the
    // baseline with reps that never exercised the mechanism.
    const consultedTrials = counts.filter(c => c.docs > 0)
    const escalated = consultedTrials.filter(c => c.search + c.fetch > 0).length
    const terminated = consultedTrials.length - escalated
    const totalDocs = counts.reduce((a, c) => a + c.docs, 0)
    const noResearch = counts.length - consultedTrials.length

    console.log(
        `\ndocs calls ${totalDocs} across ${counts.length} trial(s); `
            + `${consultedTrials.length} consulted docs`
            + (noResearch > 0 ? ` (${noResearch} never called docs — excluded)` : '')
            + `; escalated to search/fetch in ${escalated}`
    )

    const invariants: Invariant[] = [
        {
            label: 'reps >= 8 — the floor for a model-variable seam',
            ok: consultedTrials.length >= 8,
            detail: `${consultedTrials.length} trials that consulted docs`
        },
        {
            label: 'docs was actually exercised (else nothing was measured)',
            ok: totalDocs > 0,
            detail: `${totalDocs} docs calls`
        }
    ]

    reportArm({
        name: 'live-typeonly-answer-probe',
        arm: 'baseline/real-flow',
        reps: consultedTrials.length,
        targetShape:
            'the APIS worker TERMINATING without escalating — accepting a type signature '
            + 'as the answer to a usage question and never reaching search or fetch (F-2). '
            + 'If the baseline escalates, F-2 is disproved and PROMPT 2 is void: stop and '
            + 're-derive rather than "fixing" a working seam.',
        hits: terminated,
        witnessed: consultedTrials.length,
        expect: 'some',
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
