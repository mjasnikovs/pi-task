/**
 * nexttask 5B — the two candidate bounds on worker:apis's project-source fan-out.
 *
 * ⚠ ONE of the levers in this file is wired: the RESCUE progress deadline
 * (`workerProgressCeilingMs`) SHIPPED ON in nexttask 9, on a PASS measured over 42
 * trials per arm against an instrument whose own false-break rate is on record at
 * 1.5%. CAP, SCALE and RESCUE-CARRY remain OFF unless their env var is set — CAP
 * and SCALE were rejected on argument (see below), carry-forward was measured
 * HARMFUL on its own.
 *
 * The OFF levers exist so `scripts/live-research-fanout-budget-ab.ts` can run them
 * against the shipped baseline in the SAME build — the alternative (dist surgery)
 * measures a patched copy of the code and not the code. Nothing may read them
 * outside that harness until it reports PASS; a lever wired on argument rather
 * than measurement is the failure mode nexttasks exists to prevent.
 *
 * THE FAULT THEY TARGET (mx5 run 18, measured — scripts/research-restart-baserate.ts):
 * `worker:apis` fans out `pi-worker-docs(module: ".")` project-source lookups, each
 * of which spawns its own summarising child, and the per-worker wall-clock cap is
 * 240s. Pearson r(project lookups, worker wall clock) = 0.909 over 24 tasks. 0-4
 * lookups never timed out; every worker at >=46 lookups burned the FULL restart
 * budget — 3 attempts, 720s, two of them discarded whole. The 240s ceiling and a
 * 46-call fan-out are jointly unsatisfiable, so the timeout is not a backstop
 * there, it is the guaranteed outcome.
 *
 * TWO WAYS TO MAKE THEM SATISFIABLE, and the A/B — not this comment — decides:
 *
 *   CAP     bound the fan-out to fit the ceiling. Told to the worker upfront
 *           (projectDocsBudgetNotice) and enforced in the tool
 *           (projectDocsBudgetExhausted), because run 18 shows the prompt alone
 *           does not bind: the same worker is ALREADY told "be decisive" by
 *           WORKER_TIMEOUT_HINT on every restart.
 *   SCALE   bound the ceiling to fit the fan-out: each project-source lookup
 *           pushes the deadline out, up to a hard ceiling, so a worker that is
 *           making progress is not killed for making progress.
 *
 * The risk each carries, and why the A/B's quality invariant is load-bearing: CAP
 * can produce a faster worker that ships a THINNER APIS section, which is a
 * regression wearing a win's clothes (memory/apis-contract-stage2-failed.md: a
 * lever moved behaviour 20/20 while fabricating 15% of it). SCALE can simply
 * spend the extra time and still time out, buying nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH OF THE ABOVE ANSWER THE WRONG QUESTION. Kept for the record and for the
 * A/B's other arms, but they are not the fix.
 *
 * They argue about how long a worker may run. The actual defect is what happens
 * when it runs out: the attempt is killed and everything it produced is THROWN
 * AWAY, and the re-spawn is given a hint but no findings — so it re-reads the
 * same files against the same clock and dies in the same place. That is why
 * every worker at >=46 lookups burned the FULL budget rather than converging.
 * The r=0.909 correlation measures the amnesia, not an over-long task.
 *
 * Judged against "the worker must return its work", CAP makes the worker read
 * LESS — lowering the requirement so the metric goes green — and SCALE is a
 * per-file constant that dies on one big file, and, being wall-clock, makes
 * answer quality a function of the user's hardware: the same task on a slower
 * local model loses its work and degrades. No constant fixes that.
 *
 *   RESCUE  (pi-worker-core.ts) carry the killed attempt's findings into the
 *           next one and never return less than the best attempt produced, so a
 *           restart CONVERGES instead of repeating; and deadline on lack of
 *           PROGRESS rather than elapsed time, so "slow" and "stuck" stop being
 *           the same verdict. Being stuck is already detected separately and
 *           correctly by the output-stall probe (STALL_AFTER_MS), which resets
 *           on progress and only kills when the model endpoint is unreachable.
 *
 * Its risk is its own, and the same quality invariant catches it: a half-written
 * entry replayed under "work already done" is exactly how a fabrication gets
 * laundered into a final answer. Hence the carry is framed as unverified, and
 * ungrounded-symbol and anti-synthesis counts gate the arm.
 */

/** Max project-source (`module: "."`) docs lookups per worker ATTEMPT. Unset = no cap. */
export const PROJECT_DOCS_BUDGET_ENV = 'PI_TASK_PROJECT_DOCS_BUDGET'
/** Deadline extension granted per project-source lookup, in ms. Unset = no extension. */
export const FANOUT_TIMEOUT_PER_LOOKUP_ENV = 'PI_TASK_FANOUT_TIMEOUT_PER_LOOKUP_MS'
/** Hard ceiling the extensions may never push the deadline past, in ms. */
export const FANOUT_TIMEOUT_CEILING_ENV = 'PI_TASK_FANOUT_TIMEOUT_CEILING_MS'

/** RESCUE: carry a killed attempt's findings into the re-spawn, and salvage its output. `1` = on. */
export const WORKER_CARRY_FORWARD_ENV = 'PI_TASK_WORKER_CARRY_FORWARD'

/** RESCUE: deadline on lack of progress instead of elapsed time. Value = absolute ceiling, ms. */
export const WORKER_PROGRESS_CEILING_ENV = 'PI_TASK_WORKER_PROGRESS_CEILING_MS'

type Env = (key: string) => string | undefined
const defaultEnv: Env = key => process.env[key]

