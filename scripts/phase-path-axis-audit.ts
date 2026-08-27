/**
 * Is "every backticked path refine names exists" a usable A/B axis for `phase`?
 *
 * BLOCKER 4 rejected it at 56.2% of paths and 6/56 tasks perfect: a bar refine's
 * OWN RECORDED OUTPUT could not clear, and a scorer the known-good answer cannot
 * clear may not judge anything. Planning's citation axis was rejected the same
 * way at 59.2% and went to 97.1% once four adjudicator bugs were fixed, so this
 * one is owed the same audit — is the CHECK the thing losing?
 *
 * IT IS, and this script measures by how much. It walks a ladder of ever-more-
 * honest readings of the same claim and prints where each one lands:
 *
 *   NAIVE          every backticked span that contains `/` or ends in a dotted
 *                  extension, against the task's own before/after trees
 *   CATEGORY-CLEAN the same, minus the spans that were never repo paths at all:
 *                  npm specifiers (`@hono/zod-validator`, `hono/client`), URLs,
 *                  MIME types, dotted code expressions (`c.var.user`), bare
 *                  filenames with no directory, `./` and `../` import specifiers
 *   FINAL-TREE     category-clean, but a path is real if it exists anywhere in
 *                  the tree the RUN shipped — which excuses a correct prediction
 *                  of a file a later task creates, and still catches invention
 *
 * Run: AB_CORPUS=<mx5 copy> bun run scripts/phase-path-axis-audit.ts
 */
import {openRecordedRun} from './ab-corpus.js'
import {implTasks} from './impl-ab-corpus.js'
import {treePaths, ignoredButPresent} from './reasoning-ab-files-truth.js'

const CORPUS = process.env.AB_CORPUS
if (CORPUS === undefined) {
    console.error('ABSTAIN — set AB_CORPUS to a recorded mx5 run.')
    process.exit(2)
}
const run = openRecordedRun(CORPUS)
if (run === null) {
    console.error(`ABSTAIN — no .pi-tasks directory under ${CORPUS}.`)
    process.exit(2)
}
const recs = new Map(run.tasks().map(r => [r.id, r]))
const tasks = implTasks()
const FINAL = tasks[tasks.length - 1]!.postCommit

/**
 * Refine's whole recorded output. The four sections it produces are stored as
 * SIBLING `##` headings, not nested under `## refined prompt`, so the section
 * reader alone returns an empty body — read to the next non-refine heading.
 */
function refineOutput(raw: string): string {
    const s = /^##\s+refined prompt\s*$/im.exec(raw)
    if (!s) return ''
    const rest = raw.slice(s.index + s[0].length)
    const e = /^##\s+verified tooling\s*$/im.exec(rest)
    return (e ? rest.slice(0, e.index) : rest).trim()
}

const SPAN = /`([^`\n]+)`/g
const NPM_SUBPATH =
    /^(hono|bun|react|react-dom|zod|wouter|sharp|eslint|prettier|typescript|argon2|playwright|vite|tailwindcss)\//
const naive = (s: string): string | null =>
    /^[A-Za-z0-9._@~][\w.@/+-]*$/.test(s) && (s.includes('/') || /\.[a-z0-9]{1,6}$/i.test(s))
        ? s.replace(/\/+$/, '')
        : null
/** Only the spans that are really claims about a path in THIS repo. */
const repoPath = (s: string): string | null => {
    if (!s.includes('/')) return null // a bare `db.ts` is a filename, not a path
    if (s.startsWith('@') || s.startsWith('./') || s.startsWith('../')) return null
    if (NPM_SUBPATH.test(s)) return null
    if (/^[a-z0-9-]+\.(dev|com|org|io|net)\//.test(s)) return null // a URL
    if (/^(image|text|application|audio|video)\//.test(s)) return null // a MIME type
    if (!/^[A-Za-z0-9._~][\w.@/+-]*$/.test(s)) return null
    return s.replace(/\/+$/, '')
}

const treeCache = new Map<string, ReadonlySet<string>>()
const tree = (c: string): ReadonlySet<string> => {
    let hit = treeCache.get(c)
    if (!hit) {
        hit = treePaths(c)
        treeCache.set(c, hit)
    }
    return hit
}
/** Every directory prefix in a tree — `git ls-tree` lists files, and refine
 *  legitimately names a directory ("everything under `src/server`"). */
const dirCache = new Map<string, Set<string>>()
const dirs = (c: string): Set<string> => {
    let hit = dirCache.get(c)
    if (!hit) {
        hit = new Set<string>()
        for (const p of tree(c)) {
            const parts = p.split('/')
            for (let i = 1; i < parts.length; i++) hit.add(parts.slice(0, i).join('/'))
        }
        dirCache.set(c, hit)
    }
    return hit
}
const inTree = (c: string, p: string): boolean => tree(c).has(p) || dirs(c).has(p)
const inFinal = (p: string): boolean => inTree(FINAL, p)

interface Rung {
    label: string
    extract: (s: string) => string | null
    real: (p: string, pre: string, post: string) => boolean
}
const RUNGS: Rung[] = [
    {
        label: 'NAIVE',
        extract: naive,
        real: (p, pre, post) => inTree(pre, p) || inTree(post, p) || ignoredButPresent(p)
    },
    {
        label: 'CATEGORY-CLEAN',
        extract: repoPath,
        real: (p, pre, post) => inTree(pre, p) || inTree(post, p) || ignoredButPresent(p)
    },
    {label: 'FINAL-TREE', extract: repoPath, real: p => inFinal(p) || ignoredButPresent(p)}
]

for (const rung of RUNGS) {
    let total = 0
    let ok = 0
    let perfect = 0
    let n = 0
    const misses: string[] = []
    for (const t of tasks) {
        const rec = recs.get(t.id)
        if (!rec) continue
        const out = refineOutput(rec.raw)
        if (out === '') continue
        const paths = [
            ...new Set(
                [...out.matchAll(SPAN)]
                    .map(m => rung.extract(m[1]!.trim()))
                    .filter((x): x is string => x !== null)
            )
        ]
        if (paths.length === 0) continue
        const good = paths.filter(p => rung.real(p, t.preCommit, t.postCommit))
        n++
        total += paths.length
        ok += good.length
        if (good.length === paths.length) perfect++
        for (const p of paths) if (!rung.real(p, t.preCommit, t.postCommit)) misses.push(p)
    }
    console.log(
        `${rung.label.padEnd(15)} paths ${ok}/${total} (${((100 * ok) / total).toFixed(1)}%)`
            + `   whole-task perfect ${perfect}/${n}`
    )
    const predicted = misses.filter(inFinal)
    if (predicted.length > 0) {
        console.log(
            `${' '.repeat(16)}of ${misses.length} ungrounded, ${predicted.length} DO exist in the`
                + " run's final tree — a correct prediction, marked wrong"
        )
    }
    if (rung.label === 'FINAL-TREE') {
        console.log(`${' '.repeat(16)}residual, never real anywhere:`)
        for (const p of [...new Set(misses)]) console.log(`${' '.repeat(18)}${p}`)
    }
}
