/**
 * foreign-path — deterministic detection (and mechanical repair) of ABSOLUTE PATHS
 * a child leaked from its own sandbox into a committed source/config file.
 *
 * The failure this closes (mx5 run 13, PROMPT 4 item 1): TASK_0023 committed
 * `playwright-ct.config.ts` carrying vite aliases pinned to the child's sandbox
 * mount —
 *     '../../shared': '/workspace/src/shared',
 *     '../api':       '/workspace/src/client/api',
 * — paths that exist only inside the child's view of the world. On the host,
 * `bun run test:ct` cannot even BUILD: 63 tests collected, 0 run, ENOENT. The
 * component-test suite was dead for the rest of the run and nothing noticed,
 * because every gate that could have noticed ran a DIFFERENT command.
 *
 * THE DISCRIMINATOR IS NOT THE MOUNT NAME. An earlier framing of this guard keyed
 * on knowing the sandbox prefix (`/workspace`) and matching it literally. That is
 * brittle in both directions: the prefix varies by harness/container, and plenty of
 * absolute paths that are NOT leaks would still match a prefix list. The signal that
 * actually separates a leak from a legitimate absolute path is structural:
 *
 *   an absolute path that (a) does NOT exist on the host, but (b) whose TAIL — after
 *   stripping one or more leading segments — resolves to a real path INSIDE this repo.
 *
 * `/workspace/src/shared` fires: it does not exist here, and `src/shared` does.
 * `/var/www/html`, `/etc/nginx/nginx.conf`, `/usr/bin/env` do not fire: nothing in
 * the repo mirrors their tail. A path that DOES exist on the host is never a leak by
 * this definition — it is a (possibly non-portable) real reference, a different and
 * much weaker class this guard deliberately stays out of.
 *
 * That same structure is what makes the repair mechanical rather than a guess: the
 * resolved repo path IS the correct target, so the rewrite is a literal substitution
 * of the absolute string with the path relative to the FILE that carries it
 * (`/workspace/src/shared` → `./src/shared` in a root-level config). No model, no
 * reformatting — one string swapped for one string, and only when the relative form
 * resolves to the same real file.
 *
 * Guard direction (repo-wide rule): may only cost time, never work. Every
 * inconclusive input steps aside — an unreadable file, a path whose tail matches
 * nothing, a rewrite whose relative form does not resolve. Container manifests are
 * excluded outright: `/workspace/...` in a Dockerfile or a compose file is the
 * declared truth of that image, not a leak.
 */
import * as path from 'node:path'
import type {AddedLine} from './probe-gaming.js'
import {isTestFile} from './substitution-probe.js'

/** One leaked absolute path found in a committed file. */
export interface ForeignPathFinding {
    /** Repo-relative file the leaked path was committed into. */
    file: string
    /** The absolute path exactly as written in the file. */
    absolute: string
    /** The repo-relative path its tail resolves to (the repair target). */
    repoPath: string
    /** The leading segments that are foreign to this host (e.g. `/workspace`). */
    foreignPrefix: string
    /** The verbatim line carrying the leak, trimmed. */
    line: string
}

/**
 * Files whose absolute paths describe a CONTAINER's filesystem by design — a
 * `WORKDIR /workspace` or a bind-mount target is the declared truth there, not a
 * leak. Excluded outright rather than special-cased downstream.
 */
const CONTAINER_MANIFEST_RE =
    /(^|\/)(?:Dockerfile[^/]*|[^/]*\.dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|devcontainer\.json)$/i

/**
 * Only source/config text is scanned. A leaked path inside a lockfile, a build
 * artifact, or a binary is either machine-regenerated or unreadable — neither is
 * this guard's business, and both are FP farms.
 */
const SCANNABLE_EXT_RE = /\.(?:[cm]?[jt]sx?|json|jsonc|toml|ya?ml|ini|cfg|conf|env|sh|bash)$/i