function positiveInt(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/**
 * The CAP arm's budget, or null when the lever is off (the shipped default).
 * A non-numeric or non-positive value is off too: a typo'd env var must not
 * silently cap the worker at 0 lookups.
 */
export function projectDocsBudget(env: Env = defaultEnv): number | null {
    return positiveInt(env(PROJECT_DOCS_BUDGET_ENV))
}

/**
 * The SCALE arm's policy, or null when off. Both halves are required: an
 * extension with no ceiling is an unbounded worker, which is the one thing the
 * 240s cap exists to prevent.
 */
export function fanoutTimeoutPolicy(
    env: Env = defaultEnv
): {perLookupMs: number; ceilingMs: number} | null {
    const perLookupMs = positiveInt(env(FANOUT_TIMEOUT_PER_LOOKUP_ENV))
    const ceilingMs = positiveInt(env(FANOUT_TIMEOUT_CEILING_ENV))
    return perLookupMs !== null && ceilingMs !== null ? {perLookupMs, ceilingMs} : null
}

/**
 * The RESCUE arm's two halves, or nulls when off.
 *
 * Separated because they are independent claims and the A/B should be able to
 * attribute a win: RESCUE_CARRY says a restart should keep what the killed
 * attempt found, RESCUE_PROGRESS_CEILING says a worker should be killed for
 * going quiet rather than for taking a while. Either can pay off without the
 * other, and either can fabricate or hang without the other.
 */
export function workerCarryForward(env: Env = defaultEnv): boolean {
    return env(WORKER_CARRY_FORWARD_ENV) === '1'
}

/**
 * The absolute backstop for the progress-based deadline.
 *
 * WHY THIS NUMBER. It is not a budget and it does not decide how long a worker
 * may take — the no-progress deadline does that, and it resets on every tool call.
 * This is the last-resort bound on a worker that never stops moving (an infinite
 * tool-call loop the loop detector somehow misses), so its only requirement is to
 * sit clear of the real workload. Measured on 42 progress-arm trials
 * (`~/tmp/research-fanout-ab-v3`): median 275s, p90 523s, **max 730s**. 20 minutes
 * is 1.6x the observed worst case, and 1.7x the 720s the SHIPPED path already
 * spends on a worker that burns all three attempts and returns nothing.
 *
 * A ceiling that never fires in production is the correct behaviour for a
 * backstop, not evidence it is untested: it fires under test
 * (`pi-worker-core.test.ts` — 'the absolute ceiling still bounds a worker that
 * never stops moving'), and a worker that goes QUIET is killed long before it, at
 * `timeoutMs` without progress and by the stall probe.
 */
export const DEFAULT_WORKER_PROGRESS_CEILING_MS = 1_200_000

/**
 * The progress-based deadline's ceiling, or null when the lever is OFF.
 *
 * SHIPPED ON as of nexttask 9 — the env var is now the OFF switch, not the on
 * switch. Measured baseline vs progress over 42 trials/arm on a calibrated
 * instrument (A/A false-break 1.5%): worker-timeout restarts 22/24 → 0/24,
 * degrades 8/24 → 0/24, entries up on all four high-fan-out fixtures (TASK_0021
 * 11.0 → 25.5), quality invariants HOLD, every treatment-arm ungrounded flag
 * hand-verified as an instrument artifact rather than a fabrication.
 *
 *     unset            ON at DEFAULT_WORKER_PROGRESS_CEILING_MS
 *     "0" | "off"      OFF — the fixed elapsed-time cap, exactly as before
 *     positive int     ON at that ceiling, in ms
 *
 * A garbage value keeps the SHIPPED behaviour rather than silently disabling the
 * lever: turning it off is a decision and has to be spelled.
 */
export function workerProgressCeilingMs(env: Env = defaultEnv): number | null {
    const raw = env(WORKER_PROGRESS_CEILING_ENV)
    if (raw === undefined || raw.trim() === '') return DEFAULT_WORKER_PROGRESS_CEILING_MS
    if (raw.trim() === '0' || raw.trim().toLowerCase() === 'off') return null
    return positiveInt(raw) ?? DEFAULT_WORKER_PROGRESS_CEILING_MS
}

/**
 * The upfront half of the CAP arm, appended to the APIS worker's prompt.
 *
 * Upfront and NUMERIC on purpose. The worker cannot ration a budget it learns
 * about only when it is spent, and "be decisive" — which it already receives on
 * every timeout restart — is exactly the unquantified version that run 18 shows
 * it ignoring until the third attempt.
 */
export function projectDocsBudgetNotice(budget: number): string {
    return (
        `\n\nLOOKUP BUDGET: you may make at most ${budget} project-source `
        + '`pi-worker-docs` calls (module: ".") in this attempt. They are the most '
        + 'expensive thing you can do — each one runs a separate model pass — and '
        + 'past the budget the tool returns nothing at all. Spend them only on '
        + 'symbols you will actually list in APIS, batch related questions about '
        + 'one file into a single call, and read a file directly with `read` when '
        + 'you just need to see it. When the budget runs out, write your answer '
        + 'from what you already have.'
    )
}

/** The enforcement half: what the tool returns once the budget is spent. */
export function projectDocsBudgetExhausted(budget: number): string {
    return (
        `PROJECT LOOKUP BUDGET SPENT — you have used all ${budget} project-source `
        + 'docs lookups for this attempt and no further ones will run. Do NOT retry '
        + 'this call or rephrase it; it will return this same message. Use `read` or '
        + '`grep` if you must see one more file, then write your answer now from what '
        + 'you already retrieved.'
    )
}
