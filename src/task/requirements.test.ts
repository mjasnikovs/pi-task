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
