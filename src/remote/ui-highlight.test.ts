import {describe, it, expect} from 'bun:test'
import {renderModule} from './ui-render.js'
import {highlightModule} from './ui-highlight.js'

// syntaxHighlight depends on escHtml (ui-render.ts); eval both together.
function loadHighlight(): (code: string, lang: string) => string {
    const factory = new Function(
        renderModule() + '\n' + highlightModule() + '\n;return syntaxHighlight;'
    ) as () => (code: string, lang: string) => string
    return factory()
}

describe('syntaxHighlight (executed client code)', () => {
    const hl = loadHighlight()

    it('highlights TypeScript keywords, strings and comments', () => {
        const out = hl('const s = "hi" // note', 'ts')
        expect(out).toContain('<span class="hl-kw">const</span>')
        expect(out).toContain('<span class="hl-str">"hi"</span>')
        expect(out).toContain('<span class="hl-cmt">// note</span>')
    })

    it('highlights Python (hash comments, def keyword, triple-quoted strings)', () => {
        const out = hl('def f():\n    """doc"""\n    return 1  # done', 'python')
        expect(out).toContain('<span class="hl-kw">def</span>')
        expect(out).toContain('<span class="hl-str">"""doc"""</span>')
        expect(out).toContain('<span class="hl-cmt"># done</span>')
        expect(out).toContain('<span class="hl-num">1</span>')
    })

    it('highlights shell with # comments', () => {
        const out = hl('echo hi # comment', 'sh')
        expect(out).toContain('<span class="hl-kw">echo</span>')
        expect(out).toContain('<span class="hl-cmt"># comment</span>')
    })

    it('treats SQL keywords case-insensitively', () => {
        const out = hl('select * from t', 'sql')
        expect(out).toContain('<span class="hl-kw">select</span>')
        expect(out).toContain('<span class="hl-kw">from</span>')
    })

    it('highlights JSON literals', () => {
        const out = hl('{"a": true, "b": 3}', 'json')
        expect(out).toContain('<span class="hl-str">"a"</span>')
        expect(out).toContain('<span class="hl-kw">true</span>')
        expect(out).toContain('<span class="hl-num">3</span>')
    })

    it('highlights HTML tag names', () => {
        const out = hl('<div class="x">hi</div>', 'html')
        expect(out).toContain('<span class="hl-kw">div</span>')
        // The literal markup is escaped, never emitted as a real tag.
        expect(out).toContain('&lt;')
        expect(out).not.toContain('<div class="x">')
    })

    it('resolves aliases (jsx→js, py→python, bash→sh, rs→rust)', () => {
        expect(hl('const x = 1', 'jsx')).toContain('hl-kw')
        expect(hl('def f(): pass', 'py')).toContain('hl-kw')
        expect(hl('for x in y; do :; done', 'bash')).toContain('hl-kw')
        expect(hl('fn main() {}', 'rs')).toContain('hl-kw')
    })

    it('falls back to escaped plain text for unknown languages', () => {
        const out = hl('a < b && c > d', 'brainfuck')
        expect(out).toBe('a &lt; b &amp;&amp; c &gt; d')
    })
})
