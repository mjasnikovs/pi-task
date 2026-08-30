/**
 * research-fanout-budget — the levers bounding worker:apis's project-source
 * fan-out, and which of them is on.
 *
 * `workerProgressCeilingMs` is ON by default; its env var is the OFF switch. CAP
 * (`projectDocsBudget`), SCALE (`fanoutTimeoutPolicy`) and RESCUE-CARRY
 * (`workerCarryForward`) are OFF unless their env var is set. They stay in the
 * shipped build so a harness can run them against the shipped baseline in the SAME
 * build — patching a copy of the code measures the copy, not the code. Nothing may
 * read them outside such a harness.
 *
 * THE FAULT THEY TARGET. `worker:apis` fans out `pi-worker-docs(module: ".")`
 * project-source lookups, and each one spawns its own summarising child. Under a
 * fixed wall-clock cap, a large enough fan-out cannot finish inside it — so the
 * timeout is not a backstop there, it is the guaranteed outcome.
 *
 *   CAP     bound the fan-out to fit the ceiling. Told to the worker upfront
 *           (projectDocsBudgetNotice) and enforced in the tool
 *           (projectDocsBudgetExhausted). The prompt alone does not bind: the same
 *           worker is ALREADY told "be decisive" by WORKER_TIMEOUT_HINT
 *           (pi-worker-core.ts) on every restart.
 *   SCALE   bound the ceiling to fit the fan-out: each project-source lookup pushes
 *           the deadline out, up to a hard ceiling, so a worker that is making
 *           progress is not killed for making progress.
 *
 * BOTH ANSWER THE WRONG QUESTION. They argue about how long a worker may run. The
 * defect is what happens when it runs out: the attempt is killed, everything it
 * produced is THROWN AWAY, and the re-spawn gets a hint but no findings — so it
 * re-reads the same files against the same clock and dies in the same place.
 *
 * Judged against "the worker must return its work", CAP makes the worker read
 * LESS, lowering the requirement so the metric goes green; and SCALE is a per-file
 * constant that dies on one big file and, being wall-clock, makes answer quality a
 * function of the user's hardware — the same task on a slower model loses its work.
 *
 *   RESCUE  (pi-worker-core.ts) carry the killed attempt's findings into the next
 *           one and never return less than the best attempt produced, so a restart
 *           CONVERGES instead of repeating; and deadline on lack of PROGRESS rather
 *           than elapsed time, so "slow" and "stuck" stop being the same verdict.
 *           Being stuck is already detected separately by the output-stall probe
 *           (STALL_AFTER_MS, worker-profiles.ts), which resets on progress.
 *
 * The carry has a risk of its own: a half-written entry replayed under "work
 * already done" is how a fabrication gets laundered into a final answer. That is
 * why the carry is framed to the worker as unverified.
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

/**
 * Every lever env var this module owns.
 *
 * Exists so `snapshotLeverEnv` cannot drift from the levers: adding a lever
 * without adding it here would leave that one lever read LATE, which is the
 * half-applied arm the snapshot exists to prevent.
 */
export const RESEARCH_LEVER_ENVS: readonly string[] = [
    PROJECT_DOCS_BUDGET_ENV,
    FANOUT_TIMEOUT_PER_LOOKUP_ENV,
    FANOUT_TIMEOUT_CEILING_ENV,
    WORKER_CARRY_FORWARD_ENV,
    WORKER_PROGRESS_CEILING_ENV
]

/**
 * The levers, read ONCE, as a reader the profile table can be handed.
 *
 * WHY A SNAPSHOT AND NOT `process.env`. Every worker in one research phase must
 * see the same lever values. A profile that read `process.env` itself would move
 * the read down to each worker, and a var flipped mid-phase would then apply to
 * some workers and not others. Freezing the reader keeps the read-once property
 * while letting the profile own what the values MEAN.
 */
export function snapshotLeverEnv(env: Env = defaultEnv): Env {
    const snap = new Map<string, string | undefined>(RESEARCH_LEVER_ENVS.map(k => [k, env(k)]))
    return key => snap.get(key)
}

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
 * It is not a budget and it does not decide how long a worker may take — the
 * no-progress deadline does that, and it resets on every tool call. This is the
 * last-resort bound on a worker that never stops moving (a tool-call loop the loop
 * detector misses), so its only requirement is to sit clear of the real workload.
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
 * ON by default, so the env var is the OFF switch, not the on switch:
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
 * about only when it is spent, and "be decisive" — WORKER_TIMEOUT_HINT, which it
 * already receives on every timeout restart — is the unquantified version of the
 * same ask.
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
