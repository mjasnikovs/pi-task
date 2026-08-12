/**
 * The preconditions a live A/B must meet before it is allowed to mean anything,
 * and the exit code an unmet one produces.
 *
 * THE EXIT CODE IS THE POINT. `ab-verdict.ts` fixes the contract
 * `{PASS: 0, FAIL: 1, ABSTAIN: 2}` and says of ABSTAIN: "exits NON-ZERO on
 * purpose… must never be mistakable for a passing one." But the checks that run
 * BEFORE that seam were copy-pasted into 26 harnesses and every one of them exits
 * **1** on a dead endpoint — the code that means "the lever did not do its job".
 * Twenty-five of those files import `ab-verdict` in the same breath. A run that
 * never reached the model is not a refutation; it is the absence of a measurement,
 * and it must abstain.
 *
 * The coverage gaps this closes are as bad as the exit code:
 *
 *   - the research-cache guard (`RESEARCH_RUN_ID_ENV` set ⇒ later reps replay
 *     rep 1's answers) was present in 11 of 51 A/B harnesses. The other 40 could
 *     silently measure a cache instead of a model.
 *   - mid-run liveness was checked in exactly ONE. BENCHMARK.md names a model
 *     restart mid-run as an invalidating instrument fault, and pi retries
 *     transparently, so an outage can otherwise leave no trace at all.
 *   - the PI_BIN fork-bomb guard had drifted into two texts across 24 files.
 *
 * Nothing here spends model time. `requirePreconditions` is injectable end to end
 * so `ab-preflight.test.ts` can drive every branch without a server.
 */
import {existsSync} from 'node:fs'
import {EXIT_CODE} from './ab-verdict.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'

/** Where the local model answers. Overridable for a harness pointed elsewhere. */
export const DEFAULT_MODEL_HEALTH_URL = 'http://127.0.0.1:8080/health'

export interface Preconditions {
    /** The model endpoint must answer before the run starts. */
    model?: {url?: string; timeoutMs?: number}
    /**
     * `PI_BIN` must be set. An unset PI_BIN makes a child re-invoke this process,
     * which is a fork bomb that has taken this machine down twice.
     */
    piBin?: true
    /**
     * The research cache must be OFF. With `RESEARCH_RUN_ID_ENV` set, reps after
     * the first replay rep 1's answers, so the arm measures a cache.
     */
    cacheOff?: true
    /** Evidence trees that must exist, or the run has no fixture to act on. */
    corpora?: string[]
}

/** A live-ness handle for the arm loop. Every method is safe to call repeatedly. */
export interface ModelWatch {
    /** Is the endpoint still answering? False ⇒ the arm should abstain, not score. */
    stillAlive(): Promise<boolean>
    /**
     * Has the endpoint stayed the SAME process since preflight? A restart mid-arm
     * silently changes the thing under test — BENCHMARK.md's +MODELRESTART.
     */
    unchanged(): Promise<boolean>
}

/** What the environment looked like at preflight, so a caller can log it. */
export interface PreflightResult {
    watch: ModelWatch
    /** Identity of the model process, when the endpoint publishes one. */
    fingerprint: string | null
}

export interface PreflightDeps {
    fetch?: (url: string, init?: {signal?: AbortSignal}) => Promise<{ok: boolean; text(): Promise<string>}>
    env?: NodeJS.ProcessEnv
    fileExists?: (p: string) => boolean
    log?: (line: string) => void
    exit?: (code: number) => never
}

/** A dead endpoint, a set cache id and a missing corpus are all the same verdict. */
function abstain(name: string, reasons: string[], deps: Required<PreflightDeps>): never {
    deps.log('')
    deps.log('*** ABSTAIN — THIS RUN PROVED NOTHING ***')
    deps.log(`${name} did not start: a precondition was not met.`)
    for (const r of reasons) deps.log(`  - ${r}`)
    deps.log('')
    deps.log('This is exit 2, NOT exit 1. The lever was never exercised, so this run is')
    deps.log('the ABSENCE of a measurement — it is not evidence the lever failed. Fix the')
    deps.log('precondition and re-run before reading anything into it.')
    return deps.exit(EXIT_CODE.ABSTAIN)
}

