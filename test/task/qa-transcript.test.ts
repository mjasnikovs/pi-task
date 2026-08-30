import {describe, expect, test} from 'bun:test'
import {
    QaTranscript,
    QA_PROVENANCE,
    GRILL_QA_POLICY,
    CLARIFY_QA_POLICY,
    type QaKind
} from '../../src/task/qa-transcript.js'
import {YOLO_STAMP} from '../../src/task/yolo.js'

const ALL_KINDS: QaKind[] = [
    'auto',
    'auto-resolved',
    'host-set',
    'yolo',
    'yolo-skip',
    'accepted',
    'typed'
]

/**
 * QaTranscript holds the provenance decision as data — a policy object and a
 * suffix per kind — so these read it off the value. The alternative is scripting
 * `runChild` and matching prose in the NEXT grill-gen prompt, which makes prompt
 * copy load-bearing test infrastructure.
 */

describe('QA_PROVENANCE', () => {
    test('every kind declares a suffix', () => {
        expect(Object.keys(QA_PROVENANCE).sort()).toEqual([...ALL_KINDS].sort())
    })

    test("a human's own words are the unmarked baseline", () => {
        expect(QA_PROVENANCE.typed).toBe('')
    })

    test('both YOLO kinds carry the one stamp, not two spellings of it', () => {
        expect(QA_PROVENANCE.yolo).toBe(YOLO_STAMP)
        expect(QA_PROVENANCE['yolo-skip']).toBe(YOLO_STAMP)
    })
})

describe('numbering', () => {
    test('is contiguous and owned by the record, not the caller', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('typed', 'first?', 'one')
        t.add('typed', 'second?', 'two')
        t.add('typed', 'third?', 'three')
        expect(t.forRecord()).toBe(
            ['Q1: first?', 'A1: one', 'Q2: second?', 'A2: two', 'Q3: third?', 'A3: three'].join(
                '\n'
            )
        )
        expect(t.length).toBe(3)
    })

    test('a suppressed duplicate leaves no gap — nothing was added', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('typed', 'a?', '1')
        // (the dup backstop `continue`s without adding)
        t.add('typed', 'b?', '2')
        expect(t.forRecord()).toContain('Q2: b?')
        expect(t.forRecord()).not.toContain('Q3')
    })

    test('an empty transcript renders as the empty string', () => {
        expect(new QaTranscript(GRILL_QA_POLICY).forRecord()).toBe('')
        expect(new QaTranscript(CLARIFY_QA_POLICY).forGenerator()).toBe('')
    })
})

describe('GRILL_QA_POLICY', () => {
    // THE INVARIANT: `forGenerator()` is fed back VERBATIM into the next grill-gen
    // prompt, so any provenance suffix would become model input. Asserted over
    // every kind at once, so a new one cannot be added without meeting it.
    test('the generator sees NO provenance, for any kind', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        for (const kind of ALL_KINDS) t.add(kind, `q-${kind}?`, `a-${kind}`)
        const gen = t.forGenerator()
        for (const suffix of Object.values(QA_PROVENANCE)) {
            if (suffix === '') continue
            expect(gen).not.toContain(suffix)
        }
        expect(gen).not.toContain(YOLO_STAMP)
        expect(GRILL_QA_POLICY.generatorSeesProvenance).toBe(false)
    })

    test('the record marks auto and both YOLO kinds', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('auto', 'q1?', 'from research')
        t.add('yolo', 'q2?', 'took the rec')
        t.add('yolo-skip', 'q3?', '(skipped — no recommendation)')
        const rec = t.forRecord()
        expect(rec).toContain('A1: from research (auto)')
        expect(rec).toContain(`A2: took the rec ${YOLO_STAMP}`)
        expect(rec).toContain(`A3: (skipped — no recommendation) ${YOLO_STAMP}`)
    })

    // A YOLO SKIP is not an answer. It must never render to a model as though the
    // user had answered it.
    test('a YOLO skip stays visibly a skip in both renderings', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('yolo-skip', 'which store?', '(skipped — no recommendation)')
        expect(t.forRecord()).toContain('(skipped —')
        expect(t.forGenerator()).toContain('(skipped —')
    })

    test('a human answer is unmarked in the record too', () => {
        const t = new QaTranscript(GRILL_QA_POLICY)
        t.add('accepted', 'q?', 'use postgres')
        t.add('typed', 'q2?', 'use sqlite')
        expect(t.forRecord()).toBe(
            ['Q1: q?', 'A1: use postgres', 'Q2: q2?', 'A2: use sqlite'].join('\n')
        )
    })
})

describe('CLARIFY_QA_POLICY', () => {
    // The one genuine disagreement between the two dialogs, as a named field: a
    // question the triage already settled must READ as settled to the generator,
    // or it gets re-asked.
    test('the generator DOES see provenance', () => {
        const t = new QaTranscript(CLARIFY_QA_POLICY)
        t.add('auto-resolved', 'which runtime?', 'bun')
        t.add('host-set', 'how many tasks?', 'fine-grained')
        expect(t.forGenerator()).toContain(QA_PROVENANCE['auto-resolved'])
        expect(t.forGenerator()).toContain(QA_PROVENANCE['host-set'])
        expect(CLARIFY_QA_POLICY.generatorSeesProvenance).toBe(true)
    })

    test('record and generator agree, so a settled question cannot read as open', () => {
        const t = new QaTranscript(CLARIFY_QA_POLICY)
        for (const kind of ALL_KINDS) t.add(kind, `q-${kind}?`, `a-${kind}`)
        expect(t.forGenerator()).toBe(t.forRecord())
    })

    test('an accepted recommendation is marked; a typed answer is not', () => {
        const t = new QaTranscript(CLARIFY_QA_POLICY)
        t.add('accepted', 'q?', 'use postgres')
        t.add('typed', 'q2?', 'use sqlite')
        expect(t.forRecord()).toContain('A1: use postgres (accepted recommendation)')
        expect(t.forRecord()).toContain('A2: use sqlite')
        expect(t.forRecord()).not.toContain('A2: use sqlite (')
    })
})
