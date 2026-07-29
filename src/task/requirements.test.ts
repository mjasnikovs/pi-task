/**
 * requirements tests — grounded requirement extraction, the per-requirement
 * coverage map with host-side accounting, and the carried-requirements artifact
 * + injection blocks (mx5 run 11, goals A/C/E).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    parseRequirementLines,
    keepGroundedRequirements,
    capRequirements,
    isLowValueQuote,
    enumerateObligationPassages,
    uncoveredPassages,
    extractionRetryHint,
    REQUIREMENT_EXTRACT_PROMPT,
    parseCoverageMap,
    accountCoverage,
    appendCarriedRequirements,
    readRequirements,
    requirementsFile,
    buildRequirementsBlock,
    buildRequirementsLedger,
    writeOwnedRequirements,
    readOwnedRequirements,
    ownedForTitle,
    buildOwnedRequirementsBlock,
    appendOwnedConstraints,
    type RequirementEntry
} from './requirements.js'
import {AUTO_DECOMPOSE_PROMPT} from './auto-prompts.js'
import {buildAutoBody, parseTaskList} from './auto-io.js'

const MX5_DOC = fs.readFileSync(
    path.join(import.meta.dir, '__fixtures__', 'planning', 'mx5-project.md'),
    'utf8'
)

// Verbatim §10 obligations — the section run 11 lost entirely.
const CADENCE_QUOTE =
    'a test lands *as fast as possible* — in the same change — as\neach new route or React component/page'
const CT_QUOTE = 'every component/page test captures a screenshot committed as a baseline'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-requirements-'))
}

describe('parseRequirementLines', () => {
    test('parses quote + anchor; skips unquoted and over/under-length lines', () => {
        const text = [
            'REQUIREMENT: "no route or component is considered done until its test exists" [anchor: 10. Testing]',
            'REQUIREMENT: unquoted summary line',
            'REQUIREMENT: "tiny"',
            `REQUIREMENT: "${'x'.repeat(400)}"`
        ].join('\n')
        expect(parseRequirementLines(text)).toEqual([
            {
                quote: 'no route or component is considered done until its test exists',
                anchor: '10. Testing'
            }
        ])
    })
})

describe('keepGroundedRequirements (anti-synthesis guard)', () => {
    test('keeps verbatim §10 quotes (whitespace-insensitive) and drops fabrications', () => {
        const kept = keepGroundedRequirements(
            [
                {quote: CADENCE_QUOTE, anchor: '10'},
                {quote: CT_QUOTE, anchor: '10'},
                {quote: 'all endpoints must respond in under 100ms', anchor: 'perf'} // invented
            ],
            MX5_DOC
        )
        expect(kept.map(e => e.anchor)).toEqual(['10', '10'])
    })

    test('dedupes case/whitespace-insensitively', () => {
        const kept = keepGroundedRequirements(
            [
                {quote: CT_QUOTE, anchor: 'a'},
                {quote: CT_QUOTE.toUpperCase(), anchor: 'b'}
            ],
            MX5_DOC
        )
        expect(kept).toHaveLength(1)
    })
})

describe('obligation-passage recall floor', () => {
    test('mx5: both §10 paragraphs and the §5 RPC mandate are enumerated', () => {
        const passages = enumerateObligationPassages(MX5_DOC)
        expect(passages.some(p => p.includes('Test-first cadence (required)'))).toBe(true)
        expect(passages.some(p => p.includes('RPC only (no hand-rolled types)'))).toBe(true)
    })

    test('a doc with no obligation markers yields no passages (prompt unchanged)', () => {
        expect(enumerateObligationPassages('Build a small tool.\n\nIt parses CSV.')).toEqual([])
        expect(REQUIREMENT_EXTRACT_PROMPT('x')).toBe(REQUIREMENT_EXTRACT_PROMPT('x', []))
        expect(REQUIREMENT_EXTRACT_PROMPT('x', ['must do y'])).toContain(
            'OBLIGATION-MARKED PASSAGES'
        )
    })

    test('CRLF line endings split into passages like LF (windows-latest checkout)', () => {
        // A Windows-authored spec separates paragraphs with \r\n; the recall floor
        // must still enumerate each marked passage (regression: windows CI kept the
        // whole doc as one passage, so per-passage coverage evidence was impossible).
        const lf = 'Intro prose.\n\nThe api MUST be RPC-only.\n\nTests are required per route.'
        const crlf = lf.replace(/\n/g, '\r\n')
        expect(enumerateObligationPassages(crlf)).toEqual(enumerateObligationPassages(lf))
        expect(enumerateObligationPassages(crlf)).toHaveLength(2)
    })

    test('uncoveredPassages: a passage with no overlapping kept quote is hard evidence', () => {
        const passages = enumerateObligationPassages(MX5_DOC)
        const cadence = passages.find(p => p.includes('Test-first cadence'))!
        // A §5 quote covers its own passage but not the cadence passage.
        const kept = [{quote: 'server↔client communication MUST go through Hono', anchor: '5'}]
        const uncovered = uncoveredPassages(passages, kept)
        expect(uncovered).toContain(cadence)
        // Quoting from the cadence passage covers it.
        const covered = uncoveredPassages(passages, [
            ...kept,
            {quote: "Don't batch testing to the end of a milestone", anchor: '10'}
        ])
        expect(covered).not.toContain(cadence)
    })

    test('capRequirements keeps marked-passage quotes over doc-order overflow', () => {
        const passages = ['The system MUST log every request.']
        const filler = Array.from({length: 45}, (_, i) => ({
            quote: `filler requirement number ${i}`,
            anchor: ''
        }))
        const marked = {quote: 'MUST log every request', anchor: 'tail'}
        const capped = capRequirements([...filler, marked], passages)
        expect(capped).toHaveLength(40)
        expect(capped[0]).toEqual(marked) // survives although it arrived last
    })

    test('capRequirements with a source doc fills ROUND-ROBIN across sections — a tail section is never wholesale dropped (mx5 run 16)', () => {
        // Three sections, 20 groundable quotes each. The shipped given-order fill
        // would keep §A's 20 + §B's 20 and drop §C entirely; the section-fair
        // fill must keep every section's head quotes — including §C's first,
        // the run-16 "serves static dist/" shape (tail section, early bullet).
        const mk = (s: string, n: number) =>
            Array.from({length: n}, (_, i) => `${s} obligation ${i} with enough length to ground`)
        const doc = [
            '# A',
            ...mk('alpha', 20).map(q => `- ${q}`),
            '# B',
            ...mk('beta', 20).map(q => `- ${q}`),
            '# C',
            ...mk('gamma', 20).map(q => `- ${q}`)
        ].join('\n')
        const entries = [...mk('alpha', 20), ...mk('beta', 20), ...mk('gamma', 20)].map(q => ({
            quote: q,
            anchor: ''
        }))
        const capped = capRequirements(entries, [], doc)
        expect(capped).toHaveLength(40)
        const bySection = (s: string) => capped.filter(e => e.quote.startsWith(s)).length
        // 40 / 3 sections → 13-14 each; every section represented, none dropped.
        expect(bySection('alpha')).toBeGreaterThanOrEqual(13)
        expect(bySection('beta')).toBeGreaterThanOrEqual(13)
        expect(bySection('gamma')).toBeGreaterThanOrEqual(13)
        // Within a section, the HEAD entries survive (doc order inside buckets).
        expect(
            capped.some(e => e.quote === 'gamma obligation 0 with enough length to ground')
        ).toBe(true)
    })

    test('capRequirements without a source doc keeps the old given-order fill', () => {
        const filler = Array.from({length: 45}, (_, i) => ({
            quote: `filler requirement number ${i}`,
            anchor: ''
        }))
        const capped = capRequirements(filler, [])
        expect(capped).toHaveLength(40)
        expect(capped[0].quote).toBe('filler requirement number 0')
        expect(capped[39].quote).toBe('filler requirement number 39')
    })

    test('capRequirements: marked-passage priority still outranks section fairness', () => {
        const doc = [
            '# A',
            ...Array.from({length: 45}, (_, i) => `- section A item ${i} long enough to ground`),
            '# B',
            '- the system MUST flush queues on shutdown'
        ].join('\n')
        const passages = ['the system MUST flush queues on shutdown']
        const entries = [
            ...Array.from({length: 45}, (_, i) => ({
                quote: `section A item ${i} long enough to ground`,
                anchor: ''
            })),
            {quote: 'the system MUST flush queues on shutdown', anchor: ''}
        ]
        const capped = capRequirements(entries, passages, doc)
        expect(capped[0].quote).toBe('the system MUST flush queues on shutdown')
        expect(capped).toHaveLength(40)
    })

    // ── low-value deprioritisation (the 40-slot budget) ──────────────────────
    // The extractor's single-pass yield swings 20..160 on the byte-identical mx5
    // spec, and the padding crowds real obligations out of the 40 that ship —
    // high-yield runs land FEWER critical obligations than low-yield ones.
    //
    // Measured end to end (filter → cap → count critical obligations in the
    // shipped 40) on two INDEPENDENT 30-run extraction pools:
    //   design pool       8.50 → 9.37 of 16   10 better, 0 worse, p=0.0020
    //   confirmation pool 7.70 → 8.43 of 16   12 better, 0 worse, p=0.0005
    // The second pool was drawn AFTER the rule was fixed, because the budget
    // clause was written while looking at a loss in the first one.
    //
    // Tail-section coverage — what sectionFairFill protects, and the thing a
    // ranking change is most likely to break — is unchanged on both pools, with
    // zero regressions in 60 runs.

    /**
     * FP SUITE. Each entry traces to a real failure or an obligation of record —
     * the index.html clause whose loss shipped a permanently blank app (run 16),
     * the §10 cadence line run 11 lost, the ownership/ban/photo contract.
     *
     * These are VERBATIM quotes the extractor really produced, lifted from the
     * measured pools, not paraphrases. That distinction has teeth: a hand-shortened
     * stand-in for the ESLint line ("ESLint `10.6.0` with `no-explicit-any: error`
     * …", 65 chars) trips the length-gated dependency-pin rule, while the 226-char
     * line the extractor actually emits does not. Paraphrasing the suite would test
     * the paraphrase.
     */
    const CRITICAL_OBLIGATIONS = [
        'TypeScript `6.0.3` — one strict `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `forceConsistentCasingInFileNames`.',
        'Prettier `3.9.4` — `printWidth 120`, no semicolons, single quotes, no bracket spacing, `arrowParens: avoid`, LF. Config: `.prettierrc.cjs` (aiz-server variant).',
        'ESLint `10.6.0` flat config (`eslint.config.js`) — `typescript-eslint` `8.62.1` `recommendedTypeChecked`; `no-explicit-any: error`, `no-shadow: error`, unused-vars ignore `^_`; client packages add `react-hooks` + `react-refresh`.',
        "`lint` = `prettier --write 'src/**/*.{ts,tsx}' && eslint --fix . && tsc --noEmit`;",
        'non-`/api` GETs serve the built `index.html`.',
        "a test lands *as fast as possible* — in the same change — as each new route or React component/page. No route or component is considered done until its test exists and passes. Don't batch testing to the end of a milestone.",
        'Each new component/page gets its `*.spec.tsx` alongside it immediately (see cadence above). Mock RPC calls at the network boundary so component tests stay deterministic and DB-free.',
        'auth (login/guards), invite redeem (one-time, expiry), listing CRUD + ownership, photo upload limit (≤5), admin ban/delete.',
        "Consume is atomic (`UPDATE … SET used_at = now() WHERE used_at IS NULL RETURNING …`) so concurrent redeems can't both win.",
        'Zod-validate every input; parameterized queries via Bun SQL tagged templates (no string interpolation).',
        'Phone reveal only to authenticated members; never ship phone in list/detail payloads.',
        'Ownership/role checks server-side on every mutation; banned-user gate (session rejected + their listings filtered from all listing queries).',
        'Basic rate-limit on login, invite create, and invite redeem (simple in-memory counter is fine — single Bun process).',
        'Argon2id passwords; hashed session tokens; `HttpOnly`/`Secure`/`SameSite` cookies.'
    ]

    test('isLowValueQuote: no critical obligation is classified low-value (FP suite)', () => {
        const misclassified = CRITICAL_OBLIGATIONS.filter(q => isLowValueQuote(q))
        expect(misclassified).toEqual([])
    })

    test('isLowValueQuote: catches the four measured junk shapes', () => {
        // Bare dependency pins — data, not obligations. 27% of a 237-quote pool.
        expect(isLowValueQuote('`hono` `4.12.27` — HTTP framework, RPC (`hono/client`)')).toBe(true)
        expect(isLowValueQuote('`zod` `4.4.3` — schemas (shared client/server)')).toBe(true)
        // DDL rows — the most STABLE thing the extractor produces, and obligation-free.
        expect(isLowValueQuote('display_name text not null')).toBe(true)
        expect(isLowValueQuote('created_at timestamptz not null default now()')).toBe(true)
        // Cut mid-expression.
        expect(isLowValueQuote('the handler calls `db.query(')).toBe(true)
        // Fragments.
        expect(isLowValueQuote('Contact seller')).toBe(true)
    })

    test('capRequirements: an obligation-MARKED quote is never dropped as low-value', () => {
        // "MUST log every request" is 22 chars — every length-based rule reads it
        // as a fragment. Quoting a marked passage outranks the lexical heuristic;
        // filtering ahead of the marked/rest split deleted it outright.
        const passages = ['The system MUST log every request.']
        const filler = Array.from({length: 45}, (_, i) => ({
            quote: `filler requirement number ${i}`,
            anchor: ''
        }))
        const capped = capRequirements(
            [...filler, {quote: 'MUST log every request', anchor: ''}],
            passages
        )
        expect(capped.some(e => e.quote === 'MUST log every request')).toBe(true)
    })

    test('capRequirements: low-value quotes lose their slots when the list overflows', () => {
        const doc = [
            '# Deps',
            '- `hono` `4.12.27` — HTTP framework',
            '- `zod` `4.4.3` — schemas',
            '# Rules',
            ...Array.from({length: 45}, (_, i) => `- rule ${i} states a real obligation here`)
        ].join('\n')
        const entries = [
            {quote: '`hono` `4.12.27` — HTTP framework', anchor: ''},
            {quote: '`zod` `4.4.3` — schemas', anchor: ''},
            ...Array.from({length: 45}, (_, i) => ({
                quote: `rule ${i} states a real obligation here`,
                anchor: ''
            }))
        ]
        const capped = capRequirements(entries, [], doc).map(e => e.quote)
        expect(capped).toHaveLength(40)
        expect(capped).not.toContain('`hono` `4.12.27` — HTTP framework')
        expect(capped).not.toContain('`zod` `4.4.3` — schemas')
    })

    test('capRequirements: BUDGETED — low-value quotes come back rather than undershoot the cap', () => {
        // The filter exists to free contested slots. Below the cap nothing is
        // contested, so dropping there destroys information and buys nothing: one
        // measured run filtered 55 quotes to 20 and lost its only carrier of the
        // Argon2id obligation while 20 slots sat empty.
        const pins = Array.from({length: 30}, (_, i) => `\`pkg${i}\` \`1.${i}.0\` — a dependency`)
        const rules = Array.from({length: 15}, (_, i) => `rule ${i} states a real obligation here`)
        const doc = [
            '# Deps',
            ...pins.map(p => `- ${p}`),
            '# Rules',
            ...rules.map(r => `- ${r}`)
        ].join('\n')
        const entries = [...pins, ...rules].map(q => ({quote: q, anchor: ''}))
        const capped = capRequirements(entries, [], doc).map(e => e.quote)
        expect(capped).toHaveLength(40)
        // every real obligation kept …
        for (const r of rules) expect(capped).toContain(r)
        // … and the free slots refilled from the deprioritised pool, not left empty.
        expect(capped.filter(q => pins.includes(q))).toHaveLength(25)
    })

    test('capRequirements: under the cap nothing is deprioritised at all', () => {
        // The common case for a small spec. No slot is contested, so a pin that
        // would lose its place in a 100-quote list keeps it in a 10-quote one —
        // the rule must not become a general-purpose deleter.
        const entries = [
            {quote: '`hono` `4.12.27` — HTTP framework', anchor: ''},
            {quote: 'display_name text not null', anchor: ''},
            ...Array.from({length: 8}, (_, i) => ({
                quote: `rule ${i} states a real obligation here`,
                anchor: ''
            }))
        ]
        expect(capRequirements(entries, [], 'doc')).toEqual(entries)
    })

    test('capRequirements: the A/B seam reproduces the pre-budget rule', () => {
        // 45 pins and 45 obligations, two sections. With the rule OFF the
        // section-fair fill splits the budget evenly and pins take half of it;
        // with it ON the obligations alone already fill the cap, so no pin ships.
        const pins = Array.from({length: 45}, (_, i) => `\`pkg${i}\` \`1.${i}.0\` — a dependency`)
        const rules = Array.from({length: 45}, (_, i) => `rule ${i} states a real obligation here`)
        const doc = [
            '# Deps',
            ...pins.map(p => `- ${p}`),
            '# Rules',
            ...rules.map(r => `- ${r}`)
        ].join('\n')
        const entries = [...pins, ...rules].map(q => ({quote: q, anchor: ''}))
        const off = capRequirements(entries, [], doc, false).map(e => e.quote)
        const on = capRequirements(entries, [], doc).map(e => e.quote)
        expect(off).toHaveLength(40)
        expect(on).toHaveLength(40)
        expect(off.filter(q => pins.includes(q)).length).toBeGreaterThan(0)
        expect(on.filter(q => pins.includes(q))).toHaveLength(0)
    })

    test('owned requirements: write → read → title match → injection block (run 16 channel gap)', async () => {
        const cwd = makeCwd()
        const title =
            'Implement Hono app entry (server/index.ts) with SPA fallback for non-/api routes | spec: @DESIGN/PROJECT.md'
        await writeOwnedRequirements(cwd, [
            {quote: 'serves `/api` + static `dist/`', anchor: '9. Build & run', title},
            {
                quote: 'photos stored as bytea',
                anchor: '1. Decisions',
                title: 'Some other task title'
            }
        ])
        const owned = await readOwnedRequirements(cwd)
        expect(owned).toHaveLength(2)
        const mine = ownedForTitle(owned, title)
        expect(mine).toHaveLength(1)
        expect(mine[0].quote).toBe('serves `/api` + static `dist/`')
        // A spliced repair task (title not in the plan) gets nothing.
        expect(ownedForTitle(owned, 'repair src/server/migrate.ts: …')).toHaveLength(0)
        const block = buildOwnedRequirementsBlock(mine)
        expect(block).toContain("THIS TASK'S OWN REQUIREMENTS")
        expect(block).toContain('serves `/api` + static `dist/`')
        expect(block).toContain('the quote wins')
        expect(buildOwnedRequirementsBlock([])).toBe('')
    })

    test('appendOwnedConstraints (braces): omitted quote appended under CONSTRAINTS, present quote skipped', () => {
        const spec = [
            'GOAL',
            '  Build the server entry.',
            '',
            'CONSTRAINTS',
            '  - SPA fallback serves `dist/index.html`.',
            '',
            'ACCEPTANCE',
            '  - server boots',
            '',
            'VERIFY:',
            '```sh',
            'bun test',
            '```'
        ].join('\n')
        const owned = [
            {quote: 'serves `/api` + static `dist/`', anchor: '9. Build & run', title: 't'},
            // Already present (normalised) — must NOT be double-stated.
            {quote: 'SPA fallback serves `dist/index.html`', anchor: '5. API', title: 't'}
        ]
        const out = appendOwnedConstraints(spec, owned)
        expect(out).toContain(
            '- "serves `/api` + static `dist/`" [9. Build & run] — owned requirement'
        )
        expect(out.split('SPA fallback serves')).toHaveLength(2) // not duplicated
        // Appended directly under the CONSTRAINTS header, before existing bullets.
        expect(out.indexOf('serves `/api`')).toBeLessThan(out.indexOf('SPA fallback'))
        // Idempotent: a second pass appends nothing.
        expect(appendOwnedConstraints(out, owned)).toBe(out)
        // No CONSTRAINTS section → unchanged; no owned → unchanged.
        expect(appendOwnedConstraints('GOAL\nonly', owned)).toBe('GOAL\nonly')
        expect(appendOwnedConstraints(spec, [])).toBe(spec)
    })

    test('extractionRetryHint names the uncovered passage heads', () => {
        const hint = extractionRetryHint(['**Test-first cadence (required):** a test lands…'])
        expect(hint).toContain('Test-first cadence')
        expect(hint).toContain('Re-extract the FULL')
    })
})

