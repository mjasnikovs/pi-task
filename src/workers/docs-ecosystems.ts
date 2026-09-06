/**
 * docs-ecosystems — one row per package registry the docs Worker tool can read.
 *
 * The docs pipeline used to be npm all the way down with nothing saying so: it
 * resolved through `node_modules`, chunked TypeScript, and auto-installed any
 * unknown name from npm. Common Rust and Haskell package names also exist on
 * npm, so a question about `aeson` or `tokio` returned a confident answer about
 * an unrelated JavaScript package — a wrong answer, not a miss.
 *
 * A row states the whole of what one registry needs: how to spot its manifest,
 * how to find a package on disk, how to fetch one that is absent, and how to cut
 * its source into retrievable chunks. Rows live in code and arrive as pull
 * requests, so a new ecosystem is reviewable and testable rather than a user
 * string that either works or silently does not.
 */

import {spawn as nodeSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    runAutoInstall,
    findDeclaredRange,
    extractParentPackage,
    resolveTypeSourceForDocs,
    getDocsModulesDir,
    type AutoInstallPin
} from './docs-core.js'
import {resolvePackage, isDtsFile, isValidModuleName, type ResolvedPackage} from './docs-resolve.js'
import {DECL_SPLIT_RE} from './docs-chunk.js'
import {npmVersionLookup, type NpmVersionInfo} from './npm-version.js'
import {
    resolveCrate,
    cratesLatest,
    crateTarballUrl,
    crateOf,
    isValidCrateName,
    isRustFile,
    lockedVersion,
    rustSurface,
    cargoProjectName,
    childDirs,
    lockedDeps,
    manifestCrates,
    CARGO_DECL_SPLIT_RE
} from './eco-cargo.js'
import {
    resolveHackage,
    hackageLatest,
    hackageVersion,
    hackageTarballUrl,
    hackageExtractDir,
    hackageProjectName,
    supplementCandidates,
    findCabalTarball,
    cachedVersions,
    resolvedVersions,
    manifestPackages,
    isValidHackageName,
    isHaskellFile,
    haskellSurface,
    HACKAGE_DECL_SPLIT_RE,
    HACKAGE_SKIP_DIRS
} from './eco-hackage.js'
import {runChild, type SpawnFn} from '../shared/child-process.js'

export type EcosystemId = 'npm' | 'cargo' | 'hackage'

/**
 * Is any of `names` present at `cwd` or above it?
 *
 * Detection has to reach as far as resolution does. Node resolves a package by
 * walking `node_modules` UPWARD, and cargo and cabal read the nearest manifest
 * above them, so a session started in `~/project/src` is in an npm project by
 * every rule that matters — and a cwd-only check would refuse every lookup
 * there.
 */
function existsAtOrAbove(cwd: string, names: readonly string[]): boolean {
    let dir = cwd
    while (true) {
        if (names.some(n => fs.existsSync(path.join(dir, n)))) return true
        const up = path.dirname(dir)
        if (up === dir) return false
        dir = up
    }
}

/**
 * The same walk, checking each ancestor's immediate children too.
 *
 * npm does not need this — node resolves straight up — but cargo and cabal keep
 * their manifest in a SIBLING of where a session usually starts. From a Tauri
 * repo's `src/`, the crate is in `../src-tauri`, and without the sideways step
 * the project reads as npm-only and `tokio` resolves to npm's web scraper: the
 * original bug, from one directory over.
 */
function foundAtOrAbove(cwd: string, atDir: (dir: string) => boolean): boolean {
    let dir = cwd
    while (true) {
        if (atDir(dir) || childDirs(dir).some(atDir)) return true
        const up = path.dirname(dir)
        if (up === dir) return false
        dir = up
    }
}

/**
 * Every filesystem, process and network reach a row is allowed. Rows read no
 * environment and call no global directly, so a test injects a fake registry and
 * a fake extractor instead of needing a real toolchain on the machine.
 */
