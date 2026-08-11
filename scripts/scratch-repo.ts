/**
 * Shared throwaway-repo fixture for the validation harnesses.
 *
 * WHY THIS EXISTS. Nearly every A/B, base-rate and replay script under `scripts/`
 * builds its fixtures the same way — `os.tmpdir()` + `mkdir` + `git init -q` +
 * write some files + `git add -A` + `git commit -q` — and tears them down with
 * `fs.rmSync(dir, {recursive: true, force: true})`. Two dozen private copies of
 * that ritual had drifted apart in every dimension that is invisible until it
 * bites: the commit identity (`ab`, `replay`, or none at all, which fails outright
 * in a container with no gitconfig — mx5 run 4), the `maxBuffer` ceiling (default
 * 1 MiB, 64 MiB, 128 MiB, 256 MiB), and whether a failed git call throws, returns
 * `null`, or returns `''`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. This helper owns SETUP and TEARDOWN only —
 * temp directories, `git init` with a fixed identity, seeding files, committing
 * them, and removing the tree. It never touches what a harness asserts or how it
 * judges: the numbers in VALIDATION-DEBT.md were measured by those judgements, and
 * a fixture helper that quietly altered one would invalidate a recorded result.
 * Harness-specific git calls stay in the harness — `repo.git(...)` runs them, it
 * does not interpret them.
 *
 * THE FAILURE CONTRACT, and why there are two methods. `git()` THROWS on a
 * non-zero exit, because that is what fixture construction wants: a fixture that
 * did not build is not a data point, and a harness must crash rather than measure
 * a half-built tree. `tryGit()` never throws, for the call sites that treat a
 * non-zero exit as an ordinary answer (`git show <sha>:Makefile` on a repo with no
 * Makefile). Picking one per call site is a decision the caller makes explicitly,
 * which is exactly what the private copies had made implicit.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * One identity for every scratch commit. It is passed with `-c` rather than
 * written into the repo config so it also covers `git init` itself, and it is
 * fixed rather than inherited so a headless container with no `~/.gitconfig`
 * builds the same fixture as a developer laptop.
 */
export const SCRATCH_IDENTITY: readonly string[] = [
    '-c',
    'user.name=pi-task-scratch',
    '-c',
    'user.email=scratch@local'
]

/**
 * One ceiling, replacing the four the private copies had. Generous on purpose:
 * these harnesses `git show` real manifests and `git archive` whole `src/` trees,
 * and a truncated fixture is a corrupt measurement. Raising a limit can only turn
 * a crash into a completed build — it cannot make a passing harness read
 * differently.
 */
const MAX_BUFFER = 256 * 1024 * 1024

export interface GitResult {
    stdout: string
    stderr: string
    exitCode: number
}

/** Run git in `cwd` under the scratch identity. Never throws. */
export function tryScratchGit(cwd: string, args: readonly string[]): GitResult {
    const r = spawnSync('git', [...SCRATCH_IDENTITY, ...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER
    })
    return {
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
        exitCode: r.error ? 1 : (r.status ?? 1)
    }
}

/** Run git in `cwd` under the scratch identity; throw on a non-zero exit. */
export function scratchGit(cwd: string, args: readonly string[]): string {
    const r = tryScratchGit(cwd, args)
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
}

/**
 * Write `body` to `rel` under `dir`, creating parent directories. Returns the
 * absolute path. Exported because harnesses seed files at two moments — building
 * the fixture, and later replaying what a child did to it — and both halves of
 * that should be the same call.
 */
export function writeFile(dir: string, rel: string, body: string): string {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), {recursive: true})
    fs.writeFileSync(p, body)
    return p
}

/** Remove a directory tree if it exists. The teardown half of the ritual. */
export function removeTree(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
}