/**
 * Check every precondition and hand back a liveness handle, or ABSTAIN (exit 2).
 *
 * All reasons are collected before exiting, so one run tells you everything that
 * is wrong rather than one thing per attempt.
 */
export async function requirePreconditions(
    name: string,
    p: Preconditions,
    overrides: PreflightDeps = {}
): Promise<PreflightResult> {
    const deps: Required<PreflightDeps> = {
        fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
        env: overrides.env ?? process.env,
        fileExists: overrides.fileExists ?? existsSync,
        log: overrides.log ?? ((l: string) => console.error(l)),
        exit: overrides.exit ?? ((c: number) => process.exit(c))
    }
    const reasons: string[] = []

    if (p.piBin === true) {
        const bin = deps.env.PI_BIN
        if (bin === undefined || bin.trim().length === 0) {
            reasons.push(
                'PI_BIN is unset. A child would re-invoke this process instead of pi — '
                    + 'the fork bomb that has crashed this machine twice. '
                    + 'Run with PI_BIN=$(command -v pi).'
            )
        }
    }

    if (p.cacheOff === true) {
        const runId = deps.env[RESEARCH_RUN_ID_ENV]
        if (runId !== undefined && runId.length > 0) {
            reasons.push(
                `${RESEARCH_RUN_ID_ENV} is set (${runId}). Reps after the first would replay `
                    + "rep 1's cached answers, so the arm would measure a cache, not a model."
            )
        }
    }

    for (const dir of p.corpora ?? []) {
        if (!deps.fileExists(dir)) {
            reasons.push(`corpus missing: ${dir} — the run has no fixture to act on.`)
        }
    }

    let fingerprint: string | null = null
    const url = p.model?.url ?? DEFAULT_MODEL_HEALTH_URL
    const timeoutMs = p.model?.timeoutMs ?? 3000
    if (p.model !== undefined) {
        fingerprint = await probe(deps, url, timeoutMs)
        if (fingerprint === null) {
            reasons.push(
                `the model endpoint at ${url} did not answer within ${timeoutMs}ms. `
                    + 'Bring it up and wait for a real 200 before starting a run — '
                    + 'starting against a dead endpoint burns the whole matrix.'
            )
        }
    }

    if (reasons.length > 0) abstain(name, reasons, deps)

    const at = fingerprint
    return {
        fingerprint,
        watch: {
            stillAlive: async () => (await probe(deps, url, timeoutMs)) !== null,
            unchanged: async () => {
                const now = await probe(deps, url, timeoutMs)
                if (now === null) return false
                // No fingerprint to compare ⇒ report unchanged rather than invent a
                // restart. An endpoint that publishes nothing cannot be caught here,
                // and saying otherwise would be a false alarm on every tick.
                return at === null || now === at
            }
        }
    }
}

/** Returns a fingerprint string on success, or null when the endpoint is down. */
async function probe(
    deps: Required<PreflightDeps>,
    url: string,
    timeoutMs: number
): Promise<string | null> {
    try {
        const r = await deps.fetch(url, {signal: AbortSignal.timeout(timeoutMs)})
        if (!r.ok) return null
        // The body is whatever the server publishes. It is used only for equality
        // across ticks, so its shape does not matter — only that it is stable while
        // the process is, which llama-server's /health and /v1/models both are.
        return await r.text().catch(() => '')
    } catch {
        return null
    }
}

/**
 * Abstain because the model went away or restarted mid-arm.
 *
 * Kept next to `requirePreconditions` so both halves of the same rule read the
 * same: a run whose instrument changed under it did not measure the lever.
 */
export function abstainMidRun(name: string, detail: string, overrides: PreflightDeps = {}): never {
    const deps: Required<PreflightDeps> = {
        fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
        env: overrides.env ?? process.env,
        fileExists: overrides.fileExists ?? existsSync,
        log: overrides.log ?? ((l: string) => console.error(l)),
        exit: overrides.exit ?? ((c: number) => process.exit(c))
    }
    return abstain(name, [detail], deps)
}