export interface EcosystemIo {
    spawn: SpawnFn
    fetch: typeof fetch
    /** Where a package the project does not have is put once fetched. */
    modulesDir: string
    /** Root of the cargo checkout cache — `CARGO_HOME`, or its default. */
    cargoHome: string
    /** Every directory cabal may have filed a downloaded tarball under. */
    cabalPackageDirs: readonly string[]
    signal?: AbortSignal | undefined
}

/**
 * Production defaults for {@link EcosystemIo}. The environment is read HERE and
 * nowhere in a row, so a test injects a directory instead of setting a variable
 * that outlives it.
 */
export function defaultEcosystemIo(overrides: Partial<EcosystemIo> = {}): EcosystemIo {
    return {
        spawn: nodeSpawn as unknown as SpawnFn,
        fetch,
        modulesDir: getDocsModulesDir(),
        cargoHome: process.env.CARGO_HOME?.trim() || path.join(os.homedir(), '.cargo'),
        cabalPackageDirs: defaultCabalPackageDirs(),
        ...overrides
    }
}

/** What acquiring a package produced, whatever the registry. */
/**
 * Both cabal layouts, because a machine may have either: `CABAL_DIR` when set,
 * then the classic `~/.cabal`, then the XDG path newer cabal versions use.
 */
function defaultCabalPackageDirs(): string[] {
    const home = os.homedir()
    const configured = process.env.CABAL_DIR?.trim()
    const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(home, '.cache')
    return [
        ...(configured ? [path.join(configured, 'packages')] : []),
        path.join(home, '.cabal', 'packages'),
        path.join(cacheHome, 'cabal', 'packages')
    ]
}

export interface AcquireResult {
    success: boolean
    installDir: string
    stderr: string
}

export interface EcosystemProfile {
    id: EcosystemId
    /** What this row covers, and what it deliberately does not. */
    why: string
    /** The registry's name, as it appears in text the model reads. */
    registryLabel: string
    /** The manifest file this row is detected by, named for a refusal message. */
    manifestLabel: string

    /** True when `cwd` looks like a project of this ecosystem. */
    detect: (cwd: string) => boolean
    isValidName: (name: string) => boolean
    /** The installable package a possibly-subpath specifier belongs to. */
    parentPackage: (name: string) => string

    /** Find the package on disk. Throws `ResolveError` when it is absent. */
    resolve: (name: string, cwd: string, io: EcosystemIo) => ResolvedPackage
    /** The version range the project pins this package to, if it pins one. */
    declaredRange: (name: string, cwd: string) => string | null
    /** Fetch a package that is not on disk into `io.modulesDir`. */
    acquire: (name: string, range: string | null, io: EcosystemIo) => Promise<AcquireResult>
    /**
     * A second resolution hop, for ecosystems where the package that ships the
     * documented surface is not the one that was asked for.
     */
    afterResolve?: (
        pkg: ResolvedPackage,
        requested: string,
        cwd: string,
        io: EcosystemIo
    ) => Promise<{pkg: ResolvedPackage; installed: boolean; pin?: AutoInstallPin}>
    /**
     * Packages whose declarations belong in THIS package's index, because this
     * package exports names it does not declare. Only hackage has facades of the
     * `hspec`/`hspec-core` shape; see DEFECT-12-STOPPING-RULE.md.
     */
    supplements?: (pkg: ResolvedPackage, cwd: string, io: EcosystemIo) => Promise<ResolvedPackage[]>
    /** The registry's own newest version, for grounding an answer in the present. */
    latest: (name: string, io: EcosystemIo) => Promise<NpmVersionInfo | null>

    /** True for a file that carries the package's public API surface. */
    isSurfaceFile: (name: string) => boolean
    /**
     * Reduce a source file to its public surface. Identity where the ecosystem
     * already ships a declarations-only file, as npm does with `.d.ts`.
     */
    surface: (content: string) => string
    /** Where a declaration begins, so a chunk never splits a signature. */
    declSplitRe: RegExp
    /**
     * The keywords that INTRODUCE a named type in this language, for finding the
     * chunk that defines a name rather than the many that use it.
     */
    typeKeywords: readonly string[]
    /** Line-comment marker, used to label a chunk with the file it came from. */
    commentPrefix: string

