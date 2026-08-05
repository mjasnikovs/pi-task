/**
 * STEP 0 for nexttask 3 — how often the resolved-body narrowing rules would fire
 * on real manifest edits, measured BEFORE the guard is wired.
 *
 * VERDICT (2026-08-05): the rules are safe to wire. Over 274 manifest-touching
 * commits in ~/hub/* only 26 change a discovered command's body at all, and
 * exactly 3 of those classify as `narrow` (1.1% of commits, 11.5% of body
 * changes) — every one read by hand and confirmed a real scope reduction:
 *
 *   mx5@dfbdd6f       `AGENT=1 bun test` → `… ./test`         THE LEAD
 *   gofer@fc252ea     `scripts/*.test.mjs` → 4 of the 5 files that glob matched
 *                     (drops scripts/godot-acceptance.test.mjs)
 *   aiz-client@78ad0a3 `eslint .` → `eslint --fix --quiet src`
 *
 * Two hand-reads corrected the rules before the A/B, and both corrections are
 * pinned by tests:
 *
 *   mx5@a9c6145       `bun test` gains `--path-ignore-patterns '**\/*.spec.tsx'`
 *                     AND the body gains `playwright test -c
 *                     playwright-ct.config.ts` — which was ALREADY the body of
 *                     the discovered command `bun run test:ct`. The excluded
 *                     specs never left the gate's coverage, so this is a
 *                     relocation, not a shrink → the RELOCATION EXCUSE
 *                     (command-shrink.ts, excusedByRelocation).
 *   dace-pro@45b6fa0  `eslint --fix src` → `eslint --fix src tests` is a
 *                     WIDENING that the first cut read as `path-added`, because
 *                     "first non-flag token is the verb" swallowed `src`. The
 *                     verb slot is positional now.
 *
 * The `widen` (1) and `neutral` (22) counts are reported too, along with two
 * non-deciding observations — chain members removed (8) and added (21). A
 * removed chain member (`eslint . && tsc --noEmit` → `eslint .`) is a scope
 * change none of the four pre-registered rules cover; it is counted here so the
 * next lead has a number, and deliberately never rejected on.
 *
 * The lead (mx5 run 19): the final-gate autofix rewrote `"test": "AGENT=1 bun
 * test"` to `"AGENT=1 bun test ./test"`, the shrink guard compared command
 * LABELS (`bun run test` before and after), saw no difference, and the gate
 * re-ran a suite that no longer covered the repository — then reported
 * "autofix converged". The proposed fix compares resolved BODIES.
 *
 * The pre-registered risk is false positives: every `narrow` verdict becomes a
 * REJECTED fix attempt in production, so the rule has to be silent on ordinary
 * manifest edits. Two corpora, both replayed through the shipped discovery
 * (`discoverGateCommandBodies`) so the guard and this harness cannot drift:
 *
 *   FIX corpus    every recorded autofix / lint-fix commit across ~/hub/*.
 *                 This is where a `narrow` is EXPECTED (the lead itself).
 *   WIDE corpus   every commit in those repos that touches a package.json or a
 *                 Makefile, agent- and human-authored alike. This is the false
 *                 positive denominator: the rules must be near-silent here, and
 *                 every hit has to be readable by hand as a real narrowing.
 *
 * Each commit is replayed per manifest DIRECTORY: the manifests are materialized
 * from the parent and child blobs into two temp dirs, discovery runs over both,
 * and every label present on both sides is classified. Rule 4's provenance
 * (`createdByFix`) is the commit's own added-file list.
 *
 * Read-only over the corpus: nothing is checked out, no repo is written to.
 *
 * Run: bun run scripts/command-shrink-baserate.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {discoverGateCommandBodies} from '../src/task/final-gate.js'
import {classifyBodyChange, type BodyChange} from '../src/task/command-shrink.js'

const HUB = path.join(os.homedir(), 'hub')
/** The commit that produced the lead — must classify as a narrowing of `test`. */
const LEAD = {repo: 'mx5', sha: 'dfbdd6f'}

