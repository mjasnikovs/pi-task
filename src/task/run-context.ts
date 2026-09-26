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
 * TREE HASH is the other half, used by the gate-evidence and repo-health caches;
 * its one implementation lives in tree-hash.ts.
 */
import {createHash} from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {SpawnFn} from '../shared/child-process.js'
import {makeGit} from '../shared/git-runner.js'
import {
    classifyCommandRun,
    spawnCommand,
    type CommandRun,
    type CommandRunner
} from './command-run.js'
import {declaredDepNames, detectEcosystems, type EcosystemId} from '../workers/docs-ecosystems.js'
import {newRunToken} from '../workers/research-cache.js'
import {getFileInventory} from './file-inventory.js'
import {packageScripts} from './launch-manifest.js'
import type {GateEvidence} from './gate-evidence.js'
import {getConfig} from '../config/config.js'
import {buildOrientation, parseIgnorePatterns, type OrientationResult} from './orientation.js'
import {HEALTH_MANIFEST_FILES, type HealthOutcome} from './repo-health-check.js'
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

/** The classes the gate-evidence runner may execute. `serve` is absent by
 *  definition: it never returns, and the parent has nothing to kill it with. */
const EVIDENCE_CLASSES: ReadonlySet<ToolingClass> = new Set<ToolingClass>(['check', 'build'])

/** Produce one tree's gate evidence, given the commands that may be run against it
 *  and the hash of the tree they are being run against (see gate-evidence.ts). */
export type EvidenceRunner = (
    commands: readonly VerifiedCommand[],
    treeHash: string | null
) => Promise<GateEvidence>

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

/**
 * The package script a line runs: `<pm> run <name>`, or the `test` shorthand of
 * npm, pnpm and yarn. `bun test` is bun's own runner. A line with more words is
 * none: npm keeps a trailing `--bail` as its own config, bun hands it to the script.
 */
function scriptNamed([runner = '', verb, name, ...rest]: string[]): string | undefined {
    if (!SCRIPT_RUNNERS.has(runner) || rest.length > 0) return undefined
    if (verb === 'run') return name
    return verb === 'test' && name === undefined && runner !== 'bun' ? 'test' : undefined
}

/**
 * What a check line RUNS, so two names for one package script share an identity:
 * a line naming a script is the script's body. A script with a `pre` or `post`
 * hook is not, since only the name runs the hook. Anything else is the line as
 * written.
 */
export function checkIdentity(line: string, scripts: Record<string, string>): string {
    const own = line.trim()
    const name = scriptNamed(own.split(/\s+/))
    const script = (key: string): string | undefined =>
        Object.hasOwn(scripts, key) && typeof scripts[key] === 'string' ? scripts[key] : undefined
    if (
        name === undefined
        || script(`pre${name}`) !== undefined
        || script(`post${name}`) !== undefined
    )
        return own
    return script(name)?.trim() ?? own
}

/** Did the run observe the tree? A gap (nothing spawned, 127, killed) did not, so
 *  it is never handed to a second caller in place of that caller's own run. */
