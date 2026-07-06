import {describe, it, expect} from 'bun:test'
import {renderModule} from './ui-render.js'
import {highlightModule} from './ui-highlight.js'

// renderMarkdown calls syntaxHighlight, so load both modules together and pull out
// whichever function a test needs.
function load<T = (...a: unknown[]) => unknown>(name: string): T {
    const factory = new Function(
        renderModule() + '\n' + highlightModule() + '\n;return ' + name + ';'
    ) as () => T
    return factory()
}
const renderMarkdown = () => load<(t: string) => string>('renderMarkdown')
const renderInline = () => load<(t: string) => string>('renderInline')
const escHtml = () => load<(t: string) => string>('escHtml')

// Unlike ui.test.ts (which only string-matches the template), these tests EXECUTE
// the shipped client JS — the missing test class that let the dead-fence bug ship.
// (The .code-block DOM assertion is covered by the chromium harness --dump-dom
// grep in scripts/remote-preview.ts, which reports the live .code-block count.)
const BT = String.fromCharCode(96)
const FENCE = BT + BT + BT

type Block = {type: string; lang?: string; content: string}

function loadParseBlocks(): (t: string) => Block[] {
    // Eval the exact string the browser receives and hand back parseBlocks.
    const factory = new Function(renderModule() + '\n;return parseBlocks;') as () => (
        t: string
    ) => Block[]
    return factory()
}

describe('parseBlocks (executed client code)', () => {
    it('extracts a fenced code block with its language', () => {
        const parseBlocks = loadParseBlocks()
        const blocks = parseBlocks(`intro line\n${FENCE}ts\nconst x = 1;\n${FENCE}\nafter`)
        expect(blocks).toEqual([
            {type: 'text', content: 'intro line'},
            {type: 'code', lang: 'ts', content: 'const x = 1;'},
            {type: 'text', content: 'after'}
        ])
    })

    it('handles a fence with no language', () => {
        const parseBlocks = loadParseBlocks()
        const blocks = parseBlocks(`${FENCE}\nplain\n${FENCE}`)
        expect(blocks).toEqual([{type: 'code', lang: '', content: 'plain'}])
    })

    it('tolerates an unclosed trailing fence (the regex never could)', () => {
        const parseBlocks = loadParseBlocks()
        const blocks = parseBlocks(`words\n${FENCE}py\nx = 1\ny = 2`)
        expect(blocks).toEqual([
            {type: 'text', content: 'words'},
            {type: 'code', lang: 'py', content: 'x = 1\ny = 2'}
        ])
    })

    it('preserves multi-line code content verbatim', () => {
        const parseBlocks = loadParseBlocks()
        const blocks = parseBlocks(`${FENCE}sh\nbun test\nbun run build\n${FENCE}`)
        expect(blocks[0]).toEqual({type: 'code', lang: 'sh', content: 'bun test\nbun run build'})
    })

    it('returns a single text block when there is no fence', () => {
        const parseBlocks = loadParseBlocks()
        expect(parseBlocks('just prose\nsecond line')).toEqual([
            {type: 'text', content: 'just prose\nsecond line'}
        ])
    })

    it('is null-safe: empty/nullish input yields a single empty text block, never throws', () => {
        const parseBlocks = loadParseBlocks()
        // An empty text block is harmless — setContent skips blocks with no content.
        expect(parseBlocks('')).toEqual([{type: 'text', content: ''}])
        expect(parseBlocks(null as never)).toEqual([{type: 'text', content: ''}])
        expect(parseBlocks(undefined as never)).toEqual([{type: 'text', content: ''}])
    })

    it('separates two adjacent fenced blocks', () => {
        const parseBlocks = loadParseBlocks()
        const blocks = parseBlocks(`${FENCE}ts\na\n${FENCE}\n${FENCE}py\nb\n${FENCE}`)
        expect(blocks.filter(b => b.type === 'code').map(b => b.lang)).toEqual(['ts', 'py'])
    })
})

describe('escHtml', () => {
    it('escapes the three HTML-significant characters', () => {
        expect(escHtml()('<img src=x onerror="y"> & <b>')).toBe(
            '&lt;img src=x onerror="y"&gt; &amp; &lt;b&gt;'
        )
    })
})

describe('renderInline', () => {
    it('renders bold, italic, strikethrough and inline code', () => {
        const r = renderInline()('**b** *i* ~~s~~ `code`')
        expect(r).toContain('<strong>b</strong>')
        expect(r).toContain('<em>i</em>')
        expect(r).toContain('<del>s</del>')
        expect(r).toContain('<code class="md-code">code</code>')
    })

    it('renders links as target=_blank with rel=noopener and escapes text', () => {
        const r = renderInline()('see [the docs](https://x.dev/a?b=1)')
        expect(r).toContain(
            '<a href="https://x.dev/a?b=1" target="_blank" rel="noopener">the docs</a>'
        )
    })

    it('neutralizes a javascript: link scheme', () => {
        const r = renderInline()('[x](javascript:alert(1))')
        expect(r).toContain('href="#"')
        expect(r).not.toContain('javascript:alert')
    })

    it('escapes HTML in plain text so model output cannot inject markup', () => {
        const r = renderInline()('a <script>alert(1)</script> b')
        expect(r).not.toContain('<script>')
        expect(r).toContain('&lt;script&gt;')
    })

    it('does not format emphasis inside an inline code span', () => {
        const r = renderInline()('`a*b*c`')
        expect(r).toContain('<code class="md-code">a*b*c</code>')
        expect(r).not.toContain('<em>')
    })
})

describe('renderMarkdown (block level)', () => {
    it('renders headers, lists, task lists, blockquotes, rules and tables', () => {
        const md = [
            '# Title',
            '',
            '- one',
            '- two',
            '',
            '- [ ] todo',
            '- [x] done',
            '',
            '> a quote',
            '',
            '---',
            '',
            '| a | b |',
            '| --- | --- |',
            '| 1 | 2 |'
        ].join('\n')
        const h = renderMarkdown()(md)
        expect(h).toContain('<h1 class="md-h md-h1">Title</h1>')
        expect(h).toContain('<ul class="md-list">')
        expect(h).toContain('<li>one</li>')
        expect(h).toContain('class="md-task"')
        expect(h).toContain('☐') // unchecked box
        expect(h).toContain('☑') // checked box
        expect(h).toContain('<blockquote class="md-quote">')
        expect(h).toContain('<hr class="md-hr">')
        expect(h).toContain('<table class="md-table">')
        expect(h).toContain('<th>a</th>')
        expect(h).toContain('<td>1</td>')
    })

    it('highlights a fenced code block and escapes its content', () => {
        const h = renderMarkdown()('```ts\nconst x = 1 // <hi>\n```')
        expect(h).toContain('<div class="code-block">')
        expect(h).toContain('<div class="code-head">')
        expect(h).toContain('<div class="code-lang">ts</div>')
        expect(h).toContain('<button class="copy-btn"') // copy button in the header
        expect(h).toContain('hl-kw') // `const` highlighted
        expect(h).toContain('&lt;hi&gt;') // content escaped, no raw tag
        expect(h).not.toContain('<hi>')
    })

    it('renders an ordered list', () => {
        const h = renderMarkdown()('1. first\n2. second')
        expect(h).toContain('<ol class="md-list">')
        expect(h).toContain('<li>first</li>')
    })
})
