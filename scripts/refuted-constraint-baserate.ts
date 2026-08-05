/**
 * STEP 0 for nexttask 8 — how often research REFUTES a refine constraint, and
 * whether the closed negation set can be trusted to delete on that signal.
 *
 * Measured BEFORE the pass is wired, over every recorded task file reachable on
 * this machine: `<tree>/.pi-tasks/TASK_*.md` on disk under ~/hub, ~/tmp and
 * ~/.cache, plus every historical version of those files in trees that TRACK
 * `.pi-tasks/` (mx5, gofer-pixel, dace-pro).
 *
 * For each task file the detector is handed exactly what compose is handed — the
 * `## refined prompt` and the `## research` sections — and every
 * (refine constraint line, research refutation bullet, shared token) triple is
 * printed with the pattern that fired, plus the line the drop would produce.
 *
 * The pre-registered risk is a research bullet that mentions a dependency
 * negatively in passing ("no `@node-rs/argon2` here, we use `argon2`") and gets
 * read as a refutation of the wrong token. EVERY hit below is meant to be read by
 * hand; `inv-precision` makes one false drop a FAIL of the task, not a tuning
 * note.
 *
 * Read-only over the corpus: nothing is checked out, no repo is written to.
 *
 * Run: bun run scripts/refuted-constraint-baserate.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {extractSection} from '../src/task/task-parsers.js'
import {
    applyRefutations,
    detectRefutations,
    dropToken,
    extractCapsSection,
    type Refutation
} from '../src/task/refuted-constraint.js'

const ROOTS = [
    path.join(os.homedir(), 'hub'),
    path.join(os.homedir(), 'tmp'),
    path.join(os.homedir(), '.cache')
]
/** The lead: run 19's TASK_0001 must produce the `argon2` hit. */
const LEAD = {repo: 'mx5', id: 'TASK_0001'}

type TaskDoc = {origin: string; body: string}

function git(repo: string, args: string[]): string {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        })
    } catch {
        return ''
    }
}

/** Depth-limited walk for `<tree>/.pi-tasks/TASK_*.md`. */
function findTaskDirs(root: string, depth = 4): string[] {
    const out: string[] = []
    const walk = (dir: string, d: number) => {
        if (d < 0) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue
            if (e.name === 'node_modules' || e.name === '.git') continue
            if (e.name === '.pi-tasks') {
                out.push(path.join(dir, e.name))
                continue
            }
            walk(path.join(dir, e.name), d - 1)
        }
    }
    walk(root, depth)
    return out
}