    /** Directories the surface walk never descends into: tests, build output. */
    skipDirs: readonly string[]
    /** What this ecosystem's packages ship, for a "there is nothing to read" answer. */
    surfaceLabel: string
    /**
     * How the extraction child is told what it is reading. A written phrase, not
     * a label plus an article: "a npm package" is what deriving one gives you.
     */
    packageSubject: string
    /** Which of the PROJECT's own files this ecosystem contributes to its index. */
    projectGlobs: readonly string[]
    /** The project's own name from its manifest, or null when it declares none. */
    projectName: (cwd: string) => string | null
    /**
     * What the project's manifest declares, name to version. Undefined when the
     * manifest is missing or unreadable — the caller then cannot prove any
     * package's version, which is a different fact from "declares nothing".
     */
    declaredDeps: (cwd: string) => Record<string, string> | undefined
    /**
     * The names the MANIFEST itself declares — what the project may import.
     *
     * Distinct from {@link declaredDeps}, which for cargo and hackage reads a
     * lock or plan file: that is the whole transitive closure, so it answers
     * "does this resolve" and not "may this be used". Undefined when there is no
     * readable manifest, which is not the same fact as "declares nothing".
     */
    manifestDeps: (cwd: string) => Set<string> | undefined
}

/** Overrides a caller has already been given its own copies of. */
export interface NpmProfileHooks {
    resolvePackage?: typeof resolvePackage
    npmVersionLookup?: typeof npmVersionLookup
}

/**
 * The npm row, with the pieces a caller may have replaced left as parameters.
 *
 * `docsRaw` already takes `resolvePackage` and `npmVersionLookup` as injection
 * hooks, and those hooks must keep reaching the resolution they are injected
 * for. A per-call row carries them; {@link ECOSYSTEMS} holds the plain one.
 */
export function npmProfile(hooks: NpmProfileHooks = {}): EcosystemProfile {
    const resolve = hooks.resolvePackage ?? resolvePackage
    const versionLookup = hooks.npmVersionLookup ?? npmVersionLookup
    return {
        id: 'npm',
        why:
            "The original and only ecosystem this tool read. Resolution is Node's own "
            + 'node_modules walk, the documented surface is the .d.ts files a package ships, '
            + 'and a missing package is installed with --ignore-scripts because the name is '
            + 'model-chosen.',
        registryLabel: 'npm',
        manifestLabel: 'package.json',

        // `node_modules` without a package.json counts: a directory that has one
        // is an npm project whether or not it declares itself.
        detect: cwd => existsAtOrAbove(cwd, ['package.json', 'node_modules']),
        isValidName: isValidModuleName,
        parentPackage: extractParentPackage,

        resolve: (name, cwd) => resolve(name, cwd),
        declaredRange: findDeclaredRange,
        acquire: (name, range, io) =>
            runAutoInstall(io.spawn, name, {
                signal: io.signal,
                versionRange: range ?? undefined
            }),
        afterResolve: (pkg, requested, cwd, io) =>
            resolveTypeSourceForDocs(pkg, requested, cwd, io.spawn, resolve, io.signal),
        latest: (name, io) =>
            versionLookup(name, io.signal === undefined ? {} : {signal: io.signal}),

        isSurfaceFile: isDtsFile,
        surface: content => content,
        declSplitRe: DECL_SPLIT_RE,
        typeKeywords: ['interface', 'type', 'class', 'enum'],
        commentPrefix: '//',
        // A nested node_modules is another package's surface, never this one's.
        skipDirs: ['node_modules'],
        surfaceLabel: '.d.ts files or README',
        packageSubject: 'an npm package',
        projectGlobs: ['*.ts', '*.tsx'],
        projectName: npmProjectName,
        declaredDeps: npmDeclaredDeps,
        manifestDeps: cwd => {
            const deps = npmDeclaredDeps(cwd)
            return deps && new Set(Object.keys(deps))
        }
    }
}

