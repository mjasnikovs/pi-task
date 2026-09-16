/**
 * spec-doc tests — the ONE parse every planning parser reads.
 *
 * The fixture is a byte copy of the design document a real /task-auto run
 * (AUTO_0002) planned from, so the regressions below are the ones that shipped:
 * task titles carrying a DDL `check (…)` tail and a router table's guard column
 * as "restored spec constraints", and the document's one-line product
 * description promoted to a requirement no task can own.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    blocksOf,
    groundIn,
    parseSpecDoc,
    preambleOf,
    sectionPlains,
    type Block
} from '../../src/task/spec-doc.js'
import {findDroppedPlusFragments, reconcileTitleSources} from '../../src/task/decompose-fidelity.js'
import {
    classifyRequirement,
    keepGroundedRequirements,
    REQUIREMENT_POLICY
} from '../../src/task/requirements.js'

const PROJECT_SPEC = fs.readFileSync(
    path.join(import.meta.dir, '__fixtures__', 'project-spec.md'),
    'utf8'
)
const DOC = parseSpecDoc(PROJECT_SPEC)

/** The spec lines AUTO_0002 cited, with the fragment each one restored into a
 *  task title. Every fragment below is a cut through markup the line's own
 *  grammar never had. */
const AUTO_0002 = {
    'TASK_0051 (DDL fence)': {
        line: '-- listing_photos  (max 5 per listing, enforced in app + check)',
        kind: 'fence',
        garbage: 'check'
    },
    'the login row (router table)': {
        line: '| `/login` | Sign in (phone + password) | public |',
        kind: 'table-row',
        garbage: 'password) | public |'
    },
    'the marketplace row (router table)': {
        line: '| `/` | Marketplace grid + search/filter/sort/pagination | member |',
        kind: 'table-row',
        garbage: 'search/filter/sort/pagination | member |'
    },
    'TASK_0036 (prose bullet)': {
        line: '- **Dev:** docker-compose Postgres + concurrent watch (tailwind, bun build, server).',
        kind: 'list-item',
        garbage: 'concurrent watch (tailwind, bun build, server'
    },
    'TASK_0042 (prose bullet)': {
        line: '- **Route/API:** `bun test` + `hono` `app.request()` (see hono.dev testing guide).',
        kind: 'list-item',
        garbage: 'hono app.request() (see hono.dev testing guide'
    }
} as const

function ground(quote: string): Block {
    const b = groundIn(DOC, quote)
    expect(b).not.toBeNull()
    return b!
}

describe('parseSpecDoc', () => {
    test('the fixture splits into a titled preamble and its numbered sections', () => {
        expect(DOC.sections.map(s => s.heading)).toContain('10. Testing')
        expect(DOC.sections.map(s => s.depth)).toContain(2)
        // `# MX-5 Private — Project Design` is the document TITLE, not a section,
        // so the description under it is preamble.
        expect(preambleOf(DOC)[0].plain).toContain(
            'Invite-only used-parts marketplace for a local Mazda MX-5 club.'
        )
    })

    test('each AUTO_0002 line grounds in a block of the kind its markup says', () => {
        for (const [name, c] of Object.entries(AUTO_0002)) {
            expect({name, kind: ground(c.line).kind}).toEqual({name, kind: c.kind})
        }
    })

    test('a block records its own 1-based source line as the anchor', () => {
        const b = ground('a test lands *as fast as possible* — in the same change')
        expect(PROJECT_SPEC.split('\n')[b.line - 1]).toContain('Test-first cadence (required)')
    })

    test('a fence is ONE block, never re-read as prose', () => {
        const fences = blocksOf(DOC).filter(b => b.kind === 'fence')
        expect(fences).toHaveLength(2)
        expect(fences.some(f => f.text.includes('listing_photos'))).toBe(true)
        // Its inner lines belong to it and to nothing else.
        expect(blocksOf(DOC).filter(b => b.text.includes('password_hash text not null'))).toEqual([
            fences.find(f => f.text.includes('password_hash'))!
        ])
    })

    test('a doc with no headings is one section-less run of paragraphs', () => {
        const flat = parseSpecDoc('Build a CSV parser.\n\nIt must stream.\n')
        expect(flat.sections).toEqual([])
        expect(flat.preamble.map(b => b.kind)).toEqual(['para', 'para'])
        // No body to be above ⇒ no preamble, so a preamble policy cannot empty it.
        expect(preambleOf(flat)).toEqual([])
    })

    test('CRLF parses exactly like LF', () => {
        const lf = '# T\n\n## A\n\n- one\n- two\n\n| a | b |\n'
        expect(parseSpecDoc(lf.replace(/\n/g, '\r\n'))).toEqual(parseSpecDoc(lf))
    })

    test('sectionPlains keeps every section, heading included', () => {
        const plains = sectionPlains(DOC)
        expect(plains.length).toBe(DOC.sections.length + (DOC.preamble.length > 0 ? 1 : 0))
        expect(plains.some(s => s.includes('11. security notes'))).toBe(true)
    })
})