const observedTree = (run: CommandRun): boolean =>
    // A clean exit is never a gap, so its output need not be read here.
    (!run.failedToStart && run.status === 0) || classifyCommandRun(run).outcome !== 'gap'

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
    private readonly _orientation = new Map<string, Promise<OrientationResult>>()
    private _orientationExclude: Promise<string[]> | undefined
    private _manifestDeps: string[] | undefined
    private _ecosystems: EcosystemId[] | undefined
    private _verifiedTooling: VerifiedCommand[] = []
    /** Commands verify-tooling has already refused under `_toolingHash`. */
    private _rejectedTooling = new Set<string>()
    private _toolingHash: string | undefined
    /** The verified commands each task's own TOOLING named. */
    private readonly _taskTooling = new Map<string, string[]>()
    private _evidence: {key: string; value: GateEvidence} | undefined
    /** Check runs on the one tree last asked about; see {@link checkRunner}. */
    private _checkRuns:
        {tree: string; runs: Map<string, {label: string; run: Promise<CommandRun>}>} | undefined
    private _evidenceQueue: Promise<unknown> = Promise.resolve()
    private _health: {hash: string; value: HealthOutcome} | undefined
    private _healthQueue: Promise<unknown> = Promise.resolve()

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

    /**
     * The orientation core over this run's whole inventory — the block the
     * exploring research workers get, built once however many tasks ask.
     *
     * Memoised per CITED SET, not once: the files a task points at are part of the
     * question, and two tasks citing different specs are asking for different
     * blocks. Every task in a /task-auto run carries the same threaded spec ref, so
     * in practice this is still one build.
     */
    orientation(cited: readonly string[] = []): Promise<OrientationResult> {
        const key = JSON.stringify([...cited].sort())
        let built = this._orientation.get(key)
        if (!built) {
            built = this.orientationOf(undefined, cited)
            this._orientation.set(key, built)
        }
        return built
    }

    /** The same block over a NARROWED candidate list (refine takes the manifest and
     *  config tiers only), which is per-caller and so not memoised. */
    async orientationOf(
        paths: string[] | undefined,
        cited: readonly string[] = []
    ): Promise<OrientationResult> {
        const candidates = paths ?? (await this.inventoryPaths())
        return buildOrientation(
            candidates,
            async p => {
                try {
                    return await fsp.readFile(path.resolve(this.cwd, p), 'utf8')
                } catch {
                    return null
                }
            },
            {cited, excludePatterns: await this.orientationExclusions()}
        ).catch(() => ({block: '', supplied: new Set<string>()}))
    }

    /**
     * What this project says is not its own source, on top of `VENDORED_DIRS`:
     * its `.gitignore`, plus the user's `orientationExclude`. Read once — a run
     * that re-read it mid-way would orient two tasks differently.
     */
    private orientationExclusions(): Promise<string[]> {
        this._orientationExclude ??= fsp
            .readFile(path.join(this.cwd, '.gitignore'), 'utf8')
            .then(parseIgnorePatterns)
            .catch(() => [])
            .then(fromGit => [...fromGit, ...getConfig().orientationExclude])
        return this._orientationExclude
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
     *
     * The answer is also remembered as `taskId`'s own, because the run's verdicts
     * are not a command list: each task's TOOLING names the same check its own way,
     * and a gate that ran them all would run one suite under every spelling.
     */
    async verifiedToolingFor(
        taskId: string,
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
        const named = this._verifiedTooling.filter(v => wanted.has(v.cmd))
        this._taskTooling.set(
            taskId,
            named.map(v => v.cmd)
        )
        return named
    }

    /**
     * This gate session's evidence: the check and build commands `taskId`'s own
     * TOOLING verified, run against the CURRENT tree, at most once per tree (see
     * gate-evidence.ts). A task this run never verified tooling for, one resumed
     * past research, gets every check the run verified.
     *
     * The TREE HASH is the key, so a lint-fix or an autofix that changes the tree
     * costs exactly one re-run and a second gate child on the same tree costs none.
     * A tree git cannot hash is never cached: "unchanged" is not something we could
     * claim about it.
     */
    gateEvidenceFor(taskId: string, produce: EvidenceRunner): Promise<GateEvidence> {
        // Serialised rather than merely memoised: two gate children asking at once
        // is exactly the duplicate suite run this cache exists to kill.
        const next = this._evidenceQueue.then(() => this.freshEvidence(taskId, produce))
        this._evidenceQueue = next.catch(() => {})
        return next
    }

    private async freshEvidence(taskId: string, produce: EvidenceRunner): Promise<GateEvidence> {
        const hash = await treeHash(this.cwd, this._signal ? {signal: this._signal} : {})
        const named = this._taskTooling.get(taskId)
        const commands = this._verifiedTooling.filter(
            v => (named?.includes(v.cmd) ?? true) && EVIDENCE_CLASSES.has(v.class)
        )
        const key = hash === null ? null : [hash, ...commands.map(c => c.cmd)].join('\n')
        if (key !== null && this._evidence?.key === key) return this._evidence.value
        const value = await produce(commands, hash)
        // {@link NOT_RUN} stands until something runs the command. This is that
        // something, so the verdicts stop claiming nobody has.
        for (const c of value.commands) {
            const verified = this._verifiedTooling.find(v => v.cmd === c.cmd)
            if (verified) verified.exitCode = c.exitCode
        }
        if (key !== null) this._evidence = {key, value}
        return value
    }

    /**
     * `base`, answering a labelled check from an earlier run of the same check on
     * the same tree. The verify gate's health check and its evidence ask for the
     * same suite back to back, often under two names (`bun run test`, `AGENT=1 bun
     * test`); {@link checkIdentity} makes them one ask. An answer from another
     * spelling carries the line that ran as `ranAs`.
     *
     * `tree` is the caller's hash of the tree in front of it. It stands until this
     * runner spawns something, which may move the tree.
     *
     * Only the latest tree's runs are held: every gate works on the tree in front
     * of it, so older ones are never asked for again.
     */
    checkRunner(base: CommandRunner = spawnCommand, tree: string | null = null): CommandRunner {
        let known = tree
        return async spec => {
            const label = spec.label
            const knownHere = spec.cwd === this.cwd ? known : null
            known = null
            if (label === undefined) return base(spec)
            const signal = spec.signal ?? this._signal
            const hash = knownHere ?? (await treeHash(spec.cwd, signal ? {signal} : {}))
            if (hash === null) return base(spec)
            const at = `${spec.cwd}\n${hash}`
            if (this._checkRuns?.tree !== at) this._checkRuns = {tree: at, runs: new Map()}
            const runs = this._checkRuns.runs
            const key = checkIdentity(label, packageScripts(spec.cwd))
            const earlier = runs.get(key)
            if (earlier) {
                const run = await earlier.run.catch(() => null)
                if (run && observedTree(run)) {
                    if (spec.cwd === this.cwd) known = hash
                    return earlier.label === label ? run : {...run, ranAs: earlier.label}
                }
            }
            const fresh = {label, run: base(spec)}
            runs.set(key, fresh)
            const run = await fresh.run.catch((e: unknown) => {
                runs.delete(key)
                throw e
            })
            if (!observedTree(run) && runs.get(key) === fresh) runs.delete(key)
            return run
        }
    }

    /**
     * The repo-health check with its suite, at most once per tree, on the same terms
     * as {@link gateEvidenceFor}. A verify, the enforce baseline on the commit it
     * just judged and the next task's checkpoint all measure one tree; each running
     * the whole suite again is the cost this removes.
     *
     * Stored under the tree the check LEFT, not the one it found: a `--fix` lint
     * moves the tree, and the result describes the fixed one.
     */
    healthFor(produce: (tree: string | null) => Promise<HealthOutcome>): Promise<HealthOutcome> {
        const next = this._healthQueue.then(() => this.freshHealth(produce))
        this._healthQueue = next.catch(() => {})
        return next
    }

    private async freshHealth(
        produce: (tree: string | null) => Promise<HealthOutcome>
    ): Promise<HealthOutcome> {
        const opts = this._signal ? {signal: this._signal} : {}
        const found = await treeHash(this.cwd, opts)
        if (found !== null && this._health?.hash === found) return this._health.value
        const value = await produce(found)
        const left = await treeHash(this.cwd, opts)
        if (left !== null) this._health = {hash: left, value}
        return value
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
