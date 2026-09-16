import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {formatSpec, parseSpec, sliceSpecSection} from '../../src/task/spec-model.js'
import {
    CLARIFY_QA_POLICY,
    GRILL_QA_POLICY,
    QaTranscript,
    qaKindsFromRecord,
    type QaKind
} from '../../src/task/qa-transcript.js'

/** The 21 `## spec` sections AUTO_0002 actually shipped, copied read-only. */
const FIXTURE = fs.readFileSync(path.join(import.meta.dir, '__fixtures__', 'mx5-specs.md'), 'utf8')

function realSpecs(): Array<{id: string; text: string}> {
    return FIXTURE.split(/^<<<(TASK_\d+)>>>$/m)
        .slice(1)
        .reduce<Array<{id: string; text: string}>>((acc, part, i, all) => {
            if (i % 2 === 0) acc.push({id: part, text: all[i + 1].trim()})
            return acc
        }, [])
}

describe('parseSpec on the 21 real AUTO_0002 specs', () => {
    const specs = realSpecs()

    test('the fixture is the whole run', () => {
        expect(specs).toHaveLength(21)
    })

    for (const {id, text} of specs) {
        test(`${id}: every section is found and nothing is invented`, () => {
            const spec = parseSpec(text)
            expect(spec.goal.length).toBeGreaterThan(0)
            expect(spec.constraints.length).toBeGreaterThan(0)
            expect(spec.acceptance.length).toBeGreaterThan(0)
            expect(spec.verify).toContain('```')
            // Every bullet the parser reports is text the spec actually carries:
            // a parser that folded two bullets into one, or split one in half,
            // fails here rather than quietly changing what a constraint says.
            for (const c of spec.constraints) expect(text).toContain(c.text.split('\n')[0])
            for (const a of spec.acceptance) expect(text).toContain(a.split('\n')[0])
        })

        test(`${id}: round-trips through formatSpec`, () => {
            expect(parseSpec(formatSpec(parseSpec(text)))).toEqual(parseSpec(text))
        })
    }

    test('an untagged real spec is entirely derived — nothing binds by default', () => {
        for (const {text} of specs) {
            const spec = parseSpec(text)
            expect(spec.constraints.every(c => c.provenance === 'derived')).toBe(true)
        }
    })
})

describe('provenance', () => {
    test('a [from: Q<n>] tag resolves to that answer’s kind', () => {
        const kinds: QaKind[] = ['auto', 'typed', 'yolo']
        const spec = parseSpec(
            [
                'GOAL',
                'ship it',
                '',
                'CONSTRAINTS',
                '- do not touch `src/a.ts` [from: Q1]',
                '- keep the export surface [from: Q2]',
                '- prefer the documented adapter [from: Q3]',
                '- tidy the imports [from: spec]',
                '- no new dependencies',
                '',
                'ACCEPTANCE',
                '- it builds',
                '',
                'VERIFY:',
                '```sh',
                'bun run build',
                '```'
            ].join('\n'),
            n => kinds[n - 1] ?? null
        )
        expect(spec.constraints.map(c => c.provenance)).toEqual([
            'auto',
            'typed',
            'yolo',
            'spec',
            'derived'
        ])
        expect(spec.constraints[0].text).toBe('do not touch `src/a.ts`')
    })

    test('a tag naming an answer nobody can produce is derived, not invented', () => {
        const spec = parseSpec('CONSTRAINTS\n- hold the line [from: Q9]', () => null)
        expect(spec.constraints[0].provenance).toBe('derived')
    })

    test('every QaKind survives the record round-trip', () => {
        const all: QaKind[] = ['auto', 'auto-resolved', 'host-set', 'yolo', 'accepted', 'typed']
        // A policy that stamps EVERY kind: each shipped policy stamps only a
        // subset, so neither record carries every suffix.
        const t = new QaTranscript({record: new Set(all), generatorSeesProvenance: false})
        for (const kind of all) t.add(kind, `q ${kind}`, `a ${kind}`)
        expect(qaKindsFromRecord(t.forRecord())).toEqual(all)
    })

    test('yolo-skip reads back as yolo — one stamp, one weight', () => {
        const t = new QaTranscript(CLARIFY_QA_POLICY)
        t.add('yolo-skip', 'q', 'a')
        expect(qaKindsFromRecord(t.forRecord())).toEqual(['yolo'])
    })

    test('an unstamped answer reads as typed', () => {
        // GRILL's policy stamps `auto` but not `accepted`, so a record it wrote
        // cannot distinguish an accepted answer from a typed one — and must not
        // guess one.
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('accepted', 'q1', 'a1')
        t.add('auto', 'q2', 'a2')
        expect(qaKindsFromRecord(t.forRecord())).toEqual(['typed', 'auto'])
    })

    test('Q<n> indices are the same in forRecord and forGenerator', () => {
        const t = new QaTranscript(CLARIFY_QA_POLICY)
        t.add('typed', 'first?', 'one')
        t.add('auto', 'second?', 'two')
        t.add('accepted', 'third?', 'three')
        const numbers = (text: string): string[] => text.match(/^[QA]\d+:/gm) ?? []
        expect(numbers(t.forRecord())).toEqual(numbers(t.forGenerator()))
        expect(numbers(t.forRecord())).toEqual(['Q1:', 'A1:', 'Q2:', 'A2:', 'Q3:', 'A3:'])
    })
})

describe('sliceSpecSection', () => {
    test('runs to the next ## heading and keeps ### subheadings', () => {
        const body = [
            '## raw prompt',
            'do a thing',
            '',
            '## spec',
            'GOAL',
            'ship',
            '### notes',
            'inside',
            '',
            '## phase timings',
            'later'
        ].join('\n')
        expect(sliceSpecSection(body)).toBe('GOAL\nship\n### notes\ninside')
    })

    test('absent or blank section is null', () => {
        expect(sliceSpecSection('## raw prompt\nhi')).toBeNull()
        expect(sliceSpecSection('## spec\n\n\n## gates\nx')).toBeNull()
    })
})
