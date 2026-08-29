/**
 * runner-resolve — make the deterministic gates able to SPAWN the project's own
 * runner when the host PATH lost it.
 *
 * The failure this closes: pi was launched inside the
 * sandbox through a LOGIN shell, whose /etc/profile reset PATH and dropped
 * ~/.bun/bin — so `bun` was unspawnable in every gate spawn. Under the env-gap
 * contract (ENOENT / exit 127 → skip, deliberately, so a missing tool is never a
 * code fault) EVERY dynamic check silently skipped: bun test, the boot of
 * `bun run dev`, and therefore the render check built for exactly the blank-page
 * class the run shipped. The gate converged on static checks alone and stamped
 * the run green while the binary sat at ~/.bun/bin/bun the whole time.
 *
 * Resolution is discovery, never installation: try the bare name first (PATH
 * serves it → nothing changes), then probe well-known install locations. Each
 * probe is a real `<candidate> --version` spawn — an existing but broken binary
 * must not count as resolved.
 *
 * The PATH PREFIX matters as much as the binary: a resolved `bun run test` still
 * re-invokes `bun` (and the repo's own bins) INSIDE the script chain, and those
 * inner calls exit 127 without the runner's directory on PATH — the same silent
 * blindness one level down ('s final-fix child hit exactly this and had to
 * hand-export PATH). Spawn sites must therefore use runnerEnv(), not just the
 * resolved binary.
 */
import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface ResolvedRunner {
    /** Spawnable form: the bare name when PATH serves it, else an absolute path. */
    bin: string
    /** Directory to prepend to PATH for the spawned script chain; null when the
     *  bare name already resolves (nothing to add). */
    pathPrefix: string | null
    /** false → the runner is not spawnable anywhere this module knows to look. */
    ok: boolean
}

/** Well-known install locations per runner, probed in order AFTER the bare name.
 *  Only ever read — nothing is installed. */
function candidatePaths(bin: string, env: NodeJS.ProcessEnv): string[] {
    const home = env.HOME ?? env.USERPROFILE ?? os.homedir()
    const exe = process.platform === 'win32' ? `${bin}.exe` : bin
    const list: string[] = []
    if (bin === 'bun') {
        if (env.BUN_INSTALL) list.push(path.join(env.BUN_INSTALL, 'bin', exe))
        list.push(path.join(home, '.bun', 'bin', exe))
    }
    list.push(
        path.join(home, '.local', 'bin', exe),
        path.join('/usr/local/bin', exe),
        path.join('/usr/bin', exe),
        path.join('/opt/homebrew/bin', exe)
    )
    return list
}

/** Does `bin` actually run? A real spawn, not an existence check — a present but
 *  broken binary (wrong arch, dangling symlink) must not count as resolved. */
function defaultProbe(bin: string): boolean {
    const r = spawnSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 8_000,
        env: {...process.env}
    })
    return !r.error && r.status === 0
}

const cache = new Map<string, ResolvedRunner>()

/** Test hook: resolution is cached per bin name for the life of the process (the
 *  gate spawns the same runner many times); tests reset between cases. */
export function clearRunnerCache(): void {
    cache.clear()
}

/**
 * A spawnable form of `bin`: bare name if PATH serves it, else the first
 * well-known location that exists AND runs, else `{ok: false}` with the bare
 * name unchanged (spawn sites then behave exactly as before this module —
 * ENOENT → the caller's env-gap contract).
 */
export function resolveRunner(
    bin: string,
    opts: {probe?: (bin: string) => boolean; env?: NodeJS.ProcessEnv} = {}
): ResolvedRunner {
    const cached = cache.get(bin)
    if (cached) return cached
    const probe = opts.probe ?? defaultProbe
    const env = opts.env ?? process.env
    let resolved: ResolvedRunner
    if (probe(bin)) {
        resolved = {bin, pathPrefix: null, ok: true}
    } else {
        const hit = candidatePaths(bin, env).find(p => existsSync(p) && probe(p))
        resolved =
            hit ?
                {bin: hit, pathPrefix: path.dirname(hit), ok: true}
            :   {bin, pathPrefix: null, ok: false}
    }
    cache.set(bin, resolved)
    return resolved
}

/**
 * Output shapes a RUNNER emits when the command inside a script chain does not
 * exist, on platforms where that is not reported as exit 127.
 *
 * 127 is a POSIX-SHELL convention: on Linux/macOS bun hands the script to
 * /bin/sh, the shell prints `…: command not found` and exits 127, and the whole
 * env-gap contract keys off that number. On Windows there is no such shell —
 * bun runs the script in its own built-in shell, which reports the miss itself
 * (`bun: command not found: X`) and exits **1**, indistinguishable by status
 * alone from a real code fault. cmd.exe (9009) and PowerShell have their own
 * wording. Recognising the shape restores one env-gap contract on all three.
 *
 * Deliberately narrow: only wordings a RUNNER/SHELL produces, never the bare
 * phrase. A suite that prints "command not found" inside a failing assertion is
 * a real FAIL and must stay one — the posix shape already travels as 127.
 */
export const COMMAND_NOT_FOUND_OUTPUT_RE =
    /\b(?:bun|npm|pnpm|yarn|node|deno): command not found:|is not recognized as an internal or external command|is not recognized as the name of a cmdlet/i

/**
 * Did this command fail because the thing it tried to run does not exist here,
 * rather than because the code is wrong? Exit 127 (POSIX shell) or 9009
 * (cmd.exe) say so outright; anything else needs the runner's own wording (see
 * COMMAND_NOT_FOUND_OUTPUT_RE) — a Windows `bun run dev` on a missing binary
 * exits 1. Callers treat a true here as an environment gap → skip, never FAIL.
 */
export function isCommandNotFound(status: number | null, output = ''): boolean {
    if (status === 127 || status === 9009) return true
    if (status === null || status === 0) return false
    return COMMAND_NOT_FOUND_OUTPUT_RE.test(output)
}

/**
 * The env a spawn site should pass so the resolved runner's script chain can
 * re-invoke it: base env with the runner's directory prepended to PATH. With no
 * prefix (bare name resolved, or unresolvable) the base env is returned as-is.
 */
export function runnerEnv(
    runner: ResolvedRunner,
    base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
    if (!runner.pathPrefix) return {...base}
    return {...base, PATH: `${runner.pathPrefix}${path.delimiter}${base.PATH ?? ''}`}
}