const NPM_DEP_BLOCKS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
]

/**
 * The package.json manifest, not the lockfile: a lockfile is rewritten by
 * installs that change no resolved version, and pruning digests on that would
 * cost reuse for no correctness gain.
 */
export function npmDeclaredDeps(cwd: string): Record<string, string> | undefined {
    let json: Record<string, unknown>
    try {
        json = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<
            string,
            unknown
        >
    } catch {
        return undefined
    }
    const out: Record<string, string> = {}
    for (const block of NPM_DEP_BLOCKS) {
        const deps = json[block]
        if (!deps || typeof deps !== 'object') continue
        for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
            if (typeof range === 'string' && !(name in out)) out[name] = range
        }
    }
    // No dependency block at all is a real, stable state (a dependency-free repo).
    return out
}

/** A project's own name from its package.json, or null when it declares none. */
export function npmProjectName(cwd: string): string | null {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            name?: string
        }
        return pkg.name ?? null
    } catch {
        return null
    }
}

/**
 * A crate's `.crate` tarball is fetched to a FILE and handed to `tar`, not piped:
 * `runChild` writes only strings to a child's stdin, so gzip bytes cannot go
 * through it. Windows ships bsdtar as `tar`, which reads `-xzf` the same way.
 */
async function acquireCrate(
    name: string,
    version: string,
    io: EcosystemIo
): Promise<AcquireResult> {
    const dir = path.join(io.modulesDir, 'cargo')
    const crate = crateOf(name)
    // A unique name per download. Research children run concurrently, and on a
    // fixed path one child's post-extract delete lands between another's write
    // and its `tar`, which then fails on a crate that was in fact fetched.
    const archive = path.join(dir, `.${crate}-${version}.${process.pid}.${Date.now()}.crate`)
    try {
        fs.mkdirSync(dir, {recursive: true})
        const response = await io.fetch(crateTarballUrl(crate, version), {
            headers: {'user-agent': 'pi-task (github.com/mjasnikovs/pi-task)'},
            ...(io.signal ? {signal: io.signal} : {})
        })
        if (!response.ok) {
            return {
                success: false,
                installDir: dir,
                stderr: `crates.io returned ${response.status} for ${crate} ${version}`
            }
        }
        fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    } catch (err) {
        return {
            success: false,
            installDir: dir,
            stderr: err instanceof Error ? err.message : String(err)
        }
    }
    return extractArchive(archive, dir, io)
}

/**
 * Unpack an archive and then delete it. The extracted tree is what every later
 * call reads, so keeping the tarball beside it only spends disk — and a `.tar.gz`
 * sitting among the package directories trips anything that treats the extract
 * directory as a list of packages.
 */
async function extractArchive(
    archive: string,
    dir: string,
    io: EcosystemIo
): Promise<AcquireResult> {
    const result = await runChild(
        io.spawn,
        {command: 'tar', args: ['-xzf', archive, '-C', dir]},
        dir,
        io.signal,
        {mode: 'text', discardStdout: true}
    )
    const success = result.exitCode === 0 && !result.aborted
    if (success) fs.rmSync(archive, {force: true})
    return {success, installDir: dir, stderr: result.stderr}
}

