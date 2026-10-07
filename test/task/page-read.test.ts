/**
 * page-read tests. Each expected text is what Chromium shows for the same page:
 * innerText, or the screen where innerText leaves out a shadow root.
 */
import {describe, expect, test} from 'bun:test'
import {pageText, readDump} from '../../src/task/page-read.js'

describe('pageText reads a raw page as the parser builds it', () => {
    for (const [what, page, shows] of [
        [
            'a block a closed details holds in its table',
            '<details><summary>S</summary><table><div>secret</div></table></details>',
            'S'
        ],
        [
            'text a closed details holds in its table',
            '<details><summary>S</summary><table>secret</table></details>',
            'S'
        ],
        [
            'hidden formatting the adoption agency walks past',
            '<b><i hidden><span><span><span><div>text</b>more</div>',
            'textmore'
        ],
        [
            'a block the adoption agency moves out of a hidden span',
            '<b><span hidden><div>secret</b>more</div>',
            'secretmore'
        ],
        [
            'raw text a shadow root has no slot for',
            '<div><template shadowrootmode=open><slot></slot></template><xmp slot=nope>leak</xmp></div>',
            ''
        ],
        [
            'blocks a named slot takes',
            '<div><template shadowrootmode=open><slot name=a></slot></template><p slot=a>Hello</p><p slot=a>World</p></div>',
            'Hello World'
        ],
        [
            'slots in the shadow root order',
            '<div><template shadowrootmode=open><slot name=b></slot><slot name=a></slot></template><span slot=a>A</span><span slot=b>B</span></div>',
            'BA'
        ],
        [
            'a doctype with text after its system id',
            '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd" junk><p hidden>x<table><tr><td>y</td></tr></table>',
            'y'
        ],
        [
            'text a table moves in front of it',
            '<div><table><tr><td>a</td></tr>b</table></div>',
            'b a'
        ],
        ['a select', 'A<select><option>x<option selected>y</select>B', 'A x y B'],
        ['an option outside a select', 'A<option>x<title>t</title></option>B', 'A xt B'],
        ['a textarea', 'A<textarea>typed</textarea>B', 'AB'],
        ['an svg element named like MathML', '<svg><mi>x</mi></svg>V', 'V'],
        [
            'svg text and its parts',
            '<svg><text>a<tspan>b</tspan><rect>r</rect></text>c</svg>',
            'ab'
        ],
        ['a windows-1252 reference', 'Build &#150; missing', 'Build – missing']
    ] as const) {
        test(`${what} shows what a browser shows`, () => {
            expect(pageText(page)).toBe(shows)
        })
    }

    test('a page with no words gives its title', () => {
        expect(pageText('<title>Build missing</title><div id=root></div>')).toBe('Build missing')
    })
})

describe('readDump reads a dump as Chrome wrote it', () => {
    for (const [what, dom, shows] of [
        [
            'a select',
            '<body>A<select><option>x</option><option>y</option></select>B</body>',
            'A x y B'
        ],
        ['a textarea', '<body>A<textarea>typed</textarea>B</body>', 'AB'],
        ['an svg element named like MathML', '<body><svg><mi>x</mi></svg>V</body>', 'V']
    ] as const) {
        test(`${what} shows what a browser shows`, () => {
            expect(readDump(dom).shown).toBe(shows)
        })
    }

    test('a textarea counts as drawn even with no words', () => {
        expect(readDump('<body><textarea></textarea></body>').tags.has('textarea')).toBe(true)
    })
})