/**
 * Machine-generated files whose contents are not authored decisions: dependency
 * and build trees, lockfiles, and — the FP suite's first catch — TOOL CACHES and
 * REPORTS. mx5 ships a committed `.playwright-cache/metainfo.json` recording the
 * absolute path of every module the CT runner compiled inside the sandbox: 38
 * perfectly-real `/workspace/...` strings that faithfully record a past build
 * rather than expressing a decision anything will act on again.
 */
const GENERATED_RE =
    /(^|\/)(?:node_modules|dist|build|out|vendor|coverage|\.git|\.next|\.nuxt|\.turbo|\.vite|\.output|[^/]*cache[^/]*|test-results|playwright-report)\/|(^|\/)[^/]*lock[^/]*\.json$/i

/**
 * Absolute POSIX paths, at least two segments deep. The leading `/` must not be
 * preceded by a path/URL character, so `https://host/api/x`, `a/b/c`, and `//net`
 * never match — only a path that genuinely starts at the filesystem root.
 */
const ABS_PATH_RE = /(^|[^A-Za-z0-9._/:~-])(\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]+)/g

/** Bound the scan so a pathological diff cannot make the probe expensive. */
const MAX_FINDINGS = 40

/**
 * A line that is ENTIRELY a comment. A leaked path in a comment resolves nothing
 * and breaks nothing — and prose about paths is where examples live. (Caught by
 * the FP suite once this module's own documentation started discussing
 * `/workspace/...`.) A trailing comment on a real code line is not skipped: the
 * code before it is still live.
 */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*(?!\/)|\*\/|#|<!--|--(?!\S)|;)/

/**
 * Resolve a repo-relative path to the real thing it names, honouring the
 * extensionless module specifiers config files use (`src/client/api` →
 * `src/client/api.ts`). Returns the resolved repo-relative path, or null.
 *
 * This mirrors how the tools that CONSUME these paths (vite/tsconfig aliases,
 * bundler resolvers) look them up — without it the mx5 true positive
 * `/workspace/src/client/api` would be missed, since only `src/client/api.ts` exists.
 */
export function resolveRepoPath(rel: string, exists: (rel: string) => boolean): string | null {
    if (exists(rel)) return rel
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json']) {
        if (exists(rel + ext)) return rel + ext
    }
    for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx']) {
        if (exists(rel + idx)) return rel + idx
    }
    return null
}

/**
 * Scan a task's added lines for sandbox-leaked absolute paths.
 *
 * `existsOnHost` answers for an ABSOLUTE path; `existsInRepo` for a REPO-RELATIVE
 * one. Both are injected so the detector is pure and unit-testable against a
 * synthetic tree.
 *
 * The tail search strips the FEWEST leading segments that still resolve, so the
 * finding names the smallest foreign prefix (`/workspace`, not `/workspace/src`)
 * and the largest repo-relative target — the reading that matches how a mount
 * actually shadows a tree.
 */