const MANIFESTS = ['package.json', 'Makefile']

function git(repo: string, args: string[]): string {
    return execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        // A missing blob / a root commit is an ordinary answer here, not an
        // error to print: `git show <sha>:Makefile` fatals on every repo that
        // has no Makefile. gitOrNull turns it into null.
        stdio: ['ignore', 'pipe', 'ignore']
    })
}

function gitOrNull(repo: string, args: string[]): string | null {
    try {
        return git(repo, args)
    } catch {
        return null
    }
}

function repos(): string[] {
    if (!fs.existsSync(HUB)) return []
    return fs
        .readdirSync(HUB)
        .map(n => path.join(HUB, n))
        .filter(d => fs.existsSync(path.join(d, '.git')))
        .sort()
}

/** Commits whose message marks them as a machine fix pass. */
function fixCommits(repo: string): string[] {
    const out = gitOrNull(repo, [
        'log',
        '--all',
        '--format=%H',
        '-i',
        '--grep=FINAL GATE AUTOFIX',
        '--grep=lint-fix',
        '--grep=autofix'
    ])
    return (out ?? '').split('\n').filter(Boolean)
}

/** Every commit touching a manifest anywhere in the tree. */
function manifestCommits(repo: string): string[] {
    const out = gitOrNull(repo, [
        'log',
        '--all',
        '--format=%H',
        '--',
        ...MANIFESTS.flatMap(m => [m, `**/${m}`])
    ])
    return (out ?? '').split('\n').filter(Boolean)
}

/** Manifest paths this commit changed, and every path it ADDED. */
function commitTouch(repo: string, sha: string): {manifests: string[]; added: Set<string>} {
    const names = gitOrNull(repo, [
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-m',
        '--first-parent',
        sha
    ])
    const manifests = new Set<string>()
    const added = new Set<string>()
    for (const line of (names ?? '').split('\n')) {
        const [status, file] = line.split('\t')
        if (!file) continue
        if (status?.startsWith('A')) added.add(file)
        if (MANIFESTS.includes(path.posix.basename(file))) manifests.add(file)
    }
    return {manifests: [...manifests], added}
}

function blob(repo: string, sha: string, file: string): string | null {
    return gitOrNull(repo, ['show', `${sha}:${file}`])
}

/** Materialize a directory's manifests at one revision into a temp dir. */
function materialize(repo: string, sha: string, dir: string, root: string): string {
    fs.mkdirSync(root, {recursive: true})
    for (const m of MANIFESTS) {
        const file = dir === '.' ? m : path.posix.join(dir, m)
        const text = blob(repo, sha, file)
        if (text !== null) fs.writeFileSync(path.join(root, m), text)
    }
    return root
}

interface Hit {
    repo: string
    sha: string
    dir: string
    label: string
    before: string
    after: string
    change: BodyChange
}

interface Tally {
    commits: number
    compared: number
    narrow: number
    widen: number
    neutral: number
    memberRemoved: number
    memberAdded: number
    hits: Hit[]
    widenHits: Hit[]
}

function emptyTally(): Tally {
    return {
        commits: 0,
        compared: 0,
        narrow: 0,
        widen: 0,
        neutral: 0,
        memberRemoved: 0,
        memberAdded: 0,
        hits: [],
        widenHits: []
    }
}

