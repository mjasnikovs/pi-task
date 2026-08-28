/**
 * The quality axis for STEP 2 of the `adhoc` clock question: does a worker
 * allowed to run four times longer answer WORSE?
 *
 * WHY NOT LENGTH. The treatment arm runs to completion and the baseline arm is
 * killed at 240s, so the treatment writes more text BY CONSTRUCTION. An axis
 * that rewards that is measuring the manipulation, not the answer. What can go
 * wrong with a longer run is INVENTION — a worker that keeps going past the
 * point where it had evidence and starts naming files it never read.
 *
 * SO THE AXIS IS PATH-CITATION FIDELITY: of the repo paths an answer names in
 * backticks, how many exist in the tree the worker was actually pointed at.
 * These workers are read-only explorers whose whole job is "where is X, and what
 * is in it", so a named path is the claim, and it is checkable without a judge.
 *
 * THE RULES ARE NOT NEW, AND THAT IS THE POINT. This repo has rejected this exact
 * axis once for being the thing that was losing: `phase-path-axis-audit.ts`
 * scored refine's OWN RECORDED OUTPUT at 56.2%, and a scorer the known-good
 * answer cannot clear may not judge anything. The audit's CATEGORY-CLEAN reading
 * — drop npm specifiers, URLs, MIME types, dotted code expressions, bare
 * filenames, relative import specifiers — is lifted here verbatim, plus the one
 * residual that audit named and did not fix: `src/` prefix elision, a worker
 * writing `workers/foo.ts` for `src/workers/foo.ts`.
 *
 * Both readings are reported. STRICT is exact tree membership; SUFFIX also
 * accepts a path that is a segment-aligned suffix of a real one. A loose scorer
 * is as fatal as a strict one, so which rung is being used stays visible rather
 * than being folded into one number.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** npm subpath specifiers seen in these corpora — a package, never a repo path. */
const NPM_SUBPATH =
    /^(hono|bun|react|react-dom|zod|wouter|sharp|eslint|prettier|typescript|node|vite|express|gorm|gin)\//

/**
 * Only the backticked spans that are really claims about a path in THIS repo.
 * Lifted from `phase-path-axis-audit.ts`'s CATEGORY-CLEAN rung, which is the
 * reading that took planning's citation axis from 59.2% to 97.1%.
 */
export function repoPath(s: string): string | null {
    if (!s.includes('/')) return null // a bare `db.ts` is a filename, not a path
    if (s.startsWith('@') || s.startsWith('./') || s.startsWith('../')) return null
    if (s.startsWith('/')) return null // absolute — not a repo-relative claim
    if (NPM_SUBPATH.test(s)) return null
    if (/^[a-z0-9-]+\.(dev|com|org|io|net)\//.test(s)) return null // a URL
    if (/^(image|text|application|audio|video)\//.test(s)) return null // a MIME type
    if (!/^[A-Za-z0-9._~][\w.@/+-]*$/.test(s)) return null
    return s.replace(/\/+$/, '')
}

/** Every file and every directory prefix in a tree. */
export function treeEntries(root: string): ReadonlySet<string> {
    const out = new Set<string>()
    const walk = (dir: string, rel: string): void => {
        let entries
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            if (e.name === '.git' || e.name === 'node_modules') continue
            const r = rel === '' ? e.name : `${rel}/${e.name}`
            out.add(r)
            if (e.isDirectory()) walk(path.join(dir, e.name), r)
        }
    }
    walk(root, '')
    return out
}

const SPAN = /`([^`\n]+)`/g

export interface Fidelity {
    cited: number
    strictReal: number
    suffixReal: number
    /** The paths no reading could find. These are the candidate inventions. */
    unfound: string[]
}

export function scorePaths(answer: string, tree: ReadonlySet<string>): Fidelity {
    const cited = new Set<string>()
    for (const m of answer.matchAll(SPAN)) {
        const p = repoPath(m[1]!.trim())
        if (p !== null) cited.add(p)
    }
    // Segment-aligned suffix: `workers/foo.ts` is a real claim about
    // `src/workers/foo.ts`. Anchored on `/` so `b.ts` cannot match `ab.ts`.
    const suffixHit = (p: string): boolean => {
        for (const t of tree) if (t.endsWith(`/${p}`)) return true
        return false
    }
    let strictReal = 0
    let suffixReal = 0
    const unfound: string[] = []
    for (const p of cited) {
        const strict = tree.has(p)
        if (strict) strictReal++
        if (strict || suffixHit(p)) suffixReal++
        else unfound.push(p)
    }
    return {cited: cited.size, strictReal, suffixReal, unfound}
}

/** Did the worker deliver an answer at all? The win side of the ledger. */
export function delivered(answer: string): boolean {
    const t = answer.trim()
    return t.length > 0 && !/^\(no output\)$/i.test(t) && !/^Worker (aborted|ran out of time)/i.test(t)
}

/**
 * Exact two-sided McNemar on the DISCORDANT pairs of a matched design.
 *
 * `b` = pairs where only the baseline delivered, `c` = only the treatment.
 * Concordant pairs carry no information about a difference and are excluded by
 * construction — which is the whole reason a matched design needs this test and
 * not a two-proportion one. An unpaired test on a matched design has produced
 * p = 0.3408 where the paired test gave 0.0019 on the same numbers
 * (memory/ab-statistic-must-match-design).
 *
 * Exact rather than chi-square: these runs produce single-digit discordant
 * counts, where the continuity-corrected approximation is not trustworthy.
 */
export function mcnemarExact(b: number, c: number): number {
    const n = b + c
    if (n === 0) return 1
    const logFact = (k: number): number => {
        let s = 0
        for (let i = 2; i <= k; i++) s += Math.log(i)
        return s
    }
    let tail = 0
    const k = Math.min(b, c)
    for (let i = 0; i <= k; i++) {
        tail += Math.exp(logFact(n) - logFact(i) - logFact(n - i) + n * Math.log(0.5))
    }
    return Math.min(1, 2 * tail)
}
