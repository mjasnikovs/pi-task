/**
 * CEILING/FLOOR screen for the decompose citation adjudicator.
 *
 * The axis planningPlanFaithful is decided by `extractTitleSource`, so the
 * adjudicator has to clear the known-good answer before it may judge a model.
 * Two forms of "known good" are screened, because a model does NOT copy a
 * markdown line the way the file stores it — it copies what it READS:
 *
 *   CEILING-RAW       the spec line byte-for-byte
 *   CEILING-RENDERED  the same line with markdown MARKUP removed — emphasis,
 *                     list/heading markers, table pipes AND code backticks.
 *                     Measured live: `**Invites** — create/validate/redeem,
 *                     `/join/:token` page.` comes back without the backticks.
 *   FLOOR             CEILING-RENDERED with ONE content word replaced. Must
 *                     NOT ground, or the check cannot tell a copy from a
 *                     fabrication.
 *
 * Run: bun run scripts/decompose-fidelity-screen.ts
 */
import {loadPlanningFixture} from './ab-planning.js'
import {extractTitleSource} from '../src/task/decompose-fidelity.js'

const fx = await loadPlanningFixture('mx5')
const doc = fx.featureForModel

/** What a model reads instead of what the file stores. */
function rendered(line: string): string {
    return line
        .replace(/\*\*|__/g, '')
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        .replace(/^#+\s*/, '')
        .replace(/`/g, '')
        .replace(/^\s*\|\s*/, '')
        .replace(/\s*\|\s*$/, '')
        .replace(/\s*\|\s*/g, ' ')
        .trim()
}

const lines = doc
    .split('\n')
    .map(l => l.trim())
    .filter(l => (l.match(/[A-Za-z]+/g) ?? []).length >= 6)

const grounds = (quote: string) => extractTitleSource(`Task X [source: "${quote}"]`, doc).sources.length === 1

let rawOk = 0
let renOk = 0
const renBad: string[] = []
for (const l of lines) {
    if (grounds(l)) rawOk++
    const r = rendered(l)
    if (grounds(r)) renOk++
    else renBad.push(r)
}

// FLOOR: swap ONE content word (>=5 letters, not a path/symbol) for a plausible
// other word. A line with no such word cannot be floor-tested and is skipped.
let floorLines = 0
let floorLeaks = 0
const leaks: string[] = []
for (const l of lines) {
    const r = rendered(l)
    const m = [...r.matchAll(/\b[a-z]{5,}\b/g)].filter(x => !/^(the|and|with|that|this|from|into|when|where|which|their|there)$/.test(x[0]))
    if (m.length === 0) continue
    const pick = m[Math.floor(m.length / 2)]
    const altered = r.slice(0, pick.index) + 'zorbulate' + r.slice(pick.index + pick[0].length)
    floorLines++
    if (grounds(altered)) {
        floorLeaks++
        leaks.push(altered)
    }
}

console.log(`lines screened            ${lines.length}`)
console.log(`CEILING raw               ${rawOk}/${lines.length}`)
console.log(`CEILING rendered          ${renOk}/${lines.length}`)
console.log(`FLOOR leaks               ${floorLeaks}/${floorLines}`)
if (renBad.length > 0) {
    console.log(`\nrendered lines the adjudicator REJECTS (${renBad.length}):`)
    for (const b of renBad.slice(0, 25)) console.log(`  ${JSON.stringify(b.slice(0, 150))}`)
}
for (const l of leaks.slice(0, 5)) console.log(`  LEAK ${JSON.stringify(l.slice(0, 150))}`)