const cargoProfile: EcosystemProfile = {
    id: 'cargo',
    why:
        'Rust ships no declarations file, so the surface is cut out of .rs source. '
        + 'Versions come from Cargo.lock, not from a range: cargo has already resolved '
        + 'them, and the newest wins when a workspace holds two majors — the answer '
        + 'header states which was read. Note the asymmetry this leaves: in a repo with '
        + 'both manifests the docs tool answers from cargo while the final gate still '
        + 'runs the npm test command. Widening the gate is a separate change.',
    registryLabel: 'crates.io',
    manifestLabel: 'Cargo.toml',

    // One level down as well: a Tauri repo declares package.json at the root and
    // keeps its crate in `src-tauri/`.
    detect: cwd => foundAtOrAbove(cwd, d => fs.existsSync(path.join(d, 'Cargo.toml'))),
    isValidName: isValidCrateName,
    parentPackage: crateOf,

    resolve: (name, cwd, io) =>
        resolveCrate(name, cwd, {cargoHome: io.cargoHome, modulesDir: io.modulesDir}),
    // Cargo has already resolved every version; the lock IS the pin.
    declaredRange: (name, cwd) => lockedVersion(name, cwd),
    acquire: async (name, range, io) => {
        // Asked even when the range is known: the download host wants the name as
        // PUBLISHED, and only the API knows whether that is `tokio-util` or
        // `tokio_util`. A null answer falls back to the caller's spelling.
        const info = await cratesLatest(name, io.fetch, io.signal)
        const version = range ?? info?.latest
        if (!version) {
            return {
                success: false,
                installDir: path.join(io.modulesDir, 'cargo'),
                stderr: `No published version found for crate "${crateOf(name)}".`
            }
        }
        return acquireCrate(info?.pkg ?? name, version, io)
    },
    latest: (name, io) => cratesLatest(name, io.fetch, io.signal),

    isSurfaceFile: isRustFile,
    surface: content => rustSurface(content),
    declSplitRe: CARGO_DECL_SPLIT_RE,
    typeKeywords: ['struct', 'trait', 'enum', 'type', 'union'],
    commentPrefix: '//',
    skipDirs: ['tests', 'benches', 'examples', 'target'],
    surfaceLabel: '.rs source or README',
    packageSubject: 'a Rust crate from crates.io',
    projectGlobs: ['*.rs'],
    projectName: cargoProjectName,
    declaredDeps: lockedDeps,
    manifestDeps: manifestCrates
}

/**
 * Unpack a Hackage tarball into the tool's own directory. Whether it came from
 * cabal's cache or from Hackage, a `.tar.gz` is not readable in place, and
 * `runChild` writes only strings to stdin — so the archive is always a file on
 * disk and `tar` always reads it from there. Windows ships bsdtar as `tar`.
 */
async function extractTarball(
    archive: string,
    dir: string,
    io: EcosystemIo
): Promise<AcquireResult> {
    // Cabal's own cached tarball must survive; only a copy this tool downloaded
    // into its own directory is deleted after unpacking.
    if (path.dirname(archive) !== dir) {
        const result = await runChild(
            io.spawn,
            {command: 'tar', args: ['-xzf', archive, '-C', dir]},
            dir,
            io.signal,
            {mode: 'text', discardStdout: true}
        )
        return {
            success: result.exitCode === 0 && !result.aborted,
            installDir: dir,
            stderr: result.stderr
        }
    }
    return extractArchive(archive, dir, io)
}

