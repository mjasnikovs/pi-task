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

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    runAutoInstall,
    findDeclaredRange,
    extractParentPackage,
    resolveTypeSourceForDocs,
    type AutoInstallPin
} from './docs-core.js'
import {resolvePackage, isDtsFile, isValidModuleName, type ResolvedPackage} from './docs-resolve.js'
import {DECL_SPLIT_RE} from './docs-chunk.js'
import {npmVersionLookup, type NpmVersionInfo} from './npm-version.js'
import type {SpawnFn} from '../shared/child-process.js'

export type EcosystemId = 'npm'

/**
 * Every filesystem, process and network reach a row is allowed. Rows read no
 * environment and call no global directly, so a test injects a fake registry and
 * a fake extractor instead of needing a real toolchain on the machine.
 */
export interface EcosystemIo {
    spawn: SpawnFn
    signal?: AbortSignal | undefined
}

/** What acquiring a package produced, whatever the registry. */
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
    /** Line-comment marker, used to label a chunk with the file it came from. */
    commentPrefix: string
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
        detect: cwd =>
            fs.existsSync(path.join(cwd, 'package.json'))
            || fs.existsSync(path.join(cwd, 'node_modules')),
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
        commentPrefix: '//'
    }
}

export const ECOSYSTEMS = {
    npm: npmProfile()
} as const satisfies Record<EcosystemId, EcosystemProfile>