export interface ScratchRepo {
    /** Absolute path to the repo's work tree. */
    readonly dir: string
    /** Run git in this repo; throws on a non-zero exit. */
    git(args: readonly string[]): string
    /** Run git in this repo; returns the exit code instead of throwing. */
    tryGit(args: readonly string[]): GitResult
    /** Write a file relative to the work tree, creating parent directories. */
    write(rel: string, body: string): string
    /** `git add -A` + `git commit -q -m <message>`. */
    commitAll(message: string): void
    /** Delete the whole work tree. */
    remove(): void
}

export interface ScratchRepoOptions {
    /**
     * Extra arguments for `git init` (e.g. `['-b', 'main']` to pin the branch name
     * against the host's `init.defaultBranch`). `-q` is always supplied.
     */
    initArgs?: readonly string[]
    /** Files to seed before the initial commit, as `relative path` → contents. */
    files?: Record<string, string>
    /** When set, `git add -A` and commit the seeded files with this message. */
    commit?: string
}

/**
 * A fresh git work tree at `dir`. Any existing tree at that path is REMOVED first,
 * so a re-run cannot inherit the previous run's state — the property every private
 * copy of this ritual was already leading with (`fs.rmSync` before `fs.mkdirSync`).
 */
export function scratchRepo(dir: string, opts: ScratchRepoOptions = {}): ScratchRepo {
    removeTree(dir)
    fs.mkdirSync(dir, {recursive: true})

    const repo: ScratchRepo = {
        dir,
        git: args => scratchGit(dir, args),
        tryGit: args => tryScratchGit(dir, args),
        write: (rel, body) => writeFile(dir, rel, body),
        commitAll: message => {
            scratchGit(dir, ['add', '-A'])
            scratchGit(dir, ['commit', '-q', '-m', message])
        },
        remove: () => removeTree(dir)
    }

    repo.git(['init', '-q', ...(opts.initArgs ?? [])])
    // The identity is ALSO written into the repo's own config, not just passed with
    // `-c` on our calls. Harnesses hand these trees to product code — the final
    // gate's autofix, the per-task auto-commit — and a git process we did not
    // launch cannot see our `-c` flags. Without a local identity those commits fail
    // outright wherever there is no `~/.gitconfig`, which is precisely the headless
    // container that made every per-task commit fail on mx5 run 4.
    repo.git(['config', 'user.name', 'pi-task-scratch'])
    repo.git(['config', 'user.email', 'scratch@local'])
    for (const [rel, body] of Object.entries(opts.files ?? {})) repo.write(rel, body)
    if (opts.commit !== undefined) repo.commitAll(opts.commit)
    return repo
}

/**
 * A scratch repo in a UNIQUELY-NAMED temp directory (`mkdtemp`), for harnesses
 * that build many fixtures and never need to name them. Same contract as
 * `scratchRepo`; only the naming differs.
 */
export function tempRepo(prefix: string, opts: ScratchRepoOptions = {}): ScratchRepo {
    return scratchRepo(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), opts)
}

export interface ScratchRoot {
    /** Absolute path to the (freshly emptied) root directory. */
    readonly dir: string
    /** A subdirectory path under the root — created lazily by whoever writes to it. */
    path(...parts: string[]): string
    /** A scratch repo at `<root>/<name>`. */
    repo(name: string, opts?: ScratchRepoOptions): ScratchRepo
    /** Delete the root and everything under it. */
    remove(): void
}

/**
 * A per-process root under `os.tmpdir()` holding one run's fixtures, emptied on
 * creation so a crashed previous run cannot leak state into this one. The pid
 * suffix keeps two concurrent harnesses off each other's trees.
 */
export function scratchRoot(label: string): ScratchRoot {
    const dir = path.join(os.tmpdir(), `${label}-${process.pid}`)
    removeTree(dir)
    fs.mkdirSync(dir, {recursive: true})
    return {
        dir,
        path: (...parts) => path.join(dir, ...parts),
        repo: (name, opts) => scratchRepo(path.join(dir, name), opts),
        remove: () => removeTree(dir)
    }
}
