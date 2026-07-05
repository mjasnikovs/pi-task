import {describe, it, expect} from 'bun:test'
import {renderModule} from './ui-render.js'
import {toolsModule} from './ui-tools.js'

// The tools module depends on escHtml (ui-render.ts); eval both together and pull
// out the requested function.
function load<T>(name: string): T {
    const factory = new Function(
        renderModule() + '\n' + toolsModule() + '\n;return ' + name + ';'
    ) as () => T
    return factory()
}
const toolSummary = load<(n: string, a: unknown) => string>('toolSummary')
const toolBadge =
    load<(n: string, a: unknown) => {added: number; removed: number} | null>('toolBadge')
const toolDiffHtml = load<(n: string, a: unknown) => string | null>('toolDiffHtml')
const fmtElapsed = load<(ms: number | null | undefined) => string>('fmtElapsed')

describe('toolSummary', () => {
    it('renders bash as a shell prompt', () => {
        expect(toolSummary('bash', {command: 'bun test --coverage'})).toBe('$ bun test --coverage')
    })

    it('renders read/edit/write by path (accepts path or file_path)', () => {
        expect(toolSummary('read', {path: 'src/a.ts'})).toBe('read src/a.ts')
        expect(toolSummary('edit', {file_path: 'src/b.ts', old_string: 'a', new_string: 'b'})).toBe(
            'src/b.ts'
        )
        expect(toolSummary('write', {path: 'src/c.ts', content: 'x'})).toBe('src/c.ts')
    })

    it('renders grep with pattern and path', () => {
        expect(toolSummary('grep', {pattern: 'TODO', path: 'src'})).toBe('grep TODO  src')
    })

    it('parses a JSON string args payload', () => {
        expect(toolSummary('bash', '{"command":"ls -la"}')).toBe('$ ls -la')
    })

    it('never hard-slices — a long command survives in full', () => {
        const cmd =
            'bun test src/theme --coverage --reporter=verbose --bail --timeout=60000 --rerun-each=3'
        expect(toolSummary('bash', {command: cmd})).toBe('$ ' + cmd)
    })

    it('falls back to name + JSON for an unknown tool (no crash on odd args)', () => {
        expect(toolSummary('mytool', {a: 1})).toBe('mytool: {"a":1}')
        expect(toolSummary('mytool', undefined)).toBe('mytool')
    })
})

describe('toolBadge / toolDiffHtml', () => {
    it('computes +N −M and a tinted line diff for an edit', () => {
        const args = {path: 'f.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd'}
        expect(toolBadge('edit', args)).toEqual({added: 2, removed: 1})
        const diff = toolDiffHtml('edit', args)!
        expect(diff).toContain('diff-del')
        expect(diff).toContain('diff-add')
        expect(diff).toContain('diff-ctx')
    })

    it('treats a write as an all-added diff', () => {
        expect(toolBadge('write', {path: 'f', content: 'x\ny'})).toEqual({added: 2, removed: 0})
    })

    it('returns null for non-diffable tools', () => {
        expect(toolBadge('read', {path: 'f'})).toBeNull()
        expect(toolDiffHtml('bash', {command: 'ls'})).toBeNull()
    })

    it('escapes diff content (no markup injection)', () => {
        const diff = toolDiffHtml('write', {path: 'f', content: '<b>hi</b>'})!
        expect(diff).toContain('&lt;b&gt;')
        expect(diff).not.toContain('<b>hi</b>')
    })
})

describe('fmtElapsed', () => {
    it('formats sub-second, seconds and nullish', () => {
        expect(fmtElapsed(240)).toBe('240ms')
        expect(fmtElapsed(1500)).toBe('1.5s')
        expect(fmtElapsed(42000)).toBe('42s')
        expect(fmtElapsed(null)).toBe('')
        expect(fmtElapsed(undefined)).toBe('')
    })
})
