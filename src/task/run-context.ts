/**
 * run-context — what is true of the RUN rather than of the task inside it.
 *
 * A /task-auto run is many task pipelines over one unchanging project. The file
 * inventory, the orientation core, the manifest's dependency names, the detected
 * ecosystems and the verified tooling commands are all facts about the PROJECT,
 * and every one of them was being re-derived per task: twenty-one verify-tooling
 * children asking the same question of the same package.json, each free to answer
 * differently.
 *
 * So they are held here, once per run, and handed to the phases through
 * `PhaseDeps.runContext`. A bare `/task` is a run of one task and gets its own
 * context with a minted id, so nothing has two code paths.
 *
 * INVALIDATION. Verified tooling is invalidated by the MANIFEST HASH alone — the
 * content of the files `discoverHealthCommands` reads. A task that edits source
 * cannot change which commands exist; a task that adds a script can, and that is
 * exactly what the hash moves on. Everything else here describes the tree as the
 * run found it and is not re-read: a mid-run inventory refresh would hand two
 * tasks different orientation cores for the same question.
 *
 * TREE HASH is the other half, used by the gate-evidence cache; its one
 * implementation lives in tree-hash.ts.
 */
import {createHash} from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {SpawnFn} from '../shared/child-process.js'
import {makeGit} from '../shared/git-runner.js'
import {declaredDepNames, detectEcosystems, type EcosystemId} from '../workers/docs-ecosystems.js'
import {newRunToken} from '../workers/research-cache.js'
import {getFileInventory} from './file-inventory.js'
import {buildOrientation, type OrientationResult} from './orientation.js'
import {HEALTH_MANIFEST_FILES} from './repo-health-check.js'
import {worktreeTreeHash} from './tree-hash.js'

/**
 * What a verified command is FOR, and the only column that decides whether the
 * gate-evidence runner may execute it: `check` and `build` terminate on their own,
 * `serve` does not and is never launched.
 */
export type ToolingClass = 'check' | 'build' | 'serve'

/**
 * The exit code of a command nobody has run. verify-tooling confirms a command
 * from STATIC evidence (a script in the manifest, a binary in node_modules/.bin)
 * and is forbidden to execute it, so its entries carry this until the evidence
 * runner replaces them with a real result.
 */
export const NOT_RUN = -1

/** One command this run has verified, with the manifest state that vouched for it. */
export interface VerifiedCommand {
    cmd: string
    /** Where it runs — the repo root today; a monorepo package tomorrow. */
    cwd: string
    class: ToolingClass
    /** {@link NOT_RUN} until something actually runs it. */
    exitCode: number
    verifiedAt: number
    manifestHash: string
}

/** The worktree content as a git tree object (see tree-hash.ts), or null when
 *  git cannot say. */
export async function treeHash(
    cwd: string,
    opts: {signal?: AbortSignal; spawnFn?: SpawnFn} = {}
): Promise<string | null> {
    return worktreeTreeHash(makeGit(cwd, opts.signal, opts.spawnFn))
}

/**
 * Content hash of the files that decide which commands this project HAS — the
 * manifests `discoverHealthCommands` reads, plus the Makefile. A missing file
 * contributes nothing, and since each contributing file is hashed under its own
 * name, adding or deleting one moves the hash.
 */
export async function manifestHash(cwd: string): Promise<string> {
    const h = createHash('sha256')
    for (const file of HEALTH_MANIFEST_FILES) {
        try {
            h.update(file)
            h.update('\u0000')
            h.update(await fsp.readFile(path.join(cwd, file)))
            h.update('\u0000')
        } catch {
            // absent or unreadable ⇒ contributes nothing
        }
    }
    return h.digest('hex')
}

/** A verify-tooling verdict as the child reported it, before it is dated and stored. */
export interface ToolingVerdict {
    cmd: string
    class: ToolingClass
}

/** Everything the run-level tooling cache asks of its verifier. */
export type VerifyToolingFn = (commands: string[]) => Promise<{
    verified: ToolingVerdict[]
    rejected: string[]
}>

export interface RunContextOptions {
    cwd: string
    /** Reuse an existing id (a resumed /task-auto run); minted when absent. */
    runId?: string
    signal?: AbortSignal
}

/**
 * The per-run facts, computed on first ask and then held.
 *
 * Every getter is memoised on the PROMISE, not on the value, so two phases asking
 * at once still produce one computation.
 */
export class RunContext {
    readonly cwd: string
    readonly runId: string
    private readonly _signal: AbortSignal | undefined
    private _inventory: Promise<string> | undefined
    private _orientation: Promise<OrientationResult> | undefined
    private _manifestDeps: string[] | undefined
    private _ecosystems: EcosystemId[] | undefined
    private _verifiedTooling: VerifiedCommand[] = []
    /** Commands verify-tooling has already refused under `_toolingHash`. */
    private _rejectedTooling = new Set<string>()
    private _toolingHash: string | undefined