function collect(): TaskDoc[] {
    const docs: TaskDoc[] = []
    const seen = new Set<string>()
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        for (const dir of findTaskDirs(root)) {
            for (const f of fs.readdirSync(dir).filter(n => /^TASK_\d+\.md$/.test(n))) {
                const full = path.join(dir, f)
                const body = fs.readFileSync(full, 'utf8')
                const key = `disk:${full}`
                if (seen.has(key)) continue
                seen.add(key)
                docs.push({origin: full.replace(os.homedir(), '~'), body})
            }
            // Historical versions, where the tree tracks .pi-tasks/.
            const repo = path.dirname(dir)
            const log = git(repo, ['log', '--all', '--format=%H', '--', '.pi-tasks/'])
            for (const sha of log.split('\n').filter(Boolean)) {
                const listing = git(repo, ['ls-tree', '--name-only', `${sha}:.pi-tasks`])
                for (const f of listing.split('\n').filter(n => /^TASK_\d+\.md$/.test(n))) {
                    const body = git(repo, ['show', `${sha}:.pi-tasks/${f}`])
                    if (!body) continue
                    const key = `${path.basename(repo)}:${f}:${hash(body)}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    docs.push({origin: `${path.basename(repo)}@${sha.slice(0, 7)}:${f}`, body})
                }
            }
        }
    }
    return docs
}

function hash(s: string): string {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
    return String(h)
}

function main(): void {
    const docs = collect()
    if (docs.length === 0) {
        console.log('ABSTAIN — no recorded task files found')
        process.exit(2)
    }

    let withBoth = 0
    let hitDocs = 0
    let leadSeen = false
    let leadHit = false
    const byPattern = new Map<string, number>()
    const byToken = new Map<string, number>()
    const hits: {origin: string; r: Refutation; after: string}[] = []
    let wholeLineDrops = 0
    let subsequenceViolations = 0
    let ownedTouched = 0

    /** Loose negation-of-need lexemes, deliberately WIDER than the closed set. */
    const LOOSE =
        /\bnot\s+needed\b|\bnot\s+required\b|\bno\s+need\b|\bunnecessary\b|\bnot\s+a\s+dependency\b|\bno\s+external\b|\bdoes\s+not\s+require\b|\bno\s+longer\s+needed\b/i
    const nearMiss = new Map<string, {n: number; sample: string}>()

    for (const doc of docs) {
        const refined = extractSection(doc.body, 'refined prompt')
        const research = extractSection(doc.body, 'research')
        if (!refined || !research) continue
        if (extractCapsSection(refined, 'CONSTRAINTS') === null) continue
        if (extractCapsSection(research, 'CONTEXT') === null) continue
        withBoth++
        const isLead = doc.origin.includes(LEAD.repo) && doc.origin.includes(LEAD.id)
        if (isLead) leadSeen = true

        const found = detectRefutations(refined, research)
        const fired = new Set(found.map(r => r.research.trim()))
        for (const raw of (extractCapsSection(research, 'CONTEXT') ?? '').split('\n')) {
            const bullet = raw.trim()
            if (!bullet || fired.has(bullet)) continue
            const m = LOOSE.exec(bullet)
            if (!m) continue
            if (!/`@?[a-z0-9][a-z0-9._/-]*`/.test(bullet)) continue
            const key = m[0].toLowerCase().replace(/\s+/g, ' ')
            const prev = nearMiss.get(key)
            if (prev) prev.n++
            else nearMiss.set(key, {n: 1, sample: bullet})
        }
        if (found.length === 0) {
            // inv-noop-when-no-refutation
            const {refined: out} = applyRefutations(refined, research)
            if (out !== refined) {
                console.log(`!! NOOP VIOLATION ${doc.origin}`)
            }
            continue
        }
        hitDocs++
        if (isLead) leadHit = true
        const {refined: after, trail} = applyRefutations(refined, research)
        if (!isSubsequence(after, refined)) subsequenceViolations++
        if (trail.some(t => t.includes('owned requirement from the source design'))) ownedTouched++
        wholeLineDrops += trail.filter(t => t.includes('the whole CONSTRAINTS line')).length

        for (const r of found) {
            byPattern.set(r.pattern, (byPattern.get(r.pattern) ?? 0) + 1)
            byToken.set(r.token, (byToken.get(r.token) ?? 0) + 1)
            const line = dropToken(r.constraint, r.token)
            hits.push({origin: doc.origin, r, after: line === null ? '(line dropped)' : line})
        }
        void after
    }

    console.log(`corpus                 ${docs.length} recorded task files`)
    console.log(`  with CONSTRAINTS+CONTEXT   ${withBoth}`)
    console.log(`  with >=1 refutation        ${hitDocs}`)
    console.log(`  total refutation hits      ${hits.length}`)
    console.log(`  whole-line drops           ${wholeLineDrops}`)
    console.log(`lead ${LEAD.repo}/${LEAD.id}    seen=${leadSeen} hit=${leadHit}`)
    console.log(`\nby pattern:`)
    for (const [k, v] of [...byPattern].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`)
    console.log(`\nby token:`)
    for (const [k, v] of [...byToken].sort((a, b) => b[1] - a[1])) console.log(`  ${v}  ${k}`)
    console.log(`\ninv-no-line-invention violations   ${subsequenceViolations}`)
    console.log(`inv-owned-untouched violations     ${ownedTouched}`)

    console.log(`\n─── near misses: what the closed set does NOT fire on ───`)
    console.log(`(bullets carrying a loose negation-of-need AND a package-shaped token,`)
    console.log(` that produced no drop — the recall gap, for the next lead)`)
    const shapes = [...nearMiss].sort((a, b) => b[1].n - a[1].n)
    console.log(
        `  distinct shapes ${shapes.length}, total bullets ${[...nearMiss].reduce((s, [, v]) => s + v.n, 0)}`
    )
    for (const [shape, v] of shapes.slice(0, 20)) {
        console.log(`\n  ${v.n}x  [${shape}]`)
        console.log(`      ${v.sample.slice(0, 300)}`)
    }

    console.log(`\n─── every hit, for the hand-read ───`)
    for (const h of hits) {
        console.log(`\n### ${h.origin}   token=${h.r.token}   pattern=${h.r.pattern}`)
        console.log(`  RESEARCH   ${h.r.research.trim()}`)
        console.log(`  CONSTRAINT ${h.r.constraint.trim()}`)
        console.log(`  AFTER      ${h.after.trim()}`)
    }
}

/** Character subsequence — the mechanical form of "only deletes". */
function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0
    for (const ch of haystack) {
        if (i < needle.length && needle[i] === ch) i++
    }
    return i === needle.length
}

main()