describe('parseCoverageMap / accountCoverage (host-side completeness)', () => {
    const reqs: RequirementEntry[] = [
        {quote: 'r-one', anchor: ''},
        {quote: 'r-two', anchor: ''},
        {quote: 'r-three', anchor: ''},
        {quote: 'r-four', anchor: ''}
    ]

    test('maps TASK/CROSS-CUTTING/NONE and accounts them', () => {
        const map = parseCoverageMap(
            'MAP: 1 -> TASK 2\nMAP: 2 -> CROSS-CUTTING\nMAP: 3 -> NONE\nMAP: 4 -> TASK 1',
            4,
            3
        )
        const acc = accountCoverage(reqs, map)
        expect(acc.mapped.map(m => m.task)).toEqual([2, 1])
        expect(acc.crossCutting.map(e => e.quote)).toEqual(['r-two'])
        expect(acc.unmapped.map(e => e.quote)).toEqual(['r-three'])
    })

    test('a skipped requirement is NONE — leniency never manufactures coverage', () => {
        const acc = accountCoverage(reqs, parseCoverageMap('MAP: 1 -> TASK 1', 4, 3))
        expect(acc.unmapped).toHaveLength(3)
    })

    test('an out-of-range task number is NONE, not trusted', () => {
        const map = parseCoverageMap('MAP: 1 -> TASK 9', 4, 3)
        expect(map[0]).toEqual({kind: 'none'})
    })

    test('tolerates arrow/case/spacing variants', () => {
        const map = parseCoverageMap('map: 1 → task 3\nMAP: 2 -> Cross-cutting', 2, 3)
        expect(map[0]).toEqual({kind: 'task', task: 3})
        expect(map[1]).toEqual({kind: 'cross'})
    })
})