    constructor(opts: RunContextOptions) {
        this.cwd = opts.cwd
        this.runId = opts.runId ?? newRunToken()
        this._signal = opts.signal
    }

    /** `git ls-files` for this run; '' outside a git tree (see file-inventory.ts). */
    inventory(): Promise<string> {
        this._inventory ??= getFileInventory(this.cwd, this._signal).catch(() => '')
        return this._inventory
    }

    /** This run's inventory as paths, blank lines dropped. */
    async inventoryPaths(): Promise<string[]> {
        return (await this.inventory()).split('\n').filter(l => l.trim().length > 0)
    }

    /** The orientation core over this run's whole inventory — the block the
     *  read-heavy research workers get, built once however many tasks ask. */
    orientation(): Promise<OrientationResult> {
        this._orientation ??= this.orientationOf(undefined)
        return this._orientation
    }

    /** The same block over a NARROWED candidate list (refine takes the manifest and
     *  config tiers only), which is per-caller and so not memoised. */
    async orientationOf(paths: string[] | undefined): Promise<OrientationResult> {
        const candidates = paths ?? (await this.inventoryPaths())
        return buildOrientation(candidates, async p => {
            try {
                return await fsp.readFile(path.resolve(this.cwd, p), 'utf8')
            } catch {
                return null
            }
        }).catch(() => ({block: '', supplied: new Set<string>()}))
    }

    /**
     * Dependency names this project's manifests declare, across every ecosystem it
     * is a project of. `[]` when no manifest could be read — callers use it to tell
     * "this bullet is about a library" from "this bullet is about our source", and
     * that degrades to a no-op rather than an error.
     */
    manifestDeps(): string[] {
        this._manifestDeps ??= [...(declaredDepNames(this.cwd) ?? [])]
        return this._manifestDeps
    }

    ecosystems(): EcosystemId[] {
        this._ecosystems ??= detectEcosystems(this.cwd)
        return this._ecosystems
    }

    /** What this run has verified so far, newest verdict per command. */
    get verifiedTooling(): readonly VerifiedCommand[] {
        return this._verifiedTooling
    }

    /**
     * The verified subset of `commands`, running `verify` only for the ones this
     * run has no verdict for.
     *
     * A manifest edit — a new script, a new Makefile target — is the only thing that
     * can change which commands the project has, so it is the only thing that drops
     * the verdicts. Short of that, the second task's identical TOOLING list is
     * answered from the first task's child.
     */
    async verifiedToolingFor(
        commands: string[],
        verify: VerifyToolingFn
    ): Promise<VerifiedCommand[]> {
        const hash = await manifestHash(this.cwd)
        if (hash !== this._toolingHash) {
            this._verifiedTooling = []
            this._rejectedTooling = new Set()
            this._toolingHash = hash
        }
        const decided = new Set([
            ...this._verifiedTooling.map(v => v.cmd),
            ...this._rejectedTooling
        ])
        const unknown = commands.filter(c => !decided.has(c))
        if (unknown.length > 0) {
            const r = await verify(unknown)
            const at = Date.now()
            for (const v of r.verified) {
                this._verifiedTooling.push({
                    cmd: v.cmd,
                    cwd: this.cwd,
                    class: v.class,
                    exitCode: NOT_RUN,
                    verifiedAt: at,
                    manifestHash: hash
                })
            }
            for (const c of r.rejected) this._rejectedTooling.add(c)
        }
        const wanted = new Set(commands)
        return this._verifiedTooling.filter(v => wanted.has(v.cmd))
    }
}

/**
 * The context of the run that owns the session right now, set by the run bracket.
 *
 * A module-level holder rather than a parameter because the path from a command
 * handler to a phase runs through `runTask`, a seam whose signature is shared with
 * the gates; threading the context through it would put a field on two dep bags
 * that nothing but this would ever set.
 */
let currentRun: RunContext | null = null

/** Open a run: every task inside it now shares one context. Nests — an inner
 *  bracket returns the outer run's context untouched. */
export function openRunContext(cwd: string, runId?: string): RunContext {
    if (currentRun && currentRun.cwd === cwd) return currentRun
    currentRun = new RunContext({cwd, ...(runId === undefined ? {} : {runId})})
    return currentRun
}

/** Close the run `rc` opened. A stale close (an inner bracket ending after the
 *  outer one) is a no-op. */
export function closeRunContext(rc: RunContext): void {
    if (currentRun === rc) currentRun = null
}

/**
 * The open run's context, or a fresh one for a caller outside any bracket (a
 * direct `runSingleTask`, a test). The fallback is deliberately NOT registered:
 * an unbracketed caller has no run to end, and a context that outlived its caller
 * would serve a later run a stale inventory.
 */
export function currentRunContext(cwd: string): RunContext {
    return currentRun && currentRun.cwd === cwd ? currentRun : new RunContext({cwd})
}

/** The open run's id for `cwd`, or null outside any bracket. */
export function openRunId(cwd: string): string | null {
    return currentRun && currentRun.cwd === cwd ? currentRun.runId : null
}
