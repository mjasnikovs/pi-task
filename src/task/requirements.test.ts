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
