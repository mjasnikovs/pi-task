import {describe, expect, test} from 'bun:test'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {
    parseContractLines,
    keepGroundedContracts,
    appendContracts,
    readContracts,
    buildContractsBlock,
    buildContractsVerifyBlock,
    CONTRACT_EMIT_INSTRUCTION,
    CONTRACT_EXTRACT_PROMPT,
    type ContractEntry
} from '../../src/task/contracts.js'

describe('parseContractLines', () => {
    test('parses CONTRACT lines with a quote and optional anchor', () => {
        const text = [
            'here is what I found',
            'CONTRACT: "POST /api/listings/:id/photos" [anchor: Photos API]',
            'CONTRACT: "GET /api/photos/:id"',
            'not a contract line'
        ].join('\n')
        const e = parseContractLines(text)
        expect(e).toEqual([
            {quote: 'POST /api/listings/:id/photos', anchor: 'Photos API'},
            {quote: 'GET /api/photos/:id', anchor: ''}
        ])
    })

    test('skips a CONTRACT line with no quoted span (a summary, not a quote)', () => {
        expect(parseContractLines('CONTRACT: photos are mounted under the api prefix')).toEqual([])
    })

    test('drops a too-short quote', () => {
        expect(parseContractLines('CONTRACT: "GET"')).toEqual([])
    })
})

describe('keepGroundedContracts — the anti-synthesis (F3) guard', () => {
    const design = [
        '## Photos API',
        'Upload is POST /api/listings/:id/photos (nested under the listing).',
        'Fetch and delete are GET /api/photos/:id and DELETE /api/photos/:id.'
    ].join('\n')

    test('keeps a quote that is a verbatim substring of the design', () => {
        const kept = keepGroundedContracts(
            [{quote: 'POST /api/listings/:id/photos', anchor: 'Photos API'}],
            design
        )
        expect(kept).toHaveLength(1)
    })

    test('DROPS a fabricated/paraphrased quote absent from the design (the F3 bug)', () => {
        // The exact fabrication: a uniform mount table the design never states.
        const kept = keepGroundedContracts(
            [
                {quote: 'POST /api/photos/listings/:id/photos', anchor: 'made up'},
                {quote: '/api/photos → photosRoutes', anchor: 'fabricated mount table'}
            ],
            design
        )
        expect(kept).toEqual([])
    })

    test('matches across whitespace/line-wrap and case differences', () => {
        const kept = keepGroundedContracts(
            [{quote: 'post   /API/listings/:id/photos', anchor: ''}],
            design
        )
        expect(kept).toHaveLength(1)
    })

    test('deduplicates grounded quotes case-insensitively', () => {
        const kept = keepGroundedContracts(
            [
                {quote: 'GET /api/photos/:id', anchor: 'a'},
                {quote: 'get /api/photos/:id', anchor: 'b'}
            ],
            design
        )
        expect(kept).toHaveLength(1)
    })
})

describe('appendContracts / readContracts', () => {
    test('stores grounded entries and dedups against existing on re-append', async () => {
        const cwd = mkdtempSync(`${tmpdir()}/contracts-`)
        await appendContracts(cwd, [
            {quote: 'POST /api/listings/:id/photos', anchor: 'Photos API'},
            {quote: 'GET /api/photos/:id', anchor: ''}
        ])
        await appendContracts(cwd, [
            {quote: 'GET /api/photos/:id', anchor: 'dup'}, // dedup
            {quote: 'DELETE /api/photos/:id', anchor: ''}
        ])
        const stored = await readContracts(cwd)
        const lines = stored.split('\n').filter(Boolean)
        expect(lines).toHaveLength(3)
        expect(stored).toContain('"POST /api/listings/:id/photos" [anchor: Photos API]')
        expect(stored).toContain('"DELETE /api/photos/:id"')
    })

    test('readContracts on a fresh dir is empty', async () => {
        const cwd = mkdtempSync(`${tmpdir()}/contracts-empty-`)
        expect(await readContracts(cwd)).toBe('')
    })

    test('empty entries is a no-op', async () => {
        const cwd = mkdtempSync(`${tmpdir()}/contracts-noop-`)
        await appendContracts(cwd, [])
        expect(await readContracts(cwd)).toBe('')
    })
})

describe('prompt blocks', () => {
    const contracts = '"POST /api/listings/:id/photos" [anchor: Photos API]\n"GET /api/photos/:id"'

    test('refine/compose block is authoritative and forbids inventing', () => {
        const b = buildContractsBlock(contracts)
        expect(b).toContain('CROSS-SLICE CONTRACTS')
        expect(b).toContain('- "POST /api/listings/:id/photos" [anchor: Photos API]')
        expect(b).toMatch(/AUTHORITATIVE and BINDING/)
        expect(b).toMatch(/SEAM BUG/)
        expect(b).toMatch(/Do NOT invent, rename, reshape/)
        expect(buildContractsBlock('')).toBe('')
    })

    test('verify block mandates a boundary check against the registry', () => {
        const b = buildContractsVerifyBlock(contracts)
        expect(b).toContain('CROSS-SLICE CONTRACTS')
        expect(b).toMatch(/Check the shipped work at its boundary/)
        expect(b).toMatch(/SEAM BUG — report FAIL/)
        expect(buildContractsVerifyBlock('')).toBe('')
    })

    test('emit instruction demands verbatim quotes, not summaries', () => {
        expect(CONTRACT_EMIT_INSTRUCTION).toMatch(/copied EXACTLY|verbatim/)
        expect(CONTRACT_EMIT_INSTRUCTION).toContain('CONTRACT: "<verbatim quote')
        expect(CONTRACT_EMIT_INSTRUCTION).toMatch(
            /not a literal\s*\n?\s*substring of the design is DISCARDED/
        )
    })

    test('extract prompt carries the design, the task list, and the emit instruction', () => {
        const p = CONTRACT_EXTRACT_PROMPT('POST /api/listings/:id/photos is the upload.', [
            'Build the photos API',
            'Wire the app assembly'
        ])
        expect(p).toContain('POST /api/listings/:id/photos is the upload.')
        expect(p).toContain('1. Build the photos API')
        expect(p).toContain('2. Wire the app assembly')
        expect(p).toContain(CONTRACT_EMIT_INSTRUCTION)
        expect(p).toMatch(/quote from it, never from your own knowledge/)
    })
})

describe('end-to-end: parse → ground → store', () => {
    test('a fabricated contract in child output never reaches the registry', async () => {
        const design = 'Upload is POST /api/listings/:id/photos.'
        const childOutput = [
            'CONTRACT: "POST /api/listings/:id/photos" [anchor: Upload]', // grounded
            'CONTRACT: "/api/photos → photosRoutes" [anchor: mount]' // fabricated
        ].join('\n')
        const grounded: ContractEntry[] = keepGroundedContracts(
            parseContractLines(childOutput),
            design
        )
        const cwd = mkdtempSync(`${tmpdir()}/contracts-e2e-`)
        await appendContracts(cwd, grounded)
        const stored = await readContracts(cwd)
        expect(stored).toContain('POST /api/listings/:id/photos')
        expect(stored).not.toContain('photosRoutes')
    })
})