export function findForeignPaths(
    lines: AddedLine[],
    existsOnHost: (abs: string) => boolean,
    existsInRepo: (rel: string) => boolean
): ForeignPathFinding[] {
    const out: ForeignPathFinding[] = []
    const seen = new Set<string>()
    for (const {path: file, text} of lines) {
        if (out.length >= MAX_FINDINGS) break
        if (CONTAINER_MANIFEST_RE.test(file)) continue
        if (GENERATED_RE.test(file)) continue
        // Test files legitimately carry synthetic absolute paths as FIXTURE data
        // (pi-task's own single-read-guard.test.ts asserts on the literal string
        // '/workspace/package.json'). A leak that actually breaks a build lives in
        // source or config; excluding tests trades unreachable recall for the FP
        // class most likely to fire, which is the guard's safe direction.
        if (isTestFile(file)) continue
        if (!SCANNABLE_EXT_RE.test(file)) continue
        if (COMMENT_LINE_RE.test(text)) continue
        for (const m of text.matchAll(ABS_PATH_RE)) {
            const abs = m[2]
            const key = `${file} ${abs}`
            if (seen.has(key)) continue
            // A path wrapped in backticks is being NAMED, not used — the markdown
            // convention for citing a path in prose, which turns up inside string
            // literals too (prompt text, error messages, documentation). Config
            // and imports that actually resolve a path never backtick it.
            const start = (m.index ?? 0) + m[1].length
            if (text[start - 1] === '`' && text[start + abs.length] === '`') continue
            // A path that really exists here is a live reference, not a leak.
            if (existsOnHost(abs)) continue
            const segments = abs.split('/').filter(s => s.length > 0)
            // A `.`/`..` component means the tail is not a name at all — it walks.
            // `/tmp/pi-task-ab/.` "resolves" to the repo ROOT, which is true of
            // every path and evidence of nothing (the FP suite's second catch).
            if (segments.some(s => s === '.' || s === '..')) continue
            // Strip the fewest leading segments whose remainder resolves in-repo.
            for (let strip = 1; strip < segments.length; strip++) {
                const rel = segments.slice(strip).join('/')
                const repoPath = resolveRepoPath(rel, existsInRepo)
                if (repoPath === null) continue
                // A tail that is a single, extensionless top-level name (`src`,
                // `dist`, `lib`) is too generic to be evidence — almost every repo
                // has one, so almost any absolute path "resolves". Require either a
                // nested path or a concrete filename. (The FP suite's last catch:
                // `/home/<someone>/proj/src` in prose matched the repo's own `src`.)
                if (!rel.includes('/') && !/\.[A-Za-z0-9]+$/.test(rel)) continue
                seen.add(key)
                out.push({
                    file,
                    absolute: abs,
                    repoPath,
                    foreignPrefix: '/' + segments.slice(0, strip).join('/'),
                    line: text.trim().slice(0, 200)
                })
                break
            }
        }
    }
    return out
}

/**
 * The repair for one finding: the leaked absolute path rewritten relative to the
 * FILE that carries it, in the `./`-prefixed form config resolvers expect. A target
 * in a parent directory keeps its `../` form (already relative, no prefix needed).
 */
export function relativeRepairFor(finding: ForeignPathFinding): string {
    const fromDir = path.posix.dirname(finding.file)
    const rel = path.posix.relative(fromDir === '.' ? '' : fromDir, finding.repoPath)
    return rel.startsWith('.') ? rel : './' + rel
}

/**
 * Apply every finding for ONE file to that file's text, as literal substitutions.
 * Returns the new text and the substitutions made; `text` is returned untouched
 * when nothing applied (the caller then writes nothing).
 *
 * Deliberately a plain string replacement of a path literal for a path literal: it
 * cannot reflow, reformat, or restructure the file, so a rewrite that turns out to
 * be semantically wrong is still trivially reviewable in the diff. A finding whose
 * absolute string is no longer present (the file moved on) is skipped.
 */
export function applyForeignPathRepairs(
    text: string,
    findings: ForeignPathFinding[]
): {text: string; applied: Array<{from: string; to: string}>} {
    let out = text
    const applied: Array<{from: string; to: string}> = []
    // Longest first, so `/workspace/src/shared` is not clobbered by a repair for
    // a `/workspace/src` finding that happens to be a prefix of it.
    const ordered = [...findings].sort((a, b) => b.absolute.length - a.absolute.length)
    for (const f of ordered) {
        if (!out.includes(f.absolute)) continue
        const to = relativeRepairFor(f)
        out = out.split(f.absolute).join(to)
        applied.push({from: f.absolute, to})
    }
    return {text: out, applied}
}

/** IO seam for the repair pass; injected so the orchestration is unit-testable. */
export interface ForeignPathRepairIO {
    readFile: (rel: string) => Promise<string>
    writeFile: (rel: string, text: string) => Promise<void>
    /** Does this repo-relative path exist? Used to RE-VALIDATE each repair. */
    existsInRepo: (rel: string) => boolean
}

export interface ForeignPathRepairResult {
    /** Human-readable repairs actually written, e.g. `cfg.ts: /workspace/src → ./src`. */
    repaired: string[]
    /** Findings left alone — these become the verify finding. */
    remaining: ForeignPathFinding[]
}

