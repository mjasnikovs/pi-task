/**
 * decompose-fidelity tests — grounding of decompose [source: "…"] citations and
 * the deterministic dropped-`+`-fragment restoration (mx5 run 11, goal B). The
 * regression cases use the VERBATIM §12 milestone lines and the VERBATIM titles
 * run 11 actually produced (TASK_AUTO_0001.md, head part before the threaded
 * "| spec:" tail).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    extractTitleSource,
    findDroppedPlusFragments,
    reconcileTitleSources
} from './decompose-fidelity.js'
import {AUTO_DECOMPOSE_PROMPT} from './auto-prompts.js'

const MX5_DOC = fs.readFileSync(
    path.join(import.meta.dir, '__fixtures__', 'planning', 'mx5-project.md'),
    'utf8'
)

// The verbatim §12 lines whose "+ tests" suffix run 11 dropped.
const AUTH_LINE = '2. **Auth** — sessions, login/logout/me, guards + tests.'
const LISTINGS_LINE =
    '4. **Listings API** — CRUD + search/filter/sort/pagination + sold + contact + tests.'

// The verbatim titles run 11 produced for those milestones (tests suffix gone).
const RUN11_AUTH_TITLE =
    'Implement authentication layer — argon2id password hashing, cookie sessions in '
    + 'Postgres, login/logout/me routes, session middleware with requireAuth/requireAdmin guards'
const RUN11_LISTINGS_TITLE =
    'Implement listings API — CRUD endpoints, search/filter/sort/pagination with pg_trgm, '
    + 'sold toggle, ownership checks, contact reveal gate'

describe('extractTitleSource (grounding, contracts.ts pattern)', () => {
    test('a grounded verbatim citation is kept and the clause stripped', () => {
        const t = `Implement auth [source: "${AUTH_LINE}"]`
        expect(extractTitleSource(t, MX5_DOC)).toEqual({
            base: 'Implement auth',
            source: AUTH_LINE
        })
    })

    test('a fabricated/paraphrased citation is stripped and NOT trusted', () => {
        const t = 'Implement auth [source: "Auth milestone: build sessions and tests"]'
        expect(extractTitleSource(t, MX5_DOC)).toEqual({base: 'Implement auth'})
    })

    test('grounding is whitespace- and case-insensitive (line-wrapped quote still counts)', () => {
        const wrapped = '2. **auth** — sessions,   login/logout/me, guards + tests.'
        const {source} = extractTitleSource(`x [source: "${wrapped}"]`, MX5_DOC)
        expect(source).toBe(wrapped)
    })

    test('no clause ⇒ title passes through untouched', () => {
        expect(extractTitleSource('Implement auth — guards', MX5_DOC)).toEqual({
            base: 'Implement auth — guards'
        })
    })

    test('the clause is only recognised at the END (after any [decisions: …])', () => {
        const t = `Build shell [decisions: use bun] [source: "${AUTH_LINE}"]`
        const r = extractTitleSource(t, MX5_DOC)
        expect(r.base).toBe('Build shell [decisions: use bun]')
        expect(r.source).toBe(AUTH_LINE)
    })
})

describe('findDroppedPlusFragments (the deterministic lever)', () => {
    test('run-11 regression: the Auth title dropped "+ tests"', () => {
        expect(findDroppedPlusFragments(AUTH_LINE, RUN11_AUTH_TITLE)).toEqual(['tests'])
    })

    test('run-11 regression: the Listings title dropped "+ tests" but kept the other + fragments', () => {
        // search/filter/sort/pagination, sold, contact are all present in the title;
        // only the tests fragment is missing.
        expect(findDroppedPlusFragments(LISTINGS_LINE, RUN11_LISTINGS_TITLE)).toEqual(['tests'])
    })

    test('a title that kept the suffix is silent', () => {
        expect(
            findDroppedPlusFragments(AUTH_LINE, 'Implement auth — sessions, guards, and tests')
        ).toEqual([])
    })

    test('singular/plural s-difference is presence, not absence', () => {
        expect(
            findDroppedPlusFragments(AUTH_LINE, 'Auth layer with a test for every guard')
        ).toEqual([])
    })

    test('a source line with no + separator never yields fragments (body is free paraphrase)', () => {
        expect(
            findDroppedPlusFragments(
                '1. **Scaffold** — single-package setup (package.json, tsconfig), docker-compose Postgres, Bun SQL connection, migrations runner, admin seed.',
                'Scaffold project structure'
            )
        ).toEqual([])
    })

    test('multi-word fragments require all their words', () => {
        const line = 'Ship the exporter + import round-trip test'
        expect(findDroppedPlusFragments(line, 'Ship the exporter with an import test')).toEqual([
            'import round-trip test'
        ])
        expect(findDroppedPlusFragments(line, 'Exporter plus an import round-trip test')).toEqual(
            []
        )
    })
})

describe('reconcileTitleSources', () => {
    test('run-11 end-to-end: both dropped-tests titles are restored, others untouched', () => {
        const titles = [
            'Scaffold project structure — package.json, tsconfig, docker-compose Postgres [source: "1. **Scaffold** — single-package setup (package.json, tsconfig), docker-compose Postgres, Bun SQL connection, migrations runner, admin seed."]',
            `${RUN11_AUTH_TITLE} [source: "${AUTH_LINE}"]`,
            `${RUN11_LISTINGS_TITLE} [source: "${LISTINGS_LINE}"]`,
            'Build client shell — Bun.build config, wouter router setup' // no citation
        ]
        const plan = reconcileTitleSources(titles, MX5_DOC)
        expect(plan.sourced).toBe(3)
        expect(plan.restored).toHaveLength(2)
        expect(plan.titles[0]).toBe(
            'Scaffold project structure — package.json, tsconfig, docker-compose Postgres'
        )
        expect(plan.titles[1]).toBe(
            `${RUN11_AUTH_TITLE} — MUST also cover (restored from its spec line): tests`
        )
        expect(plan.titles[2]).toBe(
            `${RUN11_LISTINGS_TITLE} — MUST also cover (restored from its spec line): tests`
        )
        expect(plan.titles[3]).toBe('Build client shell — Bun.build config, wouter router setup')
    })

    test('a fabricated citation is stripped without restoration (never trusted)', () => {
        const plan = reconcileTitleSources(
            ['Implement auth [source: "build sessions + integration tests"]'],
            MX5_DOC
        )
        expect(plan.sourced).toBe(0)
        expect(plan.restored).toHaveLength(0)
        expect(plan.titles).toEqual(['Implement auth'])
    })

    test('no citations anywhere degrades to a pass-through (old behavior)', () => {
        const titles = ['Implement auth — guards', 'Build pages']
        const plan = reconcileTitleSources(titles, MX5_DOC)
        expect(plan.titles).toEqual(titles)
        expect(plan.sourced).toBe(0)
        expect(plan.restored).toHaveLength(0)
    })
})

describe('AUTO_DECOMPOSE_PROMPT carries the source-citation rule', () => {
    test('the rule text is present', () => {
        const p = AUTO_DECOMPOSE_PROMPT('feature', '')
        expect(p).toContain('[source: "<that line copied VERBATIM>"]')
        expect(p).toContain('discarded host-side')
    })
})
