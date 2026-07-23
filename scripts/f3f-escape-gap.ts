/**
 * F-3(f) PHASE 1 — OFFLINE, NO MODEL TIME.
 *
 * QUESTION: are worker:fetch's `excerptVerified === false` verdicts false NEGATIVES caused
 * by a markdown-escape / HTML-entity normaliser gap in isExcerptInContent (child-output.ts),
 * or are they GENUINE non-verbatim excerpts (fabrication / stitch / meta-commentary)?
 *
 * isExcerptInContent only whitespace-normalises before a substring test. This script tests
 * whether widening that normaliser to also strip markdown backslash-escapes (\_ \* \[ \] \` …)
 * and decode HTML entities (&amp; &lt; &#39; smart quotes …) recovers real false negatives —
 * and, as a mandatory gate, whether the SAME widening admits genuine fabrications.
 *
 * RE-SCORABLE: `bun run scripts/f3f-escape-gap.ts`. Pure disk + string ops, no GPU, no network.
 *
 * EVIDENCE. The retained live A/B runs (~/tmp/fetch-abstention-ab/ab.json, baseline.json)
 * recorded only the `excerptVerified` BOOLEAN, never the excerpt text — so they cannot be
 * re-scored for this. The reconstructable real evidence is the run15 FAILURES + REGRESSION
 * fixtures (recorded model excerpts) matched to the snapshotted page markdown. That is what
 * this script scores. The synthetic controls prove the widener is well-formed independent of
 * whether real data exercises it.
 */
import fs from 'node:fs'
import path from 'node:path'
import {normaliseWhitespace} from '../src/shared/child-output.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const FIX = path.join(HERE, 'fixtures')
const PAGES_DIR = path.join(FIX, 'run15-fetch-pages')

interface Pair {url: string; query: string; excerpt: string; answer: string; recorded: Record<string, boolean>}
interface Page {url: string; finalUrl: string; markdown: string}

function loadPages(): Page[] {
    return fs
        .readdirSync(PAGES_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(PAGES_DIR, f), 'utf8')) as Page)
}
function loadPairs(file: string): Pair[] {
    return JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8')) as Pair[]
}
function pageFor(url: string, pages: Page[]): Page | undefined {
    const base = url.split('#')[0]
    return (
        pages.find(p => p.url === url) ??
        pages.find(p => p.url.split('#')[0] === base || p.finalUrl.split('#')[0] === base)
    )
}

