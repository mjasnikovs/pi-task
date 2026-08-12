/**
 * Reading a recorded run: one section grammar, one discovery, one read-only git.
 *
 * WHY THIS EXISTS. Harnesses that read a recorded `.pi-tasks` corpus each carried
 * their own reader: 17 private `section(doc, name)` parsers in six incompatible
 * grammars — some case-sensitive on the heading, some not; 13 returned `''` for a
 * missing section, 4 threw, and one of those raised a TypeError off a `!`
 * assertion. A spec heading written `## Spec` yielded an empty section in five
 * harnesses and an exception in four.
 *
 * The worst of it was in the instrument validation itself:
 * `owned-freeze-delivered-ab.ts` threw on a missing section while its own
 * `owned-freeze-delivered-scorer-check.ts` returned `''`. The script written to
 * prove the scorer correct did not exercise the scorer's reader. The
 * `refuted-constraint` pair had the same split.
 *
 * THE INTERFACE CHOICE THAT MATTERS: `section()` returns `string | undefined`.
 * A missing section and an empty one are DIFFERENT FACTS, and collapsing them is
 * the "absence of evidence shaped like evidence" that `ab-verdict.ts` exists to
 * stop, one level down. A harness that cannot tell "this spec has no VERIFY
 * block" from "this task file was never written" will score the second as the
 * first and report a clean zero.
 *
 * READ-ONLY BY CONTRACT. This is the read-side twin of `scratch-repo.ts`, which
 * owns throwaway trees. Nothing here writes, checks out, or adds a worktree: a
 * recorded corpus is evidence, and `scratch-repo.ts` already states the rule —
 * "the numbers in VALIDATION-DEBT.md were measured by those judgements, and a
 * fixture helper that quietly altered one would invalidate a recorded result."
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync, readdirSync, type Dirent} from 'node:fs'
import * as path from 'node:path'

/**
 * The ONE section grammar. Case-insensitive on the heading, tolerant of the
 * spacing after `##`, and terminated by the next `##` heading.
 *
 * Returns `undefined` when the section is absent — never `''`, never a throw.
 * An empty string means the heading was there with nothing under it, which is a
 * real and different observation.
 */
export function readSection(doc: string, name: string): string | undefined {
    const m = new RegExp(String.raw`^##\s+${escapeRe(name)}\s*$`, 'im').exec(doc)
    if (m === null) return undefined
    const rest = doc.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** One recorded task file. */
export interface TaskRecord {
    /** e.g. `TASK_0017`. */
    id: string
    /** Absolute path to the `.md`. */
    file: string
    /** The whole document. */
    raw: string
    /** A named section, or `undefined` when the heading is absent. */
    section(name: string): string | undefined
}

/** One recorded run: a tree with a `.pi-tasks` directory somewhere in it. */
export interface RecordedRun {
    /** Label for reports — the pool name, or `pool@commit` for a pinned export. */
    readonly label: string
    /** The tree root. */
    readonly root: string
    /** The `.pi-tasks` directory. */
    readonly tasksDir: string
    /** Every `TASK_NNNN.md`, sorted by id. */
    tasks(): TaskRecord[]
    /** The owned-requirements ledger text, or undefined when absent. */
    ownedLedger(): string | undefined
    /** The accept-debt ledger text, or undefined when absent. */
    acceptDebt(): string | undefined
    /** Declared dependencies + devDependencies of the tree's package.json. */
    packages(): string[]
    /** Read-only git against this tree. Never throws, never writes. */
    git(args: string[]): {stdout: string; exitCode: number}
}

/**
 * Open a recorded run, or return null when there is nothing to read.
 *
 * Null is the caller's cue to ABSTAIN. It is deliberately not an exception and
 * deliberately not an empty run: "no corpus on this machine" must not arrive at
 * a scorer looking like "a corpus with no findings".
 */
export function openRecordedRun(root: string, label = path.basename(root)): RecordedRun | null {
    const tasksDir = path.join(root, '.pi-tasks')
    if (!existsSync(tasksDir)) return null
    return {
        label,
        root,
        tasksDir,
        tasks(): TaskRecord[] {
            let names: string[]
            try {
                names = readdirSync(tasksDir).filter(f => /^TASK_\d+\.md$/.test(f)).sort()
            } catch {
                return []
            }
            const out: TaskRecord[] = []
            for (const f of names) {
                const file = path.join(tasksDir, f)
                let raw: string
                try {
                    raw = readFileSync(file, 'utf8')
                } catch {
                    continue
                }
                out.push({
                    id: f.replace(/\.md$/, ''),
                    file,
                    raw,
                    section: (name: string) => readSection(raw, name)
                })
            }
            return out
        },
        ownedLedger: () => readIfPresent(path.join(tasksDir, 'requirements-owned.md')),
        acceptDebt: () => readIfPresent(path.join(tasksDir, 'accept-debt.md')),
        packages: () => declaredPackages(root),
        git: (args: string[]) => readOnlyGit(root, args)
    }
}

function readIfPresent(file: string): string | undefined {
    try {
        return readFileSync(file, 'utf8')
    } catch {
        return undefined
    }
}

/**
 * Every declared dependency of a tree. Replaces four copies that differed only in
 * whether they caught a malformed package.json.
 */
export function declaredPackages(dir: string): string[] {
    try {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
        return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    } catch {
        return []
    }
}

/**
 * Read-only git. Returns `{stdout, exitCode}` and never throws — the same shape
 * `makeGit` uses in src/, so `trackedSourceOracle` and friends take it directly.
 *
 * Twenty private `git()` helpers existed across scripts/ with SIX disagreeing
 * return types (`string`, `string|null`, `{stdout,exitCode}`, `{code,out}`,
 * `{ok,out}`, `Promise<…>`), so a caller could not move between harnesses without
 * re-reading which one it had.
 */
export function readOnlyGit(cwd: string, args: string[]): {stdout: string; exitCode: number} {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
    return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
}

/**
 * Find every `.pi-tasks/<name>` under a root, breadth-limited.
 *
 * Replaces `findLedgers` (byte-identical in three files), `findTaskDirs` (three)
 * and `corpusOf` (four).
 */
export function findCorpusFiles(root: string, name: string, maxDepth = 4): string[] {
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
        if (depth > maxDepth) return
        let entries: Dirent[]
        try {
            entries = readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue
            if (e.name === 'node_modules' || e.name === '.git') continue
            const child = path.join(dir, e.name)
            if (e.name === '.pi-tasks') {
                const f = path.join(child, name)
                if (existsSync(f)) out.push(f)
                continue
            }
            walk(child, depth + 1)
        }
    }
    walk(root, 0)
    return out
}

/** Open every recorded run under a set of pool directories, skipping absent ones. */
export function openPools(hub: string, pools: readonly string[]): RecordedRun[] {
    return pools
        .map(p => openRecordedRun(path.join(hub, p), p))
        .filter((r): r is RecordedRun => r !== null)
}