describe('carried-requirements artifact', () => {
    test('appends cross-cutting + marked unresolved, deduped, and reads back', async () => {
        const cwd = makeCwd()
        await appendCarriedRequirements(
            cwd,
            [{quote: 'every mutating endpoint MUST be rate-limited', anchor: 'Security'}],
            [{quote: 'orphaned obligation', anchor: ''}]
        )
        await appendCarriedRequirements(cwd, [
            {quote: 'every mutating endpoint MUST be rate-limited', anchor: 'Security'}
        ])
        expect(fs.existsSync(requirementsFile(cwd))).toBe(true)
        const raw = await readRequirements(cwd)
        expect(raw.split('\n')).toHaveLength(2)
        expect(raw).toContain('rate-limited')
        expect(raw).toContain('[no task owns this — surfaced at plan time]')
    })

    test('nothing to carry ⇒ no artifact', async () => {
        const cwd = makeCwd()
        await appendCarriedRequirements(cwd, [])
        expect(fs.existsSync(requirementsFile(cwd))).toBe(false)
    })

    test('dangling-artifact channel (run 13 PROMPT 2) carries with its own marker', async () => {
        const cwd = makeCwd()
        await appendCarriedRequirements(
            cwd,
            [],
            [],
            [],
            ['runtime artifact `dist/index.html` is referenced (spec prose) but NOTHING creates it']
        )
        const raw = await readRequirements(cwd)
        expect(raw).toContain('dist/index.html')
        expect(raw).toContain(
            '[dangling runtime artifact, nothing produces it — surfaced at plan time]'
        )
    })
})

