/**
 * git-runner — the ONE way this codebase runs `git`.
 *
 * WHY IT EXISTS. The right shape already existed, privately, inside
 * `task/git-state-guard.ts`: an abort-aware async runner carrying an injectable
 * `spawnFn` seam, returning `{stdout, exitCode}` and never throwing. Nothing
 * outside that file could reach it, so ~27 other sites hand-rolled their own —
 * with FOUR incompatible failure contracts (throws / returns null / returns '' /
 * returns a result object) and THREE different maxBuffer limits. A caller reading
 * one of them learns nothing about the next, and a git failure means something
 * different at every site. Lifting the seam here does not add a capability; it
 * removes the ambiguity about which contract you are holding.
 *
 * THE CONTRACT, deliberately narrow:
 *   - NEVER THROWS. A missing git, a non-repo cwd, a fatal subcommand — all of
 *     them arrive as a non-zero `exitCode`. Callers branch on the number, they do
 *     not wrap in try/catch. (`git rev-parse --verify HEAD` on an unborn HEAD is
 *     an ordinary answer, not an exception, and every guard built on this one
 *     treats "git could not tell me" as "no claim" rather than a crash.)
 *   - Only `stdout` and `exitCode` are exposed. stderr is deliberately absent:
 *     the callers that legitimately need it (auto-commit's identity-failure
 *     sniffing) also need `aborted`, and widening this type for them would push
 *     two fields nobody else reads onto every call site.
 *   - `signal` is honoured by the underlying runChild, including its listener
 *     detach discipline (GitHub issue #9) — a run-long orchestrator signal does
 *     not accumulate one listener per git invocation.
 *   - `env` entries are MERGED over `process.env` (the GIT_INDEX_FILE
 *     throwaway-index pattern), not substituted for it.
 *   - `spawnFn` is the test seam: pass a fake from `test-utils/fake-spawn.ts` and
 *     the runner never touches a real repo.
 */
import {runChildDefault, type SpawnFn} from './child-process.js'

export interface GitRunner {
    (
        args: string[],
        env?: Record<string, string>
    ): Promise<{
        stdout: string
        exitCode: number
    }>
}

export function makeGit(cwd: string, signal?: AbortSignal, spawnFn?: SpawnFn): GitRunner {
    return async (args, env) => {
        const r = await runChildDefault(
            {command: 'git', args, ...(env ? {env: {...process.env, ...env}} : {})},
            cwd,
            signal,
            {mode: 'text'},
            spawnFn
        )
        return {stdout: r.stdout, exitCode: r.exitCode}
    }
}