// ── candidate wideners (applied SYMMETRICALLY to both sides, like whitespace) ────────────
/** Strip a backslash that escapes an ASCII-punctuation markdown metacharacter: \[ → [ . */
function stripMarkdownEscapes(s: string): string {
    return s.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1')
}
/** Decode the HTML entities a markdown converter commonly emits, plus smart punctuation. */
function decodeEntities(s: string): string {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;|&rsquo;|&lsquo;/g, "'")
        .replace(/&ldquo;|&rdquo;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x?[0-9a-fA-F]+;/g, m => {
            const hex = /x/i.test(m)
            const n = parseInt(m.replace(/&#x?|;/gi, ''), hex ? 16 : 10)
            return Number.isFinite(n) ? String.fromCodePoint(n) : m
        })
        .replace(/[‘’‛]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, '-')
        .replace(/…/g, '...')
}
const widen = (s: string): string => decodeEntities(stripMarkdownEscapes(s))

const shipped = (ex: string, md: string): boolean => {
    const ne = normaliseWhitespace(ex)
    return ne.length > 0 && normaliseWhitespace(md).includes(ne)
}
const widened = (ex: string, md: string): boolean => {
    const ne = normaliseWhitespace(widen(ex))
    return ne.length > 0 && normaliseWhitespace(widen(md)).includes(ne)
}

// ── 1. REAL DATA — score every recorded excerpt against its snapshot page ─────────────────
const pages = loadPages()
const rows: Array<{set: string; idx: number; url: string; ship: boolean; wide: boolean}> = []
for (const [set, file] of [
    ['failures', 'run15-fetch-failures.json'],
    ['regression', 'run15-fetch-regression.json']
] as const) {
    loadPairs(file).forEach((p, idx) => {
        const page = pageFor(p.url, pages)
        if (!page) {
            console.log(`  WARN no snapshot for ${set}#${idx} ${p.url}`)
            return
        }
        if (!p.excerpt) return // pair carries no recorded excerpt — nothing to score
        rows.push({set, idx, url: p.url, ship: shipped(p.excerpt, page.markdown), wide: widened(p.excerpt, page.markdown)})
    })
}
const shipFalse = rows.filter(r => !r.ship)
const recovered = shipFalse.filter(r => r.wide)
console.log('=== F-3(f) PHASE 1 — real recorded excerpts vs snapshot pages ===')
console.log(`scored ${rows.length} (excerpt, page) pairs across failures+regression fixtures`)
console.log(`shipped verifier says false: ${shipFalse.length}`)
console.log(`  of those, widening flips false -> true (candidate FN recovery): ${recovered.length}`)
for (const r of shipFalse) {
    console.log(`    ${r.set}#${r.idx} ship=false wide=${r.wide}  ${r.url.slice(0, 62)}`)
}

// ── 2. NEGATIVE CONTROL — genuine fabrications must NOT verify under the widening ─────────
// The meta-statement + stitched cases from the failures set are known-non-verbatim: the model
// described the page or joined non-contiguous fragments. If the widening verifies ANY of them,
// it is admitting a fabrication.
const fabPairs = loadPairs('run15-fetch-failures.json')
const KNOWN_FAB = [0, 1, 5, 7] // meta-statements (0,7) + stitches (1,5), hand-verified
let fabAdmitted = 0
console.log('\n=== NEGATIVE CONTROL — known non-verbatim excerpts (must stay false) ===')
for (const idx of KNOWN_FAB) {
    const p = fabPairs[idx]
    const page = pageFor(p.url, pages)!
    const w = widened(p.excerpt, page.markdown)
    if (w) fabAdmitted++
    console.log(`  failures#${idx} widened=${w} ${w ? 'ADMITTED-FABRICATION' : 'ok-still-false'}`)
}

// ── 3. SYNTHETIC CONTROLS — prove the widener is well-formed (would fire IF a gap existed) ─
console.log('\n=== SYNTHETIC — widener would recover a REAL escaped/entity variant ===')
const posCases: Array<[string, string, string]> = [
    ['markdown-escape brackets', 'foo\\[bar\\] baz', 'the page shows foo[bar] baz here'],
    ['escaped underscore', 'call \\_init\\_ now', 'you call _init_ now'],
    ['html entity amp', 'A &amp; B', 'A & B in text'],
    ['numeric entity apos', 'it&#39;s here', "it's here on page"],
    ['smart quotes', '“hello”', '"hello" appears']
]
let posShipFalse = 0
let posWideTrue = 0
for (const [name, ex, md] of posCases) {
    const s = shipped(ex, md)
    const w = widened(ex, md)
    if (!s) posShipFalse++
    if (!s && w) posWideTrue++
    console.log(`  ${name}: shipped=${s} widened=${w}`)
}
console.log('\n=== SYNTHETIC — widener must NOT verify a genuine absence ===')
const negCases: Array<[string, string, string]> = [
    ['absent text', 'this sentence is nowhere', 'a completely different page body'],
    ['stitched non-contiguous', 'alpha ... omega', 'alpha then many words then something omega'],
    ['meta-commentary', 'the page does not mention foo', 'foo is discussed at length here']
]
let negAdmitted = 0
for (const [name, ex, md] of negCases) {
    const w = widened(ex, md)
    if (w) negAdmitted++
    console.log(`  ${name}: widened=${w} ${w ? 'BAD-admitted' : 'ok'}`)
}

// ── VERDICT ──────────────────────────────────────────────────────────────────────────────
const widenerWorks = posShipFalse >= 4 && posWideTrue === posShipFalse && negAdmitted === 0
const realRecovery = recovered.length
console.log('\n=== VERDICT ===')
console.log(`widener well-formed (synthetic pos ${posWideTrue}/${posShipFalse} recovered, neg ${negAdmitted} admitted): ${widenerWorks}`)
console.log(`real false-negatives recovered on retained evidence: ${realRecovery}`)
console.log(`fabrications the widening would admit on real evidence: ${fabAdmitted}`)
if (realRecovery > 0 && fabAdmitted === 0) {
    console.log('SIGNAL — bounded widening recovers real FNs with 0 fabrications admitted. Proceed to PHASE 2.')
    process.exit(0)
} else if (realRecovery === 0) {
    console.log('NO SIGNAL — the widener is well-formed but real evidence exercises it ZERO times:')
    console.log('  every excerptVerified===false case is a GENUINE non-verbatim excerpt (meta-statement or')
    console.log('  stitched/omitted page text), not a markdown-escape/entity variant. STOP: spend no GPU,')
    console.log('  close F-3(f), leave isExcerptInContent untouched.')
    process.exit(3)
} else {
    console.log('MIXED — recovery > 0 but fabrications admitted. Widening is unsafe as-is. Do NOT wire.')
    process.exit(4)
}
