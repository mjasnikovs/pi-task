/**
 * 14 STEP 2 — how much fetch work in the corpus is WASTED, and is there a lead the runs
 * are leaving on the floor?
 *
 * Read-only. No model, no network. Everything here comes out of the three research caches
 * plus, for mx5 only, its installed node_modules.
 *
 * ── WHAT THE NUMBERS DO AND DO NOT MEAN ─────────────────────────────────────────────────
 * Three projects and mx5 is dominant. A cache HIT writes no entry, so every count is a
 * LOWER BOUND on the lookups the runs issued. `rank1_is_official_docs` needs a project's
 * installed package.json to know what "official" means for a package, and only mx5 has
 * node_modules on this box — that number is a one-project number and says so.
 *
 * ── CALIBRATION, checked before any number below is believed ────────────────────────────
 * The script must reproduce the mx5 hand-count exactly: 33 fetches, 9 coverage misses, 5
 * unverified excerpts, 2 of 2 blob misses, 8 searches, 1 rank-1-official-not-fetched. It
 * exits non-zero if it does not, because a walker that miscounts is worse than no walker.
 *
 * Run: bun run scripts/fetch-lead-quality-baserate.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {normaliseSourceUrl} from '../src/workers/fetch-core.js'
import {classifyQuery} from './apis-trajectory.js'
import {
    loadCorpus,
    corpusCaveat,
    parseSearchResults,
    isNonAnswer,
    type Lookup,
    type SearchResult
} from './research-cache-corpus.js'

/** A search and the fetches that followed it before the next search. */
const EPISODE_WINDOW_MS = 120_000

export interface Episode {
    project: string
    at: number
    query: string
    results: SearchResult[]
    fetches: Lookup[]
}

export function buildEpisodes(lookups: Lookup[]): Episode[] {
    const out: Episode[] = []
    const byProject = new Map<string, Lookup[]>()
    for (const l of lookups) {
        if (l.kind === 'docs') continue
        ;(byProject.get(l.project) ?? byProject.set(l.project, []).get(l.project)!).push(l)
    }
    for (const [project, ls] of byProject) {
        const ordered = [...ls].sort((a, b) => a.at - b.at)
        for (const [i, l] of ordered.entries()) {
            if (l.kind !== 'search') continue
            const fetches: Lookup[] = []
            for (let j = i + 1; j < ordered.length; j++) {
                const n = ordered[j]
                if (n.kind === 'search') break // an intervening search ends the episode
                if (n.at - l.at > EPISODE_WINDOW_MS) break
                fetches.push(n)
            }
            out.push({
                project,
                at: l.at,
                query: l.query,
                results: parseSearchResults(l.text),
                fetches
            })
        }
    }
    return out.sort((a, b) => a.at - b.at)
}

// ── host classes ─────────────────────────────────────────────────────────────────────────

export type HostClass = 'official-docs' | 'raw-source' | 'issue-tracker' | 'forum' | 'blog'

const FORUM_HOSTS = /(?:^|\.)(?:reddit\.com|stackoverflow\.com|stackexchange\.com|news\.ycombinator\.com|discourse\.[^.]+\..+)$/i
const BLOG_HOSTS = /(?:^|\.)(?:medium\.com|dev\.to|hashnode\.[^.]+|substack\.com|blogspot\.com|wordpress\.com)$/i

/**
 * `official-docs` here means "not one of the other four" — a residual class, NOT a claim
 * that the host is the package's own site. The one place that stronger claim is needed
 * (rank1_is_official_docs) checks the installed package.json instead, below.
 */
