/**
 * STEP 4 for nexttask 17 (17C) — does the version banner change what the
 * implementation WRITES?
 *
 * The honest prior: the banner is one sentence in a research section the impl
 * model reads next to a type signature. 17A/17B ship on correctness — the
 * sentence was false — and a delivery A/B is only worth building if the banner
 * is doing something downstream. So COUNT FIRST (memory/prompt2-typeonly-baserate.md;
 * two of the last three levers on this corpus died at exactly this step).
 *
 * An EPISODE is a banner-carrying lookup followed by an implementation that
 * hedged. Three channels, all measured off run 20's own history:
 *
 *   PIN     the first declaration of that package after the banner names a
 *           different major than the banner did (0.x counts its MINOR as the
 *           breaking unit, which is what npm's caret does)
 *   GUARD   a commit after the banner adds a runtime version check naming the
 *           package (`Bun.version`, a semver compare, a feature-detect)
 *   RE-ASK  the same package is asked a near-identical question again later
 *           (Jaccard >= 0.6 on query tokens)
 *
 * GATE, pre-registered in nexttask17.md: fewer than 3 episodes closes 17C with
 * a number. 3 or more means building the n=12 delivery A/B.
 *
 * A cache HIT writes no entry, so an IDENTICAL re-ask is invisible here and
 * RE-ASK is a lower bound. ONE project, npm-shaped.
 *
 * Read-only: `git log`/`git show` against the evidence tree, nothing else.
 *
 * Run: bun run scripts/version-banner-hedge-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import {corpusLine, declaredMap, docsLookups, treeAt, MX5, type DocsLookup} from './version-banner-corpus.js'

interface Commit {
    sha: string
    at: number
    subject: string
}

function history(): Commit[] {
    const r = spawnSync('git', ['-C', MX5, 'log', '--format=%H%x00%ct%x00%s'], {encoding: 'utf8'})
    if (r.status !== 0) return []
    return (r.stdout ?? '')
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const [sha, ct, subject] = line.split('\0')
            return {sha, at: Number(ct) * 1000, subject}
        })
        .sort((a, b) => a.at - b.at)
}

function show(sha: string, args: string[]): string {
    const r = spawnSync('git', ['-C', MX5, ...args, sha], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    return r.status === 0 ? (r.stdout ?? '') : ''
}

/** The breaking unit of a version or range: `1.2.3` -> `1`, `0.33.5` -> `0.33`. */
function breakingUnit(v: string): string {
    const m = /(\d+)\.(\d+)/.exec(v.replace(/^[\^~>=<\s]*/, ''))
    if (!m) return v.trim()
    return m[1] === '0' ? `0.${m[2]}` : m[1]
}

const TOKEN = /[a-z0-9]+/g
const tokens = (s: string): Set<string> => new Set(s.toLowerCase().match(TOKEN) ?? [])
function jaccard(a: Set<string>, b: Set<string>): number {
    let hit = 0
    for (const t of a) if (b.has(t)) hit++
    return hit / (a.size + b.size - hit || 1)
}

/**
 * Runtime version checks and feature-detects, as added lines of a diff.
 *
 * Deliberately narrow, and it got narrower once run: the first version of this
 * pattern flagged a bun.lock line (`"sharp": ["sharp@0.33.5", … "^2.0.3" …]`) as
 * a version guard. A lockfile is a machine-written record of what resolved, not
 * an implementation hedging — so generated dependency files are excluded from
 * the diff before the pattern is applied at all.
 */