// THE RESTORED-GARBAGE REGRESSION. `findDroppedPlusFragments` used to split the
// raw quote on every `+` and comma, wherever they sat — inside a DDL constraint,
// inside a parenthetical, across table pipes — and re-attach whatever came out to
// the task title as a spec obligation the task MUST also cover.
describe('findDroppedPlusFragments over the AUTO_0002 lines', () => {
    const IRRELEVANT_TITLE = 'Build the thing'

    test('a table row and a fence restore NOTHING at all', () => {
        for (const [name, c] of Object.entries(AUTO_0002)) {
            if (c.kind !== 'table-row' && c.kind !== 'fence') continue
            expect({
                name,
                frags: findDroppedPlusFragments(ground(c.line), IRRELEVANT_TITLE)
            }).toEqual({name, frags: []})
        }
    })

    test('no line restores the fragment it restored live', () => {
        for (const [name, c] of Object.entries(AUTO_0002)) {
            const frags = findDroppedPlusFragments(ground(c.line), IRRELEVANT_TITLE)
            expect({name, hit: frags.includes(c.garbage)}).toEqual({name, hit: false})
        }
    })

    test('a prose bullet still restores its additive constraint, balanced', () => {
        // The two bullets are genuine `+`-joined prose, so they still restore —
        // the parenthetical now travels whole instead of being cut at its comma.
        expect(
            findDroppedPlusFragments(ground(AUTO_0002['TASK_0036 (prose bullet)'].line), 'Dev env')
        ).toEqual(['concurrent watch (tailwind, bun build, server)'])
        expect(
            findDroppedPlusFragments(ground(AUTO_0002['TASK_0042 (prose bullet)'].line), 'Harness')
        ).toEqual(['hono app.request() (see hono.dev testing guide)'])
    })

    test('a title carrying the constraint restores nothing', () => {
        expect(
            findDroppedPlusFragments(
                ground(AUTO_0002['TASK_0036 (prose bullet)'].line),
                'Dev environment — concurrent watch over tailwind, bun build and the server'
            )
        ).toEqual([])
    })

    test('end-to-end: the five cited lines produce no restoration a title cannot parse', () => {
        const plan = reconcileTitleSources(
            Object.values(AUTO_0002).map(c => `Some task [source: "${c.line}"]`),
            PROJECT_SPEC
        )
        expect(plan.sourced).toBe(Object.keys(AUTO_0002).length)
        for (const r of plan.restored) {
            for (const f of r.fragments) {
                expect(f).not.toContain('|')
                expect(balanced(f)).toBe(true)
            }
        }
    })
})

function balanced(s: string): boolean {
    let depth = 0
    for (const c of s) {
        if (c === '(') depth++
        if (c === ')') depth--
    }
    return depth === 0
}

// THE UNOWNED-DESCRIPTION REGRESSION. The fixture's opening line was extracted as
// a requirement, mapped NONE by every coverage round (no task delivers a sentence
// about what the product IS), and so held the verdict INCOMPLETE — two whole
// regenerated plans, both rejected, before the loop gave up and surfaced it as
// "no task owns this".
describe('the preamble product description', () => {
    const DESCRIPTION = 'Invite-only used-parts marketplace for a local Mazda MX-5 club.'

    test('it grounds ONLY in a preamble block, so the policy rejects it', () => {
        expect(groundIn(DOC, DESCRIPTION)).not.toBeNull()
        expect(keepGroundedRequirements([{quote: DESCRIPTION, anchor: 'intro'}], DOC)).toEqual([])
    })

    test('it classifies descriptive, and the same words elsewhere stay ownable', () => {
        expect(classifyRequirement(DESCRIPTION, true)).toBe('descriptive')
        expect(classifyRequirement(DESCRIPTION, false)).toBe('ownable')
    })

    test('a preamble sentence that DOES obligate is still a requirement', () => {
        expect(classifyRequirement('The marketplace must be invite-only.', true)).toBe('ownable')
    })

    test('an ordinary §10 obligation still grounds, with its anchor', () => {
        const kept = keepGroundedRequirements(
            [
                {
                    quote: 'No route or component is considered done until its test exists',
                    anchor: '10'
                }
            ],
            DOC
        )
        expect(kept).toHaveLength(1)
        expect(kept[0].preamble).toBe(false)
        expect(PROJECT_SPEC.split('\n')[kept[0].line! - 1]).toContain('Test-first cadence')
    })

    test('the policy names what it excludes', () => {
        expect([...REQUIREMENT_POLICY.candidateKinds]).not.toContain('fence')
        expect([...REQUIREMENT_POLICY.candidateKinds]).not.toContain('table-row')
        expect(REQUIREMENT_POLICY.excludePreamble).toBe(true)
    })

    test('a quote whose only match is a DDL row or a table cell is not a requirement', () => {
        for (const q of [
            'content_type text not null default',
            'Marketplace grid + search/filter/sort/pagination'
        ]) {
            expect(groundIn(DOC, q)).not.toBeNull()
            expect(keepGroundedRequirements([{quote: q, anchor: ''}], DOC)).toEqual([])
        }
    })
})
