/**
 * runner-resolve — make the deterministic gates able to SPAWN the project's own
 * runner when the host PATH lost it.
 *
 * The failure this closes (mx5 run 16, validated): pi was launched inside the
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
 * blindness one level down (run 16's final-fix child hit exactly this and had to
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