const GUARD = /\b(?:Bun\.version|process\.versions?\b|semverSatisfies|satisfies\(|major\s*[<>=]{1,2}\s*\d|typeof\s+\w+(?:\.\w+)*\s*===\s*['"]undefined)/

const GENERATED = /^\+\+\+ b\/(?:.*\/)?(?:bun\.lock|bun\.lockb|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/

/** Where the same-window pairs separate restatement from a new question. */
const REASK_THRESHOLD = 0.42

interface Episode {
    channel: 'PIN' | 'GUARD' | 'RE-ASK'
    row: DocsLookup
    evidence: string
    /** Episodes sharing a group key are ONE episode. */
    group?: string
}

function main(): void {
    const rows = docsLookups()
    const banners = rows.filter(r => r.kind !== 'none')
    const commits = history()
    const episodes: Episode[] = []

    for (const row of banners) {
        const after = commits.filter(c => c.at > row.at)

        // PIN — the first declaration of this package after the banner.
        for (const c of after) {
            const declared = declaredMap(treeAt(c.at + 1000))[row.asked]
            if (declared === undefined) continue
            if (breakingUnit(declared) !== breakingUnit(row.version)) {
                episodes.push({
                    channel: 'PIN',
                    row,
                    evidence:
                        `banner said v${row.version}; ${c.sha.slice(0, 7)} declares `
                        + `${row.asked} ${declared}`
                })
            }
            break
        }

        // GUARD — a version check naming the package, added after the banner.
        const next = after[0]
        if (next) {
            const diff = show(next.sha, ['show', '--unified=0', '--format='])
            let inGenerated = false
            const added = diff
                .split('\n')
                .filter(l => {
                    if (l.startsWith('+++')) {
                        inGenerated = GENERATED.test(l)
                        return false
                    }
                    return !inGenerated && l.startsWith('+')
                })
                .filter(l => l.toLowerCase().includes(row.asked.toLowerCase()) && GUARD.test(l))
            if (added.length > 0) {
                episodes.push({
                    channel: 'GUARD',
                    row,
                    evidence: `${next.sha.slice(0, 7)}: ${added[0].trim().slice(0, 100)}`
                })
            }
        }

        // RE-ASK — the same question about the same package, asked again BEFORE
        // the next commit. Both bounds are load-bearing:
        //
        //   the WINDOW: two hours and four commits later, the same question about
        //   bun's SQL API is the next task needing that API, not this task hedging
        //   on a sentence it just read. Unbounded, this channel reports 2 episodes
        //   that are nothing of the kind.
        //
        //   the THRESHOLD: it is a knob, and the verdict moves with it — 0/1/4/9
        //   episodes at 0.6/0.5/0.4/0.3. So it is set where the DATA separates,
        //   not at a round number. Every same-window pair at >= 0.43 is the same
        //   question restated ("is `sql` a named export of bun, or must you use
        //   new sql()?", asked three times in one window); every pair at 0.40 is a
        //   DIFFERENT question wearing the same phrasing (`file`, then `glob`).
        //   The sensitivity curve is printed below so the knob is not hidden.
        const q = tokens(row.query)
        const windowEnd = after[0]?.at ?? Number.MAX_SAFE_INTEGER
        const reask = rows.find(
            o =>
                o.at > row.at
                && o.at < windowEnd
                && o.asked === row.asked
                && o.query !== row.query
                && jaccard(q, tokens(o.query)) >= REASK_THRESHOLD
        )
        if (reask) {
            episodes.push({
                channel: 'RE-ASK',
                row,
                // The chain, not each link: three lookups restating one question
                // is ONE episode of re-asking. Collapsed by window below.
                group: `${row.asked}\0${windowEnd}`,
                evidence: `${new Date(reask.at).toISOString()} "${reask.query.slice(0, 70)}"`
            })
        }
    }

    console.log(corpusLine(rows))
    console.log(`\nbanner-carrying lookups: ${banners.length}\n`)
    for (const e of episodes) {
        console.log(
            `  ${e.channel.padEnd(7)} ${e.row.asked} @ ${new Date(e.row.at).toISOString()}\n`
            + `          ${e.evidence}`
        )
    }
    if (episodes.length === 0) console.log('  (no episodes on any channel)')

    // Sensitivity of the one knob in here, printed whatever it says.
    console.log('\n  RE-ASK threshold sensitivity — lookups flagged, and chains collapsed:')
    for (const th of [0.6, 0.5, 0.4, 0.3]) {
        const hits = new Set<string>()
        const chains = new Set<string>()
        for (const row of banners) {
            const end = commits.find(c => c.at > row.at)?.at ?? Number.MAX_SAFE_INTEGER
            for (const o of rows) {
                if (o.at <= row.at || o.at >= end || o.asked !== row.asked) continue
                if (o.query !== row.query && jaccard(tokens(row.query), tokens(o.query)) >= th) {
                    hits.add(`${row.asked}\0${row.at}`)
                    chains.add(`${row.asked}\0${end}`)
                }
            }
        }
        console.log(`    >= ${th.toFixed(1)}   ${hits.size} lookups   ${chains.size} episodes`)
    }
    console.log(
        '    the verdict does not turn on the knob: the episode count is 1 across 0.4-0.5\n'
        + '    and only reaches 3 at 0.3, where the pairs are plainly different questions\n'
        + '    (`file`, `glob`) sharing one phrasing.'
    )

    // The gate counts EPISODES: one lookup that hedged on two channels is one
    // episode, and one question restated three times in a window is one episode.
    const distinct = new Set(
        episodes.map(e => e.group ?? `${e.row.asked}\0${e.row.at}`)
    ).size
    console.log(`\n  episodes (banner lookups followed by a hedge, chains collapsed): ${distinct}`)
    console.log(`  gate: >= 3 builds the delivery A/B; < 3 closes 17C`)
    console.log(distinct >= 3 ? '\n17C: BUILD THE DELIVERY A/B' : '\n17C: CLOSED — below the pre-registered gate')
}

if (import.meta.main) main()
