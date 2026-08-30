import {describe, expect, test} from 'bun:test'
import {
    PLAN_TOOLS,
    formatReadOnlyViolation,
    isEmptyChange,
    newTreeChanges
} from '../../src/task/plan-readonly.js'
import type {TreeChangeSummary} from '../../src/task/write-guard.js'

const empty: TreeChangeSummary = {modified: [], added: [], deleted: []}

describe('PLAN_TOOLS', () => {
    // plan-orchestrator.ts passes this constant as the planning children's `tools`,
    // so it IS the prevention half of the read-only contract. Widening it would end
    // that silently, which is why the value is pinned here rather than described.
    test('is exactly one tool, and that tool is read', () => {
        expect(PLAN_TOOLS).toBe('read')
    })

    test('names nothing that can write, run, or delete', () => {
        for (const t of PLAN_TOOLS.split(',')) {
            expect(['edit', 'write', 'bash', 'apply_patch', 'multiedit']).not.toContain(t)
        }
    })
})

describe('newTreeChanges', () => {
    test('a tree that was already dirty is not a violation', () => {
        const dirty: TreeChangeSummary = {
            modified: ['src/a.ts'],
            added: ['scratch.ts'],
            deleted: ['old.ts']
        }
        expect(isEmptyChange(newTreeChanges(dirty, dirty))).toBe(true)
    })

    test('reports only what appeared after the snapshot', () => {
        const before: TreeChangeSummary = {modified: ['src/a.ts'], added: [], deleted: []}
        const after: TreeChangeSummary = {
            modified: ['src/a.ts', 'src/b.ts'],
            added: ['NOTES.md'],
            deleted: ['gone.ts']
        }
        expect(newTreeChanges(before, after)).toEqual({
            modified: ['src/b.ts'],
            added: ['NOTES.md'],
            deleted: ['gone.ts']
        })
    })

    test('a file that stopped being changed is not reported', () => {
        const before: TreeChangeSummary = {modified: ['src/a.ts'], added: [], deleted: []}
        expect(isEmptyChange(newTreeChanges(before, empty))).toBe(true)
    })

    test('an untouched tree stays empty', () => {
        expect(isEmptyChange(newTreeChanges(empty, empty))).toBe(true)
    })
})

describe('formatReadOnlyViolation', () => {
    test('names the step and every path it touched', () => {
        const line = formatReadOnlyViolation('plan-question', {
            modified: ['src/a.ts'],
            added: ['NOTES.md'],
            deleted: ['gone.ts']
        })
        expect(line).toContain('read-only')
        expect(line).toContain('plan-question')
        expect(line).toContain('created NOTES.md')
        expect(line).toContain('modified src/a.ts')
        expect(line).toContain('deleted gone.ts')
    })
})
