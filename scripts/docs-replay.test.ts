import {describe, expect, test} from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {
    buildArmPrompt,
    integrity,
    loadCorpusFiles,
    parseArgs,
    parseRecords,
    recoverCorpus,
    recoverIdentity,
    retrieveLive,
    stripMixedClause,
    tally,
    type ReplayRecord,
    type ReplayRow
} from './docs-replay.js'
import {normaliseWhitespace} from '../src/shared/child-output.js'

const sha = (s: string): string => createHash('sha256').update(normaliseWhitespace(s)).digest('hex')

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const retrievedText = 'declare function parse(s: string): unknown'
    return {
        at: '2026-09-06T00:00:00.000Z',
        module: 'zod',
        query: 'what does parse return',
        answer: 'unknown',
        typeOnly: false,
        reason: '',
        unclear: false,
        excerptVerified: true,
        excerptCheck: {
            verified: true,
            contentSha256: sha(retrievedText),
            contentLength: normaliseWhitespace(retrievedText).length,
            normalisedExcerpt: 'parse'
        },
        retrievedText,
        toolText: '### npm: zod\nlatest: 4.5.4\n\nPer zod@4.5.4:\nunknown',
        ...over
    }
}

const line = (over?: Record<string, unknown>): string => JSON.stringify(record(over))

describe('integrity', () => {
    test('accepts bytes that still hash to what the run verified against', () => {
        expect(integrity(record() as never)).toBe(true)
    })

    test('rejects tampered content — the whole basis for trusting a replay', () => {
        const r = record({retrievedText: 'declare function parse(s: string): string'})
        expect(integrity(r as never)).toBe(false)
    })

    test('rejects a record with no retrievedText rather than guessing', () => {
        expect(integrity({retrievedText: undefined, excerptCheck: undefined})).toBe(false)
    })
})

describe('recoverCorpus', () => {
    test('recovers name and version for a package, past a leading banner', () => {
        const c = recoverCorpus(
            '[DEPENDENCY] tower is not declared\n### crates.io: tower\nPer tower@0.5.2:\nx'
        )
        expect(c?.header).toBe('Per tower@0.5.2:')
    })

    test('recovers the project corpus', () => {
        const c = recoverCorpus('Per docs-live-ts (project source):\nx')
        expect(c?.header).toBe('Per docs-live-ts (project source):')
    })

    test('names the ecosystem in the prompt, not just the header', () => {
        const c = recoverCorpus('### hackage: aeson\nPer aeson@2.3.1.0:\nx')
        expect(c?.buildPrompt('q', 'c')).toContain('a Haskell package from Hackage')
    })

    test('returns null on an unknown registry rather than defaulting to npm', () => {
        expect(recoverCorpus('### pypi: requests\nPer requests@2.0:\nx')).toBeNull()
    })

    test('returns null when the tool text carries no identity at all', () => {
        expect(recoverCorpus('some prose')).toBeNull()
    })
})

describe('stripMixedClause', () => {
    const prompt = (): string =>
        recoverCorpus('### npm: zod\nPer zod@4.5.4:\n')!.buildPrompt('q', 'c')

    test('removes exactly the two clause lines', () => {
        const before = prompt()
        const after = stripMixedClause(before)
        expect(before.split('\n').length - after.split('\n').length).toBe(2)
        expect(after).not.toContain('A question with several parts')
    })

    test('leaves the rest of rule 4 standing', () => {
        expect(stripMixedClause(prompt())).toContain('unclear from this package')
    })

    test('throws when production reworded the clause, never silently no-ops', () => {
        expect(() => stripMixedClause('Rules:\n1. Output ONLY two tags\n')).toThrow(
            /wording changed/
        )
    })

    test('matches the clause for the project tag too', () => {
        const p = recoverCorpus('Per proj (project source):\n')!.buildPrompt('q', 'c')
        expect(stripMixedClause(p)).not.toContain('A question with several parts')
    })
})

describe('buildArmPrompt', () => {
    const rec = (): ReplayRecord => parseRecords(line(), 'x.jsonl').records[0]

    test('treatment is production byte for byte', () => {
        const r = rec()
        expect(buildArmPrompt(r, 'treatment')).toBe(r.corpus.buildPrompt(r.query, r.retrievedText))
    })

    test('the arms differ by the clause and nothing else', () => {
        const r = rec()
        const t = buildArmPrompt(r, 'treatment')
        expect(buildArmPrompt(r, 'control')).toBe(stripMixedClause(t))
    })

    test('re-retrieved content replaces the recorded bytes, never joins them', () => {
        const r = rec()
        const p = buildArmPrompt(r, 'treatment', 'FRESHLY RETRIEVED')
        expect(p).toContain('FRESHLY RETRIEVED')
        expect(p).not.toContain(r.retrievedText)
    })
})

describe('retrieveLive', () => {
    test('refuses the project corpus rather than retrieving some other package', async () => {
        const r = parseRecords(line({toolText: 'Per proj (project source):\nunknown'}), 'x.jsonl')
            .records[0]
        expect(r.identity.kind).toBe('project')
        await expect(retrieveLive(r, '/nowhere')).rejects.toThrow(/project corpus/)
    })
})

