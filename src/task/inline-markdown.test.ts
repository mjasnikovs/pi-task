import {describe, expect, test} from 'bun:test'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'

// Stub theme that marks where styling would be applied, so we can assert spans
// are routed through bold()/fg('mdCode') rather than left as literal markers.
const stubTheme = {
    bold: (t: string) => `<b>${t}</b>`,
    fg: (_color: 'mdCode', t: string) => `<code>${t}</code>`
}

describe('renderInlineMarkdown', () => {
    test('routes **bold** through theme.bold and `code` through theme.fg(mdCode)', () => {
        expect(renderInlineMarkdown('**What transport?** use `Bun.serve`', stubTheme)).toBe(
            '<b>What transport?</b> use <code>Bun.serve</code>'
        )
    })

    test('drops stray/unbalanced markers rather than showing them literally', () => {
        expect(renderInlineMarkdown('**leading only and a stray ` tick', stubTheme)).toBe(
            'leading only and a stray  tick'
        )
    })

    test('leaves plain text untouched', () => {
        expect(renderInlineMarkdown('just a plain question?', stubTheme)).toBe(
            'just a plain question?'
        )
    })

    test('leaves underscores (identifiers like __dirname) untouched', () => {
        expect(renderInlineMarkdown('use __dirname here', stubTheme)).toBe('use __dirname here')
    })
})

describe('stripInlineMarkdown', () => {
    test('removes bold and code spans, keeping the inner text', () => {
        expect(stripInlineMarkdown('**Native WebSockets** via `Bun.serve`')).toBe(
            'Native WebSockets via Bun.serve'
        )
    })

    test('removes stray/unbalanced markers', () => {
        expect(stripInlineMarkdown('**leading only and a stray ` tick')).toBe(
            'leading only and a stray  tick'
        )
    })

    test('leaves underscores untouched', () => {
        expect(stripInlineMarkdown('use __dirname in Bun')).toBe('use __dirname in Bun')
    })
})