function replayCommit(repo: string, sha: string, tmp: string, tally: Tally): void {
    const parent = gitOrNull(repo, ['rev-parse', `${sha}^`])?.trim()
    if (!parent) return // root commit: nothing to compare against
    const {manifests, added} = commitTouch(repo, sha)
    if (manifests.length === 0) return
    tally.commits++
    const dirs = [...new Set(manifests.map(m => path.posix.dirname(m)))]
    const createdByFix = (p: string) => {
        const norm = p.replace(/^\.\//, '')
        return [...added].some(a => a === norm || path.posix.basename(a) === norm)
    }
    for (const dir of dirs) {
        const beforeDir = materialize(repo, parent, dir, path.join(tmp, 'before'))
        const afterDir = materialize(repo, sha, dir, path.join(tmp, 'after'))
        const before = discoverGateCommandBodies(beforeDir)
        const after = discoverGateCommandBodies(afterDir)
        for (const [label, body] of Object.entries(before)) {
            const now = after[label]
            if (now === undefined || now === body) continue
            tally.compared++
            const siblingBodies = Object.entries(after)
                .filter(([l]) => l !== label)
                .map(([, b]) => b)
            const change = classifyBodyChange(body, now, {createdByFix, siblingBodies})
            tally.memberRemoved += change.notes.filter(n => n.startsWith('member-removed')).length
            tally.memberAdded += change.notes.filter(n => n.startsWith('member-added')).length
            const hit: Hit = {repo: path.basename(repo), sha: sha.slice(0, 7), dir, label, before: body, after: now, change}
            if (change.cls === 'narrow') {
                tally.narrow++
                tally.hits.push(hit)
            } else if (change.cls === 'widen') {
                tally.widen++
                tally.widenHits.push(hit)
            } else {
                tally.neutral++
            }
        }
        fs.rmSync(beforeDir, {recursive: true, force: true})
        fs.rmSync(afterDir, {recursive: true, force: true})
    }
}

function printHits(title: string, hits: Hit[]): void {
    if (hits.length === 0) return
    console.log(`\n${title}`)
    for (const h of hits) {
        console.log(`  ${h.repo}@${h.sha}${h.dir === '.' ? '' : `/${h.dir}`}  ${h.label}`)
        console.log(`      kinds : ${h.change.kinds.join(', ') || '—'}`)
        console.log(`      before: ${h.before}`)
        console.log(`      after : ${h.after}`)
        for (const r of h.change.reasons) console.log(`      why   : ${r}`)
    }
}

function report(name: string, t: Tally): void {
    console.log(`\n═══ ${name} ═══`)
    console.log(`  commits replayed        ${t.commits}`)
    console.log(`  command bodies changed  ${t.compared}`)
    console.log(`  narrow                  ${t.narrow}`)
    console.log(`  widen                   ${t.widen}`)
    console.log(`  neutral                 ${t.neutral}`)
    console.log(`  (obs) chain member removed / added   ${t.memberRemoved} / ${t.memberAdded}`)
}

function main(): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-shrink-'))
    const fix = emptyTally()
    const wide = emptyTally()
    const all = repos()
    if (all.length === 0) {
        console.log('ABSTAIN — no corpus repos under ~/hub')
        process.exit(2)
    }
    console.log(`corpus: ${all.map(r => path.basename(r)).join(', ')}`)

    for (const repo of all) {
        for (const sha of fixCommits(repo)) replayCommit(repo, sha, tmp, fix)
        for (const sha of manifestCommits(repo)) replayCommit(repo, sha, tmp, wide)
    }
    fs.rmSync(tmp, {recursive: true, force: true})

    report('FIX corpus (autofix / lint-fix commits)', fix)
    printHits('NARROW hits — every one must be a real narrowing:', fix.hits)
    printHits('WIDEN hits (never rejected; listed for the record):', fix.widenHits)

    report('WIDE corpus (every manifest-touching commit)', wide)
    printHits('NARROW hits — the false-positive read:', wide.hits)

    const leadHit = fix.hits.find(h => h.repo === LEAD.repo && h.sha === LEAD.sha)
    console.log(
        `\nLEAD ${LEAD.repo}@${LEAD.sha} — ${
            leadHit ?
                `classified NARROW on \`${leadHit.label}\` (${leadHit.change.kinds.join(', ')})`
            :   'NOT classified as a narrowing — the rules miss the case they were built for'
        }`
    )
    if (!leadHit) process.exit(1)
}

main()