describe('recoverIdentity', () => {
    test('names the registry as an ecosystem, not as its label', () => {
        expect(recoverIdentity('### crates.io: serde\nPer serde@1.0.228:\n')).toEqual({
            kind: 'package',
            ecosystem: 'cargo',
            name: 'serde',
            version: '1.0.228'
        })
    })
})

describe('parseRecords', () => {
    test('keeps a sound record', () => {
        const {records, skipped} = parseRecords(line(), 'ts.jsonl')
        expect(records.length).toBe(1)
        expect(skipped.length).toBe(0)
        expect(records[0].query).toBe('what does parse return')
    })

    test('skips a pre-defect-9 record with no retrievedText', () => {
        const {skipped} = parseRecords(line({retrievedText: undefined}), 'ts.jsonl')
        expect(skipped[0].reason).toBe('no-retrieved-text')
    })

    test('skips a record whose bytes drifted from the recorded sha', () => {
        const {skipped} = parseRecords(line({retrievedText: 'different'}), 'ts.jsonl')
        expect(skipped[0].reason).toBe('sha-mismatch')
    })

    test('skips a record whose identity cannot be rebuilt', () => {
        const {skipped} = parseRecords(line({toolText: 'no header here'}), 'ts.jsonl')
        expect(skipped[0].reason).toBe('unrecoverable-identity')
    })

    test('carries the live verdict through, so a replay is a delta', () => {
        const {records} = parseRecords(line({unclear: true}), 'ts.jsonl')
        expect(records[0].wasUnclear).toBe(true)
    })
})

describe('tally', () => {
    const row = (over: Partial<ReplayRow>): ReplayRow => ({
        source: 'ts.jsonl',
        module: 'zod',
        query: 'q',
        arm: 'treatment',
        trial: 1,
        ok: true,
        answer: 'a',
        unclear: false,
        excerptVerified: true,
        wasUnclear: false,
        from: 'recorded',
        chunks: 0,
        bytes: 1,
        ...over
    })

    test('splits by what the live run did', () => {
        const [t] = tally([
            row({wasUnclear: true, unclear: true}),
            row({wasUnclear: true, unclear: false}),
            row({wasUnclear: false, unclear: false})
        ])
        expect(t.wasUnclearTotal).toBe(2)
        expect(t.wasUnclearStillUnclear).toBe(1)
        expect(t.wasAnsweredTotal).toBe(1)
        expect(t.wasAnsweredNowUnclear).toBe(0)
    })

    test('a crashed child is counted as failed, never as an answer', () => {
        const [t] = tally([row({ok: false, unclear: false, wasUnclear: true})])
        expect(t.failed).toBe(1)
        expect(t.wasUnclearTotal).toBe(0)
    })

    test('an abstention does not inflate the excerpt rate', () => {
        const [t] = tally([
            row({unclear: true, excerptVerified: true}),
            row({unclear: false, excerptVerified: false})
        ])
        expect(t.excerptChecked).toBe(1)
        expect(t.excerptVerified).toBe(0)
    })

    test('reports only arms that ran', () => {
        expect(tally([row({})]).map(t => t.arm)).toEqual(['treatment'])
    })
})

describe('parseArgs', () => {
    test('defaults to both arms, one trial', () => {
        const o = parseArgs(['a.jsonl'])
        expect(o.arms).toEqual(['treatment', 'control'])
        expect(o.trials).toBe(1)
    })

    test('rejects a run with no corpus', () => {
        expect(() => parseArgs(['--trials', '3'])).toThrow(/at least one/)
    })

    test('rejects an unknown flag rather than treating it as a file', () => {
        expect(() => parseArgs(['--nope', 'a.jsonl'])).toThrow(/unknown flag/)
    })

    test('replays the recorded bytes unless --retrieve names a project', () => {
        expect(parseArgs(['a.jsonl']).retrieve).toBeNull()
        expect(parseArgs(['a.jsonl', '--retrieve', '/run/hs']).retrieve).toBe('/run/hs')
    })

    test('--module narrows to one package', () => {
        expect(parseArgs(['a.jsonl', '--module', 'hspec']).module).toBe('hspec')
    })
})

describe('the recorded corpus in this repo', () => {
    const dirs = ['live-docs-rerun2-2026-09-06', 'live-docs-rerun3-2026-09-06']
    const files = dirs
        .flatMap(d => ['ts', 'rs', 'hs'].map(e => path.join(d, `${e}.jsonl`)))
        .filter(f => fs.existsSync(f))

    test.skipIf(files.length === 0)('every recorded record replays, none skipped', () => {
        const {records, skipped} = loadCorpusFiles(files)
        expect(skipped).toEqual([])
        expect(records.length).toBe(73)
        expect(records.filter(r => r.wasUnclear).length).toBe(24)
    })

    test.skipIf(files.length === 0)('every prompt rebuilds in both arms', () => {
        const {records} = loadCorpusFiles(files)
        for (const r of records) {
            expect(buildArmPrompt(r, 'treatment').length).toBeGreaterThan(0)
            expect(buildArmPrompt(r, 'control').length).toBeLessThan(
                buildArmPrompt(r, 'treatment').length
            )
        }
    })
})