const hackageProfile: EcosystemProfile = {
    id: 'hackage',
    why:
        'A Hackage package is a tarball, not a checked-out tree, so it is unpacked '
        + 'before it can be read — which is why acquire runs even for a package cabal '
        + 'already holds. Versions come from what the build actually resolved '
        + '(dist-newstyle/cache/plan.json), then a freeze file, then a stack lock. The '
        + 'row refuses a dotted MODULE name outright: Data.Aeson is not a package, and '
        + 'answering it from the wrong registry is the bug this whole table exists for.',
    registryLabel: 'hackage',
    manifestLabel: '*.cabal',

    detect: cwd => foundAtOrAbove(cwd, hasCabalManifest),
    isValidName: isValidHackageName,
    parentPackage: name => name,

    resolve: (name, cwd, io) => resolveHackage(name, cwd, {modulesDir: io.modulesDir}),
    declaredRange: (name, cwd) => hackageVersion(name, cwd),
    acquire: async (name, range, io) => {
        const dir = hackageExtractDir(io.modulesDir)
        const version =
            range
            ?? cachedVersions(name, io.cabalPackageDirs).pop()
            ?? (await hackageLatest(name, io.fetch, io.signal))?.latest
        if (!version) {
            return {
                success: false,
                installDir: dir,
                stderr: `No published version found for Hackage package "${name}".`
            }
        }
        try {
            fs.mkdirSync(dir, {recursive: true})
            const cached = findCabalTarball(name, version, io.cabalPackageDirs)
            if (cached) return await extractTarball(cached, dir, io)

            const response = await io.fetch(hackageTarballUrl(name, version), {
                ...(io.signal ? {signal: io.signal} : {})
            })
            if (!response.ok) {
                return {
                    success: false,
                    installDir: dir,
                    stderr: `hackage returned ${response.status} for ${name} ${version}`
                }
            }
            const archive = path.join(
                dir,
                `.${name}-${version}.${process.pid}.${Date.now()}.tar.gz`
            )
            fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
            return await extractTarball(archive, dir, io)
        } catch (err) {
            return {
                success: false,
                installDir: dir,
                stderr: err instanceof Error ? err.message : String(err)
            }
        }
    },
    supplements: async (pkg, cwd, io) => {
        const deps = manifestPackages(pkg.root)
        if (!deps) return []
        const candidates = supplementCandidates(pkg.name, deps, resolvedVersions(cwd) ?? {})
        const out: ResolvedPackage[] = []
        for (const c of candidates) {
            try {
                out.push(resolveHackage(c.name, cwd, {modulesDir: io.modulesDir}))
                continue
            } catch {
                // Not unpacked yet. `acquire` prefers the tarball cabal already
                // downloaded as a dependency, so this is local work, not a fetch.
            }
            const got = await hackageProfile.acquire(c.name, c.version, io)
            if (!got.success) continue
            try {
                out.push(resolveHackage(c.name, cwd, {modulesDir: io.modulesDir}))
            } catch {
                // A supplement that will not resolve leaves the facade as it was.
            }
        }
        return out
    },
    latest: (name, io) => hackageLatest(name, io.fetch, io.signal),

    isSurfaceFile: isHaskellFile,
    surface: haskellSurface,
    declSplitRe: HACKAGE_DECL_SPLIT_RE,
    typeKeywords: ['type', 'data', 'newtype', 'class'],
    commentPrefix: '--',
    skipDirs: HACKAGE_SKIP_DIRS,
    surfaceLabel: '.hs source or README',
    packageSubject: 'a Haskell package from Hackage',
    projectGlobs: ['*.hs'],
    projectName: hackageProjectName,
    declaredDeps: resolvedVersions,
    manifestDeps: manifestPackages
}

/** A cabal, stack or hpack project declares itself with one of these. */
function hasCabalManifest(cwd: string): boolean {
    if (
        ['cabal.project', 'stack.yaml', 'package.yaml'].some(f => fs.existsSync(path.join(cwd, f)))
    ) {
        return true
    }
    try {
        // A FILE named `<pkg>.cabal`. `~/.cabal` is cabal's own config DIRECTORY
        // and ends in the same six characters, so a bare suffix test makes every
        // directory under a Haskell developer's home look like a cabal project.
        return fs
            .readdirSync(cwd, {withFileTypes: true})
            .some(e => e.isFile() && e.name.length > '.cabal'.length && e.name.endsWith('.cabal'))
    } catch {
        return false
    }
}

export const ECOSYSTEMS = {
    npm: npmProfile(),
    cargo: cargoProfile,
    hackage: hackageProfile
} as const satisfies Record<EcosystemId, EcosystemProfile>

/** Which ecosystems `cwd` looks like a project of, in roster order. */
export function detectEcosystems(
    cwd: string,
    roster: readonly EcosystemProfile[] = Object.values(ECOSYSTEMS)
): EcosystemId[] {
    return roster.filter(p => p.detect(cwd)).map(p => p.id)
}

/**
 * Every dependency `cwd`'s manifests declare, across the ecosystems it is a
 * project of. Undefined when no detected ecosystem could read its manifest —
 * "we cannot tell", which callers must not read as "declares nothing".
 */