/**
 * Deterministically repair what can be repaired, and hand back the rest.
 *
 * Every repair is RE-VALIDATED before it is written: the file-relative form is
 * resolved back to a repo path and must land on the same real file the finding
 * named. A repair that does not re-resolve is dropped and its finding stays in
 * `remaining`, where the verify block will raise it for a human or an AUTOFIX
 * round. An unreadable or unwritable file does the same. Nothing here can turn a
 * working path into a broken one — the only edit it makes is swapping a path that
 * provably does not resolve for one that provably does.
 */
export async function repairForeignPaths(
    findings: ForeignPathFinding[],
    io: ForeignPathRepairIO
): Promise<ForeignPathRepairResult> {
    const repaired: string[] = []
    const remaining: ForeignPathFinding[] = []
    const byFile = new Map<string, ForeignPathFinding[]>()
    for (const f of findings) {
        const list = byFile.get(f.file)
        if (list) list.push(f)
        else byFile.set(f.file, [f])
    }
    for (const [file, group] of byFile) {
        // RE-VALIDATION: keep only repairs whose relative form resolves back to
        // the very file the finding identified.
        const fromDir = path.posix.dirname(file)
        const valid = group.filter(f => {
            const rel = relativeRepairFor(f)
            const resolved = path.posix.normalize(
                path.posix.join(fromDir === '.' ? '' : fromDir, rel)
            )
            return resolveRepoPath(resolved, io.existsInRepo) === f.repoPath
        })
        remaining.push(...group.filter(f => !valid.includes(f)))
        if (valid.length === 0) continue
        let text: string
        try {
            text = await io.readFile(file)
        } catch {
            remaining.push(...valid)
            continue
        }
        const {text: fixed, applied} = applyForeignPathRepairs(text, valid)
        if (applied.length === 0) {
            remaining.push(...valid)
            continue
        }
        try {
            await io.writeFile(file, fixed)
        } catch {
            remaining.push(...valid)
            continue
        }
        for (const a of applied) repaired.push(`${file}: \`${a.from}\` → \`${a.to}\``)
        // A finding whose literal did not appear in the file was not written.
        const writtenFrom = new Set(applied.map(a => a.from))
        remaining.push(...valid.filter(f => !writtenFrom.has(f.absolute)))
    }
    return {repaired, remaining}
}

/**
 * Verify-child prompt lines: one per leak, naming the file, the leaked path, and
 * the real repo path it shadows. Empty findings → empty array (caller emits no
 * block), matching every other probe's contract.
 */
export function foreignPathVerifyFindings(findings: ForeignPathFinding[]): string[] {
    return findings.map(
        f =>
            `${f.file} — committed the absolute path \`${f.absolute}\`, which does not exist on `
            + `this machine; \`${f.repoPath}\` is the real file it means (leaked prefix `
            + `\`${f.foreignPrefix}\`). Line: ${f.line}`
    )
}

/**
 * Render findings as a critique/enforce defect block — the same shape as
 * skipEscapeDefectText: a numbered list the rewrite must resolve.
 */
export function foreignPathDefectText(findings: ForeignPathFinding[]): string {
    return [
        'SANDBOX PATH LEAK — this work committed absolute filesystem paths that exist only',
        "inside the authoring agent's own environment, not on the machine that runs the",
        'project (mx5 run 13: a committed `/workspace/...` vite alias made `test:ct` fail to',
        'BUILD — 63 tests collected, 0 run — and the suite stayed dead for the rest of the',
        'run). Replace each with a path relative to the file that carries it, or with a',
        'resolution the project computes at runtime from its own location. Never hardcode an',
        'absolute path to project-internal files:',
        ...findings.map(
            (f, i) =>
                `  ${i + 1}. ${f.file}: \`${f.absolute}\` → should be \`${relativeRepairFor(f)}\``
        )
    ].join('\n')
}
