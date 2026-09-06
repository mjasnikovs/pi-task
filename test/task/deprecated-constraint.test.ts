/**
 * The deprecation detector, pinned on the two real strings defect 14 was read out
 * of: ts/TASK_0001 (an un-backticked API expression inside an `(e.g. …)`) and
 * hs/TASK_0001 (a backticked package). Both are quoted verbatim — a paraphrase
 * would stop measuring the defect.
 *
 * Same two properties as its sibling: it may only DELETE, and it may only fire on
 * a DEPRECATION claim about the token, never on prose that merely names it.
 */
import {describe, expect, test} from 'bun:test'

import {
    applyDeprecations,
    detectDeprecations,
    dropExpression
} from '../../src/task/deprecated-constraint.js'

const OWNED_STAMP =
    'owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)'

// ---- ts/TASK_0001, verbatim out of the recorded artifact -------------------

const TS_CONSTRAINT =
    '  - The zod schema must require all three fields: `name` — string (z.string()); `port` — number,'
    + ' integer, with a minimum of 1 and a maximum of 65535 (e.g. z.number().int().min(1).max(65535));'
    + ' `adminEmail` — an email (e.g. z.string().email()). All three are required, not optional.'
const TS_APIS =
    'z.email()  top-level v4 email string schema for adminEmail (z.string().email() still exists in'
    + ' 4.5.4 but is @deprecated; either type-checks, z.email() is canonical)'

// ---- hs/TASK_0001, verbatim out of the recorded artifact ------------------

const HS_CONSTRAINT =
    '- The library `build-depends` must include exactly `aeson`, `scotty`, and `text` (plus any `base`'
    + ' bound appropriate to the toolchain); the test suite `test-build-depends` must additionally'
    + ' include `wai-test` on top of `aeson`, `scotty`, and `text`.'
/** The constraint that made the hs case a false-drop trap: `test-suite` is
 *  hyphenated, sits in the same CONSTRAINTS block, and is named in the research
 *  line's own description. */
const HS_SIBLING_CONSTRAINT =
    '- Do not introduce extra packages, executables, data directories, or stanzas beyond the `library`'
    + ' and the single `test-suite`.'
const HS_APIS =
    'wai-test  test-suite dep REQUIRED by constraints BUT deprecated on hackage: "Since WAI 3.0, this'
    + ' code has been merged into wai-extra"; last real release 2.0.1.3 targets wai 2.x and will NOT'
    + ' resolve alongside scotty==0.30 (wai >=3 <3.3); 3.0.0 exists but has no published docs'
    + " (deprecation stub) — spec must resolve this conflict (use wai-extra's Network.Wai.Test instead,"
    + ' or pin wai-test 2.0.1.3 against wai 2.x which breaks scotty 0.30)'
const HS_SIBLING_APIS =
    'wai-extra  drop-in replacement for wai-test under WAI 3.x; exposes module Network.Wai.Test'
    + ' (scotty 0.30 already pulls wai-extra >=3.1.14)'

// ---- ts/TASK_0002, the third recorded fire — a CONTEXT bullet -------------

const TS2_CONTEXT =
    '- `zod` is pinned at 4.5.4, i.e. zod v4. Open question (unverified): `z.string().email()` may be'
    + ' superseded by `z.email()`, but I cannot confirm v4 semantics from read/grep alone.'

function refinedWith(...constraints: string[]): string {
    return ['GOAL', 'Scaffold the project.', '', 'CONSTRAINTS', ...constraints, ''].join('\n')
}
function researchWith(opts: {apis?: string[]; context?: string[]}): string {
    return [
        'FILES',
        'package.json  the manifest',
        '',
        'APIS',
        ...(opts.apis ?? []),
        '',
        'CONTEXT',
        ...(opts.context ?? []),
        ''
    ].join('\n')
}

/** Character subsequence — the mechanical form of "only deletes". */
function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0
    for (const ch of haystack) if (i < needle.length && needle[i] === ch) i++
    return i === needle.length
}