export function declaredDepNames(
    cwd: string,
    roster: readonly EcosystemProfile[] = Object.values(ECOSYSTEMS)
): Set<string> | undefined {
    let any = false
    const names = new Set<string>()
    for (const p of roster) {
        if (!p.detect(cwd)) continue
        const deps = p.manifestDeps(cwd)
        if (!deps) continue
        any = true
        for (const name of deps) names.add(name)
    }
    return any ? names : undefined
}

export type EcosystemChoice =
    | {ok: true; profile: EcosystemProfile; detected: EcosystemId[]}
    | {
          ok: false
          reason: 'none' | 'ambiguous' | 'not_detected'
          detected: EcosystemId[]
          message: string
      }

export interface ChooseEcosystemInput {
    cwd: string
    /** An explicit ecosystem, for a repo that holds more than one manifest. */
    requested?: EcosystemId
    /**
     * Does this row already have the package on disk? The tie-break for a
     * polyglot repo, and it must not install: an ambiguous name is exactly the
     * one that would be installed from the wrong registry.
     */
    resolvesLocally?: (profile: EcosystemProfile) => boolean
    /**
     * Does this row's MANIFEST name the package? Stronger evidence than a copy
     * on disk, and it outranks it below.
     */
    declaresPackage?: (profile: EcosystemProfile) => boolean
    roster?: readonly EcosystemProfile[]
}

/**
 * Which ecosystem a lookup belongs to. The MANIFEST decides, never the model:
 * `text`, `base`, `aeson`, `tokio` and `clap` are all real npm packages as well
 * as Haskell or Rust ones, so a name alone cannot say which registry was meant,
 * and guessing npm returns a confident answer about the wrong package.
 *
 * A refusal is a result, not a failure: the caller reports it and installs
 * nothing.
 */
export function chooseEcosystem(input: ChooseEcosystemInput): EcosystemChoice {
    const roster = input.roster ?? (Object.values(ECOSYSTEMS) as EcosystemProfile[])
    const detected = detectEcosystems(input.cwd, roster)
    const rowOf = (id: EcosystemId): EcosystemProfile => roster.find(p => p.id === id)!
    const manifests = roster.map(p => p.manifestLabel).join(', ')

    if (input.requested) {
        if (detected.includes(input.requested)) {
            return {ok: true, profile: rowOf(input.requested), detected}
        }
        const wanted = roster.find(p => p.id === input.requested)
        return {
            ok: false,
            reason: 'not_detected',
            detected,
            message:
                `No ${input.requested} project here: ${input.cwd} has no `
                + `${wanted?.manifestLabel ?? input.requested} manifest.`
        }
    }

    if (detected.length === 0) {
        return {
            ok: false,
            reason: 'none',
            detected,
            message:
                `${input.cwd} holds no package manifest this tool reads (${manifests}), `
                + 'so there is no registry to look the name up in and nothing was installed.'
        }
    }

    if (detected.length === 1) return {ok: true, profile: rowOf(detected[0]), detected}

    // Several manifests. A row whose MANIFEST names the package wins: in a Tauri
    // repo `semver` is pinned by Cargo.lock at 1.0.28 and merely sits in
    // node_modules as a transitive copy nothing declared, and taking the npm one
    // because npm leads the roster is the issue-#18 mistake with both packages
    // installed instead of neither.
    const declaring =
        input.declaresPackage ? detected.filter(id => input.declaresPackage!(rowOf(id))) : []
    if (declaring.length === 1) return {ok: true, profile: rowOf(declaring[0]), detected}
    if (declaring.length === 0 && input.resolvesLocally) {
        // Nobody declares it. A copy on disk is the only evidence left.
        for (const id of detected) {
            if (input.resolvesLocally(rowOf(id))) return {ok: true, profile: rowOf(id), detected}
        }
    }
    return {
        ok: false,
        reason: 'ambiguous',
        detected,
        message:
            `${input.cwd} holds manifests for ${detected.join(' and ')}, and this package `
            + 'is installed in none of them, so which registry to read is not decidable. '
            + `Pass ecosystem: "${detected[0]}" (or one of: ${detected.join(', ')}) to say which.`
    }
}
