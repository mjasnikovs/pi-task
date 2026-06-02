import {describe, expect, test} from 'bun:test'
import {parseFrontMatter, emitFrontMatter, extractSection, normaliseTaskId} from './task-parsers.js'
import type {TaskFrontMatter} from './task-types.js'

describe('parseFrontMatter', () => {
    test('parses a valid block', () => {
        const raw =
            '---\nid: TASK_0001\nstate: in_progress\nphase: refine\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:01Z\ntitle: A title\n---\nbody'
        const fm = parseFrontMatter(raw)
        expect(fm).not.toBeNull()
        expect(fm!.id).toBe('TASK_0001')
        expect(fm!.phase).toBe('refine')
        expect(fm!.title).toBe('A title')
        expect(fm!.reason).toBeUndefined()
    })

    test('returns null when front matter delimiters are absent', () => {
        expect(parseFrontMatter('no delimiters')).toBeNull()
    })

    test('returns null when required key (id) is missing', () => {
        const raw = '---\nstate: pending\nphase: refine\ncreated_at: 2026-01-01T00:00:00Z\n---\n'
        expect(parseFrontMatter(raw)).toBeNull()
    })

    test('returns null on unknown phase', () => {
        const raw =
            '---\nid: TASK_0001\nstate: pending\nphase: bogus\ncreated_at: 2026-01-01T00:00:00Z\n---\n'
        expect(parseFrontMatter(raw)).toBeNull()
    })

    test('reads optional reason field', () => {
        const raw =
            '---\nid: TASK_0001\nstate: failed\nphase: compose\ncreated_at: 2026-01-01T00:00:00Z\nreason: oops\n---\n'
        const fm = parseFrontMatter(raw)
        expect(fm!.reason).toBe('oops')
    })
})

describe('emitFrontMatter', () => {
    test('round-trips a parsed front matter', () => {
        const fm: TaskFrontMatter = {
            id: 'TASK_0042',
            state: 'in_progress',
            phase: 'research',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:01Z',
            title: 'Hello'
        }
        const emitted = emitFrontMatter(fm)
        const round = parseFrontMatter(emitted + '\nbody')
        expect(round).toEqual(fm)
    })

    test('omits reason when undefined or empty', () => {
        const fm: TaskFrontMatter = {
            id: 'TASK_0001',
            state: 'pending',
            phase: 'refine',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            title: 't'
        }
        const emitted = emitFrontMatter(fm)
        expect(emitted).not.toContain('reason:')
    })

    test('emits reason when present', () => {
        const fm: TaskFrontMatter = {
            id: 'TASK_0001',
            state: 'failed',
            phase: 'compose',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            title: 't',
            reason: 'compose_invalid: x'
        }
        const emitted = emitFrontMatter(fm)
        expect(emitted).toContain('reason: compose_invalid: x')
    })
})

describe('sectionRegex / extractSection', () => {
    test('extracts a section between two headers', () => {
        const body = '## first\n\nfoo\n\n## second\n\nbar\n'
        expect(extractSection(body, 'first')).toBe('foo')
        expect(extractSection(body, 'second')).toBe('bar')
    })

    test('extracts the last section (no trailing header)', () => {
        const body = '## first\n\nfoo\n\n## last\n\ntail\n'
        expect(extractSection(body, 'last')).toBe('tail')
    })

    test('returns null when section is absent', () => {
        expect(extractSection('## other\nx\n', 'missing')).toBeNull()
    })

    test('escapes regex metacharacters in heading', () => {
        const body = '## foo (bar)\n\nbody\n'
        expect(extractSection(body, 'foo (bar)')).toBe('body')
    })
})

describe('normaliseTaskId', () => {
    test('passes through canonical TASK_NNNN form', () => {
        expect(normaliseTaskId('TASK_0001')).toBe('TASK_0001')
    })

    test('zero-pads a bare number', () => {
        expect(normaliseTaskId('1')).toBe('TASK_0001')
        expect(normaliseTaskId('42')).toBe('TASK_0042')
    })

    test('trims whitespace before matching', () => {
        expect(normaliseTaskId('  TASK_0001  ')).toBe('TASK_0001')
        expect(normaliseTaskId(' 7 ')).toBe('TASK_0007')
    })

    test('returns input unchanged on non-matching string', () => {
        expect(normaliseTaskId('foo')).toBe('foo')
    })
})