describe('detectDeprecations — the three recorded fires', () => {
    test('ts/TASK_0001: an un-backticked API expression in an APIS description', () => {
        const found = detectDeprecations(
            refinedWith(TS_CONSTRAINT),
            researchWith({apis: [TS_APIS]})
        )
        expect(found.map(f => f.token)).toEqual(['z.string().email()'])
        expect(found[0].research).toBe(TS_APIS)
    })

    test('hs/TASK_0001: a backticked package, named by the APIS line it heads', () => {
        const found = detectDeprecations(
            refinedWith(HS_CONSTRAINT, HS_SIBLING_CONSTRAINT),
            researchWith({apis: [HS_APIS, HS_SIBLING_APIS]})
        )
        expect(found.map(f => f.token)).toEqual(['wai-test'])
    })

    test('ts/TASK_0002: the same expression, refuted from a CONTEXT bullet', () => {
        const found = detectDeprecations(
            refinedWith(TS_CONSTRAINT),
            researchWith({context: [TS2_CONTEXT]})
        )
        expect(found.map(f => f.token)).toEqual(['z.string().email()'])
    })
})

describe('inv-precision — shapes that must NOT fire', () => {
    test('the canonical replacement is never the deprecated token', () => {
        const found = detectDeprecations(
            refinedWith('  - Use `z.email()` for `adminEmail`.'),
            researchWith({apis: [TS_APIS]})
        )
        expect(found).toEqual([])
    })

    test('a hyphenated English compound in the description is not the subject', () => {
        const found = detectDeprecations(
            refinedWith(HS_SIBLING_CONSTRAINT),
            researchWith({apis: [HS_APIS]})
        )
        expect(found).toEqual([])
    })

    test('a research line with no deprecation marker refutes nothing', () => {
        const found = detectDeprecations(
            refinedWith(HS_CONSTRAINT),
            researchWith({apis: [HS_SIBLING_APIS]})
        )
        expect(found).toEqual([])
    })

    test('an owned requirement is never deprecated away', () => {
        const found = detectDeprecations(
            refinedWith(`${HS_CONSTRAINT} — ${OWNED_STAMP}`),
            researchWith({apis: [HS_APIS]})
        )
        expect(found).toEqual([])
    })

    test('"replaced by" was removed by the measurement and must stay out', () => {
        const found = detectDeprecations(
            refinedWith('  - Keep `src/shared/index.ts`.'),
            researchWith({
                context: ['- `src/shared/index.ts`  Empty file to be replaced by schema.ts exports']
            })
        )
        expect(found).toEqual([])
    })
})

describe('dropExpression', () => {
    test('an emptied (e.g. …) collapses, and z.string() keeps its own parens', () => {
        const out = dropExpression(TS_CONSTRAINT, 'z.string().email()')
        expect(out).toContain('`adminEmail` — an email.')
        expect(out).toContain('(z.string())')
        expect(out).not.toContain('z.string().email()')
    })

    test('the leading indent survives the whitespace collapse', () => {
        // The collapse exists to close the gap the deletion left. Applied to the
        // whole line it also eats a nested bullet's indent, which changes the
        // markdown level of a constraint this pass is not even firing on.
        const out = dropExpression(TS_CONSTRAINT, 'z.string().email()')
        expect(out?.startsWith('  - ')).toBe(true)
    })

    test('a backticked package drops with one adjacent separator', () => {
        const out = dropExpression(HS_CONSTRAINT, 'wai-test')
        expect(out).not.toContain('wai-test')
        expect(out).toContain('`test-build-depends`')
    })
})

describe('inv-no-line-invention', () => {
    test('every applied result is a character subsequence of its input', () => {
        for (const [refined, research] of [
            [refinedWith(TS_CONSTRAINT), researchWith({apis: [TS_APIS]})],
            [
                refinedWith(HS_CONSTRAINT, HS_SIBLING_CONSTRAINT),
                researchWith({apis: [HS_APIS, HS_SIBLING_APIS]})
            ],
            [refinedWith(TS_CONSTRAINT), researchWith({context: [TS2_CONTEXT]})]
        ]) {
            const out = applyDeprecations(refined, research)
            expect(out.trail.length).toBeGreaterThan(0)
            expect(isSubsequence(out.refined, refined)).toBe(true)
        }
    })
})