describe('injection blocks', () => {
    test('buildRequirementsBlock demands same-change delivery and VERIFY coverage', () => {
        const block = buildRequirementsBlock('"a test lands in the same change" [anchor: 10]')
        expect(block).toContain('CROSS-CUTTING REQUIREMENTS')
        expect(block).toContain('- "a test lands in the same change" [anchor: 10]')
        expect(block).toContain('ACCEPTANCE/VERIFY exercise it')
        expect(buildRequirementsBlock('')).toBe('')
    })

    test('the decompose ledger rides into AUTO_DECOMPOSE_PROMPT; empty ledger is a no-op', () => {
        const ledger = buildRequirementsLedger([{quote: 'must export as JSON', anchor: 'prose'}])
        const p = AUTO_DECOMPOSE_PROMPT('feature', '', ledger)
        expect(p).toContain('REQUIRED CONTENT LEDGER')
        expect(p).toContain('1. "must export as JSON" [prose]')
        expect(AUTO_DECOMPOSE_PROMPT('feature', '')).toBe(AUTO_DECOMPOSE_PROMPT('feature', '', ''))
    })
})

describe('buildAutoBody coverage section', () => {
    test('records the accounting durably without breaking the task list parse', () => {
        const body = buildAutoBody(
            'feat',
            '',
            ['task one', 'task two'],
            '5 grounded requirement(s): 3 task-mapped, 1 cross-cutting, 1 unowned\n- carried: "x"'
        )
        expect(body).toContain('## coverage')
        expect(body).toContain('1 cross-cutting')
        expect(parseTaskList(body).map(t => t.title)).toEqual(['task one', 'task two'])
    })

    test('empty coverage omits the section (old shape byte-identical)', () => {
        expect(buildAutoBody('feat', 'c', ['t'])).toBe(buildAutoBody('feat', 'c', ['t'], ''))
        expect(buildAutoBody('feat', 'c', ['t'])).not.toContain('## coverage')
    })
})
