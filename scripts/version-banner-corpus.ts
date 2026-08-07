/**
 * The docs version-banner corpus: every `pi-worker-docs` cache entry, with its
 * banner parsed back out of the text the impl model actually read, and the
 * project's `package.json` AS IT WAS at the instant of the lookup.
 *
 * ── WHAT A COUNT FROM HERE MEANS ────────────────────────────────────────────
 * ONE project. mx5 run 20 made 120 docs lookups; IAR1 is CMake, has no npm
 * manifest, and made zero. Every rate off this corpus is npm-shaped and
 * single-project. A cache HIT writes no entry (`details.hitCache`), so every
 * count is a LOWER BOUND on the lookups the run issued.
 *
 * ── WHY THE LIVE CACHE, NOT THE PINNED SNAPSHOT ─────────────────────────────
 * `research-cache-corpus.ts` prefers `scripts/fixtures/research-cache-corpus.json`.
 * That snapshot holds 149 mx5 docs entries; the live cache holds 120, because
 * per-package invalidation dropped the rest as run 20 installed things. The
 * hand count this channel is calibrated against was taken off the live tree, so
 * this module reads the live tree (`loadLiveCorpus`).
 *
 * ── WHY package.json IS RESOLVED PER ENTRY ──────────────────────────────────
 * A banner is a claim about the dependency tree AT LOOKUP TIME, not today.
 * `sharp` was genuinely undeclared when its banner was written at 22:58 and was
 * declared three hours later at b46cc5a; grading that banner against today's
 * package.json would score a correct sentence as a defect. Every declaration
 * question here is asked of the commit that was HEAD when the entry was written.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {loadLiveCorpus, type Lookup} from './research-cache-corpus.js'
import {extractParentPackage, type AutoInstallPin} from '../src/workers/docs-core.js'
import {splitRuntimeNamespace} from '../src/workers/docs-resolve.js'

export const MX5 = path.join(os.homedir(), 'hub', 'mx5')

export type BannerKind = 'none' | 'declared-range' | 'not-declared'

export interface DocsLookup {
    project: string
    /** Epoch ms the entry was written. */
    at: number
    /** The raw `pkg` argument, as the tool was called (`bun:sql`, `hono/client`). */
    askedRaw: string
    /** Its package root — the name a truthful banner should use. */
    asked: string
    /** The package the SHIPPED banner named: the terminal of the resolution chain. */
    named: string
    kind: BannerKind
    /** The shipped banner, including its trailing blank line. '' when there is none. */
    bannerText: string
    /** The version the answer was grounded in (`details.version`). */
    version: string
    /** The pin as recorded, or undefined — the already-installed, no-banner case. */
    pin?: AutoInstallPin
    query: string
}

const NOT_DECLARED = '[VERSION — verify]'
const DECLARED = '[VERSION]'

/** The leading banner of a docs answer, or '' — everything up to the first blank line. */
export function splitBanner(text: string): {kind: BannerKind; banner: string; named: string} {
    const kind: BannerKind =
        text.startsWith(NOT_DECLARED) ? 'not-declared'
        : text.startsWith(DECLARED) ? 'declared-range'
        : 'none'
    if (kind === 'none') return {kind, banner: '', named: ''}
    const end = text.indexOf('\n\n')
    const banner = end === -1 ? text : text.slice(0, end + 2)
    // Every banner shape quotes the package name it reports on, first.
    const named = banner.split('"')[1] ?? ''
    return {kind, banner, named}
}

function toDocsLookup(l: Lookup): DocsLookup {
    const {kind, banner, named} = splitBanner(l.text)
    const source = l.details.versionSource as AutoInstallPin['source'] | undefined
    const range = l.details.declaredRange as string | undefined
    return {
        project: l.project,
        at: l.at,
        askedRaw: l.subject,
        // Exactly what docsRaw computes as the pin's `asked`: normalise a runtime
        // namespace (`bun:sql` -> `bun`), then take the package root.
        asked: extractParentPackage(splitRuntimeNamespace(l.subject)?.runtime ?? l.subject),
        named,
        kind,
        bannerText: banner,
        version: (l.details.version as string | undefined) ?? '',
        pin: source ? {source, ...(range === undefined ? {} : {range})} : undefined,
        query: l.query
    }
}

/** Every docs lookup in every live research cache, oldest first. */
export function docsLookups(): DocsLookup[] {
    return loadLiveCorpus()
        .filter(l => l.kind === 'docs')
        .map(toDocsLookup)
}

/** One line stating the corpus shape. Print it beside every rate. */
export function corpusLine(rows: DocsLookup[]): string {
    const byProject = new Map<string, number>()
    for (const r of rows) byProject.set(r.project, (byProject.get(r.project) ?? 0) + 1)
    const parts = [...byProject.entries()].map(([p, n]) => `${p} ${n}`).join(', ')
    return (
        `corpus: ${rows.length} docs lookups from the LIVE caches (${parts}). ONE project — `
        + `IAR1 is CMake with no npm manifest and made zero docs lookups, so this channel is `
        + `npm-shaped and single-project. A cache HIT writes no entry, so every count is a `
        + `LOWER BOUND on the lookups run 20 issued.`
    )
}

// ── the tree as it was ───────────────────────────────────────────────────────

const TREES = path.join(os.tmpdir(), 'pi-task-version-banner-trees')

function git(args: string[]): string | null {
    const r = spawnSync('git', ['-C', MX5, ...args], {encoding: 'utf8'})
    return r.status === 0 ? r.stdout : null
}

const shaCache = new Map<number, string | null>()

/** The mx5 commit that was HEAD at `atMs`, or null if the tree predates it. */
export function commitAt(atMs: number): string | null {
    const hit = shaCache.get(atMs)
    if (hit !== undefined) return hit
    const iso = new Date(atMs).toISOString()
    const sha = (git(['rev-list', '-1', `--before=${iso}`, 'HEAD']) ?? '').trim() || null
    shaCache.set(atMs, sha)
    return sha
}

/**
 * A directory holding mx5's `package.json` exactly as it stood at `atMs` — the
 * `cwd` a declaration lookup must be asked about for that entry. Returns a
 * directory with NO package.json when the lookup predates the manifest (the
 * scaffolding task wrote it at 23:13); that is a real state the code must
 * survive, not an error. Read-only with respect to the evidence tree: `git show`
 * only, never a checkout.
 */
export function treeAt(atMs: number): string {
    const sha = commitAt(atMs)
    const dir = path.join(TREES, sha ?? 'pre-history')
    if (fs.existsSync(dir)) return dir
    fs.mkdirSync(dir, {recursive: true})
    const json = sha === null ? null : git(['show', `${sha}:package.json`])
    if (json !== null) fs.writeFileSync(path.join(dir, 'package.json'), json, 'utf8')
    return dir
}

/** Every dependency map of a tree's package.json, flattened. Empty when absent. */
export function declaredMap(dir: string): Record<string, string> {
    let json: Record<string, unknown>
    try {
        json = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<
            string,
            unknown
        >
    } catch {
        return {}
    }
    const out: Record<string, string> = {}
    for (const field of [
        'dependencies',
        'devDependencies',
        'peerDependencies',
        'optionalDependencies'
    ]) {
        const map = json[field]
        if (!map || typeof map !== 'object') continue
        for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
            if (typeof v === 'string' && !(k in out)) out[k] = v
        }
    }
    return out
}