export function hostClass(url: string): HostClass {
    let h: string
    let p: string
    try {
        const u = new URL(url)
        h = u.hostname.toLowerCase()
        p = u.pathname
    } catch {
        return 'blog'
    }
    if (h === 'raw.githubusercontent.com' || h === 'gist.githubusercontent.com') return 'raw-source'
    if (h.endsWith('github.com') || h.endsWith('gitlab.com')) {
        if (/\/(?:issues|pull|discussions)\b/.test(p)) return 'issue-tracker'
        if (/\/blob\//.test(p)) return 'raw-source'
        return 'issue-tracker'
    }
    if (FORUM_HOSTS.test(h)) return 'forum'
    if (BLOG_HOSTS.test(h) || /\/blog\//.test(p)) return 'blog'
    return 'official-docs'
}

// ── "official" as the package itself declares it ─────────────────────────────────────────

export interface PackageHosts {
    /** package name -> hosts from its installed homepage/repository. */
    hosts: Map<string, Set<string>>
    /** false when the project has no node_modules on this box — the number is then blind. */
    available: boolean
}

function hostOf(u: string | undefined): string | undefined {
    if (!u) return undefined
    const cleaned = u.replace(/^git\+/, '').replace(/^github:/, 'https://github.com/')
    try {
        return new URL(cleaned).hostname.toLowerCase()
    } catch {
        return undefined
    }
}

export function loadPackageHosts(projectRoot: string): PackageHosts {
    const nm = path.join(projectRoot, 'node_modules')
    const hosts = new Map<string, Set<string>>()
    if (!fs.existsSync(nm)) return {hosts, available: false}
    const dirs: string[] = []
    for (const e of fs.readdirSync(nm, {withFileTypes: true})) {
        if (!e.isDirectory()) continue
        if (e.name.startsWith('.')) continue
        if (e.name.startsWith('@')) {
            for (const s of fs.readdirSync(path.join(nm, e.name), {withFileTypes: true})) {
                if (s.isDirectory()) dirs.push(path.join(e.name, s.name))
            }
        } else dirs.push(e.name)
    }
    for (const d of dirs) {
        let pkg: {name?: string; homepage?: string; repository?: unknown}
        try {
            pkg = JSON.parse(fs.readFileSync(path.join(nm, d, 'package.json'), 'utf8')) as typeof pkg
        } catch {
            continue
        }
        const repo = pkg.repository
        const repoUrl =
            typeof repo === 'string' ? repo
            : repo && typeof repo === 'object' ? (repo as {url?: string}).url
            : undefined
        const set = new Set<string>()
        for (const h of [hostOf(pkg.homepage), hostOf(repoUrl)]) if (h) set.add(h)
        if (set.size > 0) hosts.set(pkg.name ?? d, set)
    }
    return {hosts, available: true}
}

/**
 * Every installed package a search query names, at a word boundary.
 *
 * NOT "the one package the query is about". A real query names several — mx5's hono query is
 * "hono rpc client typescript 6.0 …", and picking the longest name made it a TYPESCRIPT
 * query, so hono.dev at rank 1 scored as not-official and the hand-counted episode
 * disappeared. The question being asked is "is rank 1 the official site of something this
 * query is about", and any named package answers it.
 */
export function packagesOfQuery(query: string, hosts: Map<string, Set<string>>): string[] {
    const q = query.toLowerCase()
    const out: string[] = []
    for (const name of hosts.keys()) {
        const n = name.toLowerCase()
        if (n.length < 3) continue
        const re = new RegExp(`(?:^|[^a-z0-9@/-])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9-])`)
        if (re.test(q)) out.push(name)
    }
    return out
}

// ── behaviour questions and how they were answered ───────────────────────────────────────

/**
 * A docs answer that is only a type signature: it carries a declaration for something, and
 * no sentence that says what a value MEANS. Deliberately the same cue set the query
 * classifier uses (BEHAVIOUR_CUES via classifyQuery), applied to the ANSWER — so "the
 * question was behavioural and the answer never became behavioural" is one predicate used
 * twice, not two predicates that could disagree by construction.
 */
export function answeredBySignatureOnly(text: string): boolean {
    const body = text.replace(/^\[VERSION[^\n]*\n/, '')
    const hasDeclaration = /\b(?:declare|=>|\):\s|interface\s|type\s+\w+\s*=|function\s)/.test(body)
    if (!hasDeclaration) return false
    return classifyQuery(body) !== 'behaviour'
}

// ── report ───────────────────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
    return d === 0 ? 'n/a (0 denominator)' : `${n}/${d} = ${((100 * n) / d).toFixed(1)}%`
}

export interface BaseRate {
    totalFetches: number
    coverageMiss: number
    unverifiedExcerpt: number
    nonAnswer: number
    wastedFetches: number
    blobFetches: number
    blobMisses: number
    searches: number
    rank1Official: number
    rank1OfficialNotFetched: number
    rank1OfficialNotFetchedEpisodes: Episode[]
    behaviourQuestions: number
    behaviourAnsweredBySignature: number
    byClass: Map<HostClass, {fetches: number; miss: number}>
}

export function compute(lookups: Lookup[], projects: string[]): BaseRate {
    const fetches = lookups.filter(l => l.kind === 'fetch')
    const episodes = buildEpisodes(lookups)

    const byClass = new Map<HostClass, {fetches: number; miss: number}>()
    for (const f of fetches) {
        const c = hostClass(f.subject)
        const slot = byClass.get(c) ?? {fetches: 0, miss: 0}
        slot.fetches++
        if (isNonAnswer(f.details)) slot.miss++
        byClass.set(c, slot)
    }

    // A wasted fetch: it yielded nothing, and the SAME episode later got an answer from a
    // different URL — so the work was spent and the episode did not need it.
    let wasted = 0
    for (const ep of episodes) {
        for (const [i, f] of ep.fetches.entries()) {
            if (!isNonAnswer(f.details)) continue
            if (ep.fetches.slice(i + 1).some(n => !isNonAnswer(n.details))) wasted++
        }
    }

    // rank-1 official: only projects whose node_modules is on this box can answer it.
    let rank1Official = 0
    let rank1NotFetched = 0
    const notFetched: Episode[] = []
    for (const project of projects) {
        const {hosts, available} = loadPackageHosts(`${process.env.HOME}/hub/${project}`)
        if (!available) continue
        for (const ep of episodes.filter(e => e.project === project)) {
            const r1 = ep.results.find(r => r.rank === 1)
            if (!r1) continue
            const pkgs = packagesOfQuery(ep.query, hosts)
            if (pkgs.length === 0) continue
            let h: string
            try {
                h = new URL(r1.url).hostname.toLowerCase()
            } catch {
                continue
            }
            const official = pkgs.some(p =>
                [...hosts.get(p)!].some(x => h === x || h.endsWith(`.${x}`))
            )
            if (!official) continue
            rank1Official++
            const fetched = ep.fetches.some(
                f => normaliseSourceUrl(f.subject) === normaliseSourceUrl(r1.url)
            )
            if (!fetched) {
                rank1NotFetched++
                notFetched.push(ep)
            }
        }
    }

    const docs = lookups.filter(l => l.kind === 'docs')
    const behaviour = docs.filter(l => classifyQuery(l.query) === 'behaviour')

    const blob = fetches.filter(f => normaliseSourceUrl(f.subject) !== f.subject)
    return {
        totalFetches: fetches.length,
        coverageMiss: fetches.filter(f => f.details.coverageMiss === true).length,
        unverifiedExcerpt: fetches.filter(f => f.details.excerptVerified === false).length,
        nonAnswer: fetches.filter(f => isNonAnswer(f.details)).length,
        wastedFetches: wasted,
        blobFetches: blob.length,
        blobMisses: blob.filter(f => isNonAnswer(f.details)).length,
        searches: lookups.filter(l => l.kind === 'search').length,
        rank1Official,
        rank1OfficialNotFetched: rank1NotFetched,
        rank1OfficialNotFetchedEpisodes: notFetched,
        behaviourQuestions: behaviour.length,
        behaviourAnsweredBySignature: behaviour.filter(l => answeredBySignatureOnly(l.text)).length,
        byClass
    }
}

function main(): void {
    const all = loadCorpus()
    const projects = [...new Set(all.map(l => l.project))]

    // ── calibration against the mx5 hand-count, before anything else is printed ───────────
    const mx5 = compute(
        all.filter(l => l.project === 'mx5'),
        ['mx5']
    )
    const expected: Array<[string, number, number]> = [
        ['fetches', mx5.totalFetches, 33],
        ['coverage misses', mx5.coverageMiss, 9],
        ['unverified excerpts', mx5.unverifiedExcerpt, 5],
        ['blob fetches', mx5.blobFetches, 2],
        ['blob misses', mx5.blobMisses, 2],
        ['searches', mx5.searches, 8],
        ['rank-1 official not fetched', mx5.rank1OfficialNotFetched, 1]
    ]
    const bad = expected.filter(([, got, want]) => got !== want)
    console.log('CALIBRATION against the mx5 hand-count:')
    for (const [label, got, want] of expected) {
        console.log(`  ${got === want ? 'ok  ' : 'WRONG'} ${label}: ${got} (hand-count ${want})`)
    }
    if (bad.length > 0) {
        console.error(
            `\nREFUSING TO REPORT: the walker disagrees with the hand-count on ${bad.length} of `
                + `${expected.length} numbers. Every rate below would be unbelievable.`
        )
        process.exit(1)
    }

    const r = compute(all, projects)
    console.log(`\n${corpusCaveat(all)}\n`)
    console.log(`total_fetches                    ${r.totalFetches}`)
    console.log(`coverage_miss_rate               ${pct(r.coverageMiss, r.totalFetches)}`)
    console.log(
        `non_answer_rate                  ${pct(r.nonAnswer, r.totalFetches)}  `
            + `(coverage miss + "unclear" + empty; IAR1 predates the coverage channel)`
    )
    console.log(`  by host class (non-answer):`)
    for (const [c, v] of [...r.byClass.entries()].sort((a, b) => b[1].fetches - a[1].fetches)) {
        console.log(`    ${c.padEnd(15)} ${pct(v.miss, v.fetches)}`)
    }
    console.log(`unverified_excerpts              ${pct(r.unverifiedExcerpt, r.totalFetches)}`)
    console.log(
        `wasted_fetches                   ${pct(r.wastedFetches, r.totalFetches)}  `
            + `(yielded nothing AND the same episode later succeeded on another URL)`
    )
    const blind = projects
        .map(p => ({p, root: `${process.env.HOME}/hub/${p}`}))
        .filter(x => !loadPackageHosts(x.root).available)
        .map(x =>
            fs.existsSync(path.join(x.root, 'package.json')) ?
                `${x.p} (npm project, node_modules not installed here)`
            :   `${x.p} (no package.json — not an npm project, so "official" has no manifest to read)`
        )
    const measurable = loadCorpus().filter(
        l => l.kind === 'search' && !blind.some(b => b.startsWith(l.project))
    ).length
    console.log(
        `rank1_is_official_docs           ${r.rank1Official} of ${measurable} MEASURABLE searches `
            + `(of ${r.searches} total)`
    )
    for (const b of blind) console.log(`    BLIND: ${b}`)
    console.log(`rank1_official_not_fetched       ${r.rank1OfficialNotFetched} distinct episodes`)
    for (const ep of r.rank1OfficialNotFetchedEpisodes) {
        console.log(`    ${ep.project}  "${ep.query.slice(0, 76)}"`)
        console.log(`      rank 1: ${ep.results.find(x => x.rank === 1)?.url}`)
        console.log(`      fetched instead: ${ep.fetches.map(f => f.subject).join('\n                       ')}`)
    }
    console.log(`behaviour_questions              ${r.behaviourQuestions} of ${
        loadCorpus().filter(l => l.kind === 'docs').length
    } docs queries`)
    console.log(
        `behaviour_answered_by_signature  ${pct(r.behaviourAnsweredBySignature, r.behaviourQuestions)}`
    )

    // ── the STEP 2 branch ────────────────────────────────────────────────────────────────
    const wastedRate = r.totalFetches === 0 ? 0 : r.wastedFetches / r.totalFetches
    console.log(
        `\nSTEP 2 BRANCH  wasted_fetches / total_fetches = ${wastedRate.toFixed(3)} `
            + `${wastedRate >= 0.1 ? '>= 0.10 -> build 14B (STEP 3)' : '< 0.10 -> 14B is CLOSED'}`
    )
    const sigRate =
        r.behaviourQuestions === 0 ? 0 : r.behaviourAnsweredBySignature / r.behaviourQuestions
    const issueMiss = r.byClass.get('issue-tracker')
    const forumMiss = r.byClass.get('forum')
    const docsMiss = r.byClass.get('official-docs')
    const rate = (v?: {fetches: number; miss: number}): number =>
        !v || v.fetches === 0 ? 0 : v.miss / v.fetches
    const junkHigher = Math.max(rate(issueMiss), rate(forumMiss)) > rate(docsMiss)
    console.log('STEP 4 GATES for 14C:')
    console.log(
        `  behaviour_answered_by_signature ${sigRate.toFixed(3)} ${sigRate >= 0.5 ? '>= 0.5 alive' : '< 0.5 CLOSES 14C'}`
    )
    console.log(
        `  rank1_official_not_fetched ${r.rank1OfficialNotFetched} `
            + `${r.rank1OfficialNotFetched >= 5 ? '>= 5 alive' : '< 5 CLOSES 14C'}`
    )
    console.log(
        `  issue-tracker/forum non-answer ${Math.max(rate(issueMiss), rate(forumMiss)).toFixed(3)} vs `
            + `official-docs ${rate(docsMiss).toFixed(3)} ${junkHigher ? 'higher, alive' : 'NOT higher, CLOSES 14C'}`
    )
}

if (import.meta.main) main()
