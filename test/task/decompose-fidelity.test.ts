/**
 * decompose-fidelity tests — grounding of decompose [source: "…"] citations and
 * the deterministic dropped-`+`-fragment restoration. The
 * regression cases use the VERBATIM §12 milestone lines and the VERBATIM titles
 * actually produced (TASK_AUTO_0001.md, head part before the threaded
 * "| spec:" tail).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    extractTitleSource,
    findDroppedPlusFragments,
    reconcileTitleSources
} from '../../src/task/decompose-fidelity.js'
import {AUTO_DECOMPOSE_PROMPT} from '../../src/task/auto-prompts.js'

const PROJECT_SPEC = fs.readFileSync(
    path.join(import.meta.dir, '__fixtures__', 'project-spec.md'),
    'utf8'
)

// The verbatim §12 lines whose "+ tests" suffix dropped.
const AUTH_LINE = '2. **Auth** — sessions, login/logout/me, guards + tests.'
const LISTINGS_LINE =
    '4. **Listings API** — CRUD + search/filter/sort/pagination + sold + contact + tests.'

// The verbatim titles produced for those milestones (tests suffix gone).
const RUN11_AUTH_TITLE =
    'Implement authentication layer — argon2id password hashing, cookie sessions in '
    + 'Postgres, login/logout/me routes, session middleware with requireAuth/requireAdmin guards'
const RUN11_LISTINGS_TITLE =
    'Implement listings API — CRUD endpoints, search/filter/sort/pagination with pg_trgm, '
    + 'sold toggle, ownership checks, contact reveal gate'

describe('extractTitleSource (grounding, contracts.ts pattern)', () => {
    test('a grounded verbatim citation is kept and the clause stripped', () => {
        const t = `Implement auth [source: "${AUTH_LINE}"]`
        expect(extractTitleSource(t, PROJECT_SPEC)).toEqual({
            base: 'Implement auth',
            sources: [AUTH_LINE]
        })
    })

    test('a fabricated/paraphrased citation is stripped and NOT trusted', () => {
        const t = 'Implement auth [source: "Auth milestone: build sessions and tests"]'
        expect(extractTitleSource(t, PROJECT_SPEC)).toEqual({base: 'Implement auth', sources: []})
    })

    test('grounding is whitespace- and case-insensitive (line-wrapped quote still counts)', () => {
        const wrapped = '2. **auth** — sessions,   login/logout/me, guards + tests.'
        const {sources} = extractTitleSource(`x [source: "${wrapped}"]`, PROJECT_SPEC)
        expect(sources).toEqual([wrapped])
    })

    test('no clause ⇒ title passes through untouched', () => {
        expect(extractTitleSource('Implement auth — guards', PROJECT_SPEC)).toEqual({
            base: 'Implement auth — guards',
            sources: []
        })
    })

    test('the clause is only recognised at the END (after any [decisions: …])', () => {
        const t = `Build shell [decisions: use bun] [source: "${AUTH_LINE}"]`
        const r = extractTitleSource(t, PROJECT_SPEC)
        expect(r.base).toBe('Build shell [decisions: use bun]')
        expect(r.sources).toEqual([AUTH_LINE])
    })

    // THE GREEDY-REGEX REGRESSION. The prompt asks for one trailing citation and
    // a quarter of real titles carry more (62 of 244 across the 20 recorded
    // decompose runs). `\[source: "(.+)"\]$` matched from the FIRST clause to the
    // LAST quote and produced the superstring `A"] [source: "B`, which grounds
    // nowhere — so two real citations became zero.
    test('MULTIPLE trailing clauses each ground separately', () => {
        const t = `Build it [source: "${AUTH_LINE}"] [source: "${LISTINGS_LINE}"]`
        const r = extractTitleSource(t, PROJECT_SPEC)
        expect(r.base).toBe('Build it')
        expect(r.sources).toEqual([AUTH_LINE, LISTINGS_LINE])
    })

    test('among several clauses, only the fabricated one is dropped', () => {
        const t = `Build it [source: "${AUTH_LINE}"] [source: "invented requirement line"]`
        expect(extractTitleSource(t, PROJECT_SPEC).sources).toEqual([AUTH_LINE])
    })

    // THE MARKUP REGRESSION. A model copies the line as RENDERED, without its
    // list number and bold runs. That is still a verbatim copy of the text, and
    // the exact-substring test called it fabricated — on this module's own
    // worked example.
    test('a quote copied without its markdown markup still grounds', () => {
        const rendered = 'Auth — sessions, login/logout/me, guards + tests.'
        expect(extractTitleSource(`x [source: "${rendered}"]`, PROJECT_SPEC).sources).toEqual([
            rendered
        ])
    })

    test('stripping markup does NOT let an altered line through', () => {
        const altered = 'Auth — sessions, login/logout/me, firewalls + tests.'
        expect(extractTitleSource(`x [source: "${altered}"]`, PROJECT_SPEC).sources).toEqual([])
    })

    // THE BACKTICK REGRESSION, the larger half of the same class. A code span
    // renders as bare text, so the model copies `/join/:token` without its
    // backticks. On a real planning run, most ungrounded
    // clauses were this and nothing else.
    test('a quote copied without its code backticks still grounds', () => {
        const rendered = 'Invites — create/validate/redeem, /join/:token page.'
        expect(extractTitleSource(`x [source: "${rendered}"]`, PROJECT_SPEC).sources).toEqual([
            rendered
        ])
    })

    test('a backtick-stripped quote does NOT collapse the spacing around it', () => {
        // `hono` `4.12.27` — dropping the backticks must not leave a gap that a
        // faithful copy no longer matches. Backtick → nothing, pipe → space.
        const rendered = 'hono 4.12.27 — HTTP framework, RPC (hono/client)'
        expect(extractTitleSource(`x [source: "${rendered}"]`, PROJECT_SPEC).sources).toEqual([
            rendered
        ])
    })

    test('stripping backticks does NOT let an altered line through', () => {
        const altered = 'Invites — create/validate/revoke, /join/:token page.'
        expect(extractTitleSource(`x [source: "${altered}"]`, PROJECT_SPEC).sources).toEqual([])
    })

    // THE ESCAPE REGRESSION. The clause is double-quoted, so a spec line that
    // itself contains a double quote comes back backslash-escaped. The
    // backslashes are the delimiter's artefact, not content.
    test('a quote whose inner double quotes are backslash-escaped still grounds', () => {
        const withQuotes =
            'Verify Bun/Hono/Tailwind/Playwright API names against current docs '
            + '(e.g. the `import { sql } from \\"bun\\"` gotcha — there is no '
            + '`bun:sql` module).'
        expect(extractTitleSource(`x [source: "${withQuotes}"]`, PROJECT_SPEC).sources.length).toBe(
            1
        )
    })

    test('unescaping does NOT let an altered line through', () => {
        const altered =
            'Verify Bun/Hono/Tailwind/Playwright API names against outdated docs '
            + '(e.g. the `import { sql } from \\"bun\\"` gotcha — there is no '
            + '`bun:sql` module).'
        expect(extractTitleSource(`x [source: "${altered}"]`, PROJECT_SPEC).sources).toEqual([])
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
        const plan = reconcileTitleSources(titles, PROJECT_SPEC)
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
            PROJECT_SPEC
        )
        expect(plan.sourced).toBe(0)
        expect(plan.restored).toHaveLength(0)
        expect(plan.titles).toEqual(['Implement auth'])
    })

    test('no citations anywhere degrades to a pass-through (old behavior)', () => {
        const titles = ['Implement auth — guards', 'Build pages']
        const plan = reconcileTitleSources(titles, PROJECT_SPEC)
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
