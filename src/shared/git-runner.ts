/**
 * git-runner — the shared async way to run `git`, and the one to reach for.
 *
 * THE CONTRACT, deliberately narrow:
 *   - NEVER THROWS. Every failure arrives as a non-zero `exitCode`, measured
 *     rather than assumed: a non-repo cwd answers 128, a bogus subcommand
 *     answers 1, `git rev-parse --verify HEAD` on a freshly-init'd repo with an
 *     unborn HEAD answers 128, and even a MISSING binary comes back as
 *     `{exitCode: 1, aborted: false}` instead of rejecting. Callers branch on
 *     the number, they do not wrap in try/catch, and every guard built on this
 *     treats "git could not tell me" as "no claim" rather than a crash.
 *   - Only `stdout` and `exitCode` are exposed. stderr is deliberately absent:
 *     the caller that legitimately needs it (auto-commit's identity-failure
 *     sniffing) also needs `aborted`, and widening this type for it would push
 *     two fields nobody else reads onto every call site. That one caller goes
 *     to `runChildDefault` directly instead.
 *   - `signal` is honoured by the underlying runChild, including its listener
 *     detach discipline — a run-long orchestrator signal does not accumulate
 *     one listener per git invocation.
 *   - `env` entries are MERGED over `process.env`, not substituted for it, which
 *     is what lets git-state-guard point `GIT_INDEX_FILE` at a throwaway index
 *     without losing PATH and HOME. Confirmed: such a call still resolves the
 *     repo normally.
 *   - `spawnFn` is the test seam: pass a fake from `test/test-utils/fake-spawn.ts`
 *     and the runner never touches a real repo.
 *
 * It is NOT universal, which matters before assuming any git call arrived here.
 * Several sites still invoke git themselves with `spawnSync`, each carrying its
 * own timeout and one its own maxBuffer, and accept-debt goes through the
 * bounded command runner instead.
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
