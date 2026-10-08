/**
 * The words a reader sees on a page. A raw page is parsed by parse5, which runs the
 * spec's tree builder: every hand-written rule for implied ends, misnested
 * formatting and table content once fell short of Chromium in some new way.
 *
 * A dumped page is different. It is a DOM Chrome serialized, and a script can build
 * a DOM the parser never would (a div in a hidden p, a div in math). Parsing a dump
 * would move such content out and pass a blank page, so a dump is rebuilt exactly
 * as written. It holds no shadow roots: a template left in one never attached.
 */
import {
    type DefaultTreeAdapterTypes as Dom,
    defaultTreeAdapter as tree,
    html as spec,
    parse
} from 'parse5'

const {HTML, SVG, MATHML} = spec.NS

export type Page = {shown: string; tags: Set<string>}

/** The words a reader sees in a raw page, or its title when nothing else has any. */
export function pageText(html: string): string {
    const root = parse(html)
    return read(root, true).shown || words(titleOf(root))
}

/** What a page Chrome dumped after its scripts ran shows. */
export function readDump(html: string): Page {
    return read(buildDump(html), false)
}

// Each starts a line, so the words either side of one do not run together.
const blocks = new Set([
    'address',
    'article',
    'aside',
    'blockquote',
    'body',
    'br',
    'caption',
    'center',
    'dd',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hgroup',
    'hr',
    'html',
    'legend',
    'li',
    'listing',
    'main',
    'menu',
    'nav',
    'ol',
    'optgroup',
    'option',
    'p',
    'plaintext',
    'pre',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'ul',
    'xmp'
])
/** What the browser's own stylesheet hides, or never renders as text. */
const unseen = new Set([
    'datalist',
    'head',
    'noembed',
    'noframes',
    'noscript',
    'rp',
    'script',
    'style',
    'template',
    'title'
])
/** Shown on screen, but nothing inside them is page text. */
const textless = new Set(['audio', 'canvas', 'iframe', 'meter', 'progress', 'textarea', 'video'])
const shadowHosts = new Set([
    'article',
    'aside',
    'blockquote',
    'div',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'main',
    'nav',
    'p',
    'section',
    'span'
])
const reservedNames = new Set([
    'annotation-xml',
    'color-profile',
    'font-face',
    'font-face-format',
    'font-face-name',
    'font-face-src',
    'font-face-uri',
    'missing-glyph'
])
const svgUnseen = new Set(['desc', 'script', 'style', 'title'])
// SVG draws text only in <text>, MathML only in its token elements.
const svgDraws = new Set(['foreignobject', 'text'])
const mathTokens = new Set(['mi', 'mn', 'mo', 'ms', 'mtext'])
const inSvgText = new Set(['a', 'textpath', 'tspan'])

const attribute = (element: Dom.Element, name: string) =>
    element.attrs.find(attr => attr.name === name)?.value
const isHtml = (node: Dom.Node, name: string): node is Dom.Element =>
    tree.isElementNode(node) && node.tagName === name && node.namespaceURI === HTML
const isTemplate = (node: Dom.Node): node is Dom.Template => isHtml(node, 'template')
const childrenOf = (node: Dom.Node): Dom.ChildNode[] =>
    'childNodes' in node ? node.childNodes : []

/** Where the parser attached a declarative shadow root, its template. */
function shadowRootOf(host: Dom.Element): Dom.Template | undefined {
    const name = host.tagName
    const canHost =
        shadowHosts.has(name)
        || (/^[a-z]/.test(name) && name.includes('-') && !reservedNames.has(name))
    if (!canHost) return undefined
    return host.childNodes.find((child): child is Dom.Template => {
        const mode = isHtml(child, 'template') && attribute(child, 'shadowrootmode')
        return mode === 'open' || mode === 'closed'
    })
}

/** Stacks `nodes` so they pop in document order. */
function later(pending: Dom.Node[], nodes: Dom.Node[]) {
    for (let i = nodes.length - 1; i >= 0; i--) pending.push(nodes[i]!)
}

type Scope = {assigned: Map<Dom.Node, Dom.ChildNode[]>; outer: Scope | undefined}

/** Gives each slot of the shadow root the host's children that name it. */
function assignSlots(host: Dom.Element, root: Dom.Template, outer: Scope | undefined): Scope {
    const slots = new Map<string, Dom.Node>()
    const pending: Dom.Node[] = []
    later(pending, root.content.childNodes)
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (isHtml(node, 'slot')) {
            const name = attribute(node, 'name') ?? ''
            if (!slots.has(name)) slots.set(name, node)
        }
        later(pending, childrenOf(node))
    }
    const assigned = new Map<Dom.Node, Dom.ChildNode[]>()
    for (const child of host.childNodes) {
        if (child === root) continue
        const name =
            tree.isTextNode(child) ? ''
            : tree.isElementNode(child) ? (attribute(child, 'slot') ?? '')
            : undefined
        const slot = name === undefined ? undefined : slots.get(name)
        if (slot === undefined) continue
        const nodes = assigned.get(slot)
        if (nodes === undefined) assigned.set(slot, [child])
        else nodes.push(child)
    }
    return {assigned, outer}
}

/** Every word under `top` but a script's, hidden or not: an option's text, a title's. */
function textUnder(top: Dom.Node): string {
    let text = ''
    const pending = [top]
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (tree.isTextNode(node)) text += node.value
        else if (!isHtml(node, 'script')) later(pending, childrenOf(node))
    }
    return text
}

/** The options of a select, as innerText lists them: every one, hidden or not. */
function optionsOf(select: Dom.Element): Dom.Element[] {
    const options: Dom.Element[] = []
    const pending: Dom.Node[] = []
    later(pending, select.childNodes)
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (isHtml(node, 'option')) options.push(node)
        else if (!isHtml(node, 'select')) later(pending, childrenOf(node))
    }
    return options
}

/** The page's first HTML title, as `document.title` reads it. */
function titleOf(root: Dom.Node): string {
    const pending = [root]
    for (let node = pending.pop(); node; node = pending.pop()) {
        if (isHtml(node, 'title')) return textUnder(node)
        later(pending, childrenOf(node))
    }
    return ''
}

const words = (text: string) => text.replace(/\s+/g, ' ').trim()

type Visit = {
    node: Dom.Node
    /** Its parent is SVG or MathML. */
    foreign: boolean
    /** A foreign parent that draws its text. */
    draws: boolean
    /** Its parent is an SVG <text>, or a part of one. */
    svgText: boolean
    scope: Scope | undefined
    /** The end of a block: words after it start a new line. */
    end: boolean
}

function read(root: Dom.Node, shadows: boolean): Page {
    let shown = ''
    const tags = new Set<string>()
    const visits: Visit[] = []
    const visit = (
        nodes: Dom.Node[],
        foreign: boolean,
        draws: boolean,
        svgText: boolean,
        scope: Scope | undefined
    ) => {
        for (let i = nodes.length - 1; i >= 0; i--)
            visits.push({node: nodes[i]!, foreign, draws, svgText, scope, end: false})
    }
    visit([root], false, true, false, undefined)
    for (let next = visits.pop(); next; next = visits.pop()) {
        const {node, scope} = next
        if (next.end) shown += ' '
        else if (tree.isTextNode(node)) {
            if (!next.foreign || next.draws) shown += node.value
        } else if (!tree.isElementNode(node)) visit(childrenOf(node), false, true, false, scope)
        else if (node.namespaceURI === HTML) {
            const name = node.tagName
            const hidden =
                unseen.has(name)
                || attribute(node, 'hidden') !== undefined
                // A popover shows only once a script opens it, and the open state is never written.
                || attribute(node, 'popover') !== undefined
                || (name === 'dialog' && attribute(node, 'open') === undefined)
                || (name === 'input' && attribute(node, 'type')?.toLowerCase() === 'hidden')
            if (hidden) continue
            tags.add(name)
            if (textless.has(name)) continue
            if (name === 'select' || name === 'option') {
                for (const option of name === 'option' ? [node] : optionsOf(node))
                    shown += ` ${textUnder(option)} `
                continue
            }
            let children: Dom.Node[] = node.childNodes
            let inner = scope
            const shadow = shadows ? shadowRootOf(node) : undefined
            if (shadow !== undefined) {
                inner = assignSlots(node, shadow, scope)
                children = shadow.content.childNodes
            } else if (name === 'slot' && scope?.assigned.has(node)) {
                children = scope.assigned.get(node)!
                inner = scope.outer
            } else if (name === 'details' && attribute(node, 'open') === undefined) {
                // A closed details shows its first summary only.
                const summary = children.find(child => isHtml(child, 'summary'))
                children = summary === undefined ? [] : [summary]
            }
            if (blocks.has(name)) {
                shown += ' '
                visits.push({...next, end: true})
            }
            visit(children, false, true, false, inner)
        } else {
            const name = node.tagName.toLowerCase()
            const svg = node.namespaceURI === SVG
            if (svg && (svgUnseen.has(name) || (next.svgText && !inSvgText.has(name)))) continue
            tags.add(name)
            const draws =
                (next.foreign && next.draws) || (svg ? svgDraws.has(name) : mathTokens.has(name))
            if (svg && name === 'text') {
                shown += ' '
                visits.push({...next, end: true})
            }
            visit(
                node.childNodes,
                true,
                draws,
                svg && (name === 'text' || (next.svgText && inSvgText.has(name))),
                scope
            )
        }
    }
    return {shown: words(shown), tags}
}

const voids = new Set([
    'area',
    'base',
    'basefont',
    'bgsound',
    'br',
    'col',
    'embed',
    'frame',
    'hr',
    'img',
    'input',
    'keygen',
    'link',
    'meta',
    'param',
    'source',
    'track',
    'wbr'
])
// Their content runs to their own end tag.
const rawText = new Set([
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'plaintext',
    'script',
    'style',
    'textarea',
    'title',
    'xmp'
])
const escapedText = new Set(['textarea', 'title'])
const tagName = /[a-z][^\t\n\f\r />]*/iy
const between = /[\t\n\f\r /]*/y
const attributeName = /[^\t\n\f\r />][^\t\n\f\r />=]*/y
const space = /[\t\n\f\r ]*/y
const valueStart = /=[\t\n\f\r ]*/y
// Only a value that opens with a quote is quoted: `alt=x="` is one unquoted value.
const unquoted = /[^\t\n\f\r >]*/y
const commentCloser = /--!?>/g
const scriptSyntax = /<!--|-->|<(\/?)script[\t\n\f\r />]/gi
const closers = new Map<string, RegExp>()
const reference = /&(?:#(\d+);?|#[xX]([\da-fA-F]+);?|(amp|AMP|lt|LT|gt|GT|quot|QUOT|nbsp);?|apos;)/g
const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', nbsp: '\u00a0'}
// The spec reads &#128; to &#159; as windows-1252, as the pages that write them mean.
const windows1252 =
    '\u20ac\x81\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\x8d\u017d\x8f'
    + '\x90\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\x9d\u017e\u0178'
const character = (code: number) =>
    code >= 0x80 && code <= 0x9f ? windows1252[code - 0x80]!
    : code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code)
    : '\ufffd'
const decode = (text: string) =>
    text.includes('&') ?
        text.replace(reference, (ref, decimal?: string, hex?: string, name?: string) =>
            name ? named[name.toLowerCase()]!
            : ref === '&apos;' ? "'"
            : character(decimal ? Number(decimal) : parseInt(hex!, 16))
        )
    :   text

/** A dump as Chrome wrote it: every element is closed where the serializer closed it. */
function buildDump(html: string): Dom.Document {
    const root = tree.createDocument()
    const open: Dom.Element[] = []
    /** Where each open name sits in `open`, innermost last. */
    const positions = new Map<string, number[]>()
    let selfClosing = false
    const skip = (re: RegExp, from: number) => {
        re.lastIndex = from
        re.exec(html)
        return re.lastIndex
    }
    const into = (): Dom.ParentNode => {
        const element = open.at(-1)
        return (
            element === undefined ? root
            : isTemplate(element) ? tree.getTemplateContent(element)
            : element
        )
    }
    const text = (value: string) => {
        if (value.length > 0) tree.insertText(into(), value)
    }

    /** Where the tag whose attributes start at `from` ends, or -1 when it never does. */
    function tagEnd(from: number, attrs: Array<{name: string; value: string}>): number {
        let gap = from
        let at = skip(between, from)
        while (at < html.length && html[at] !== '>') {
            const nameEnd = skip(attributeName, at)
            const name = html.slice(at, nameEnd).toLowerCase()
            let value = ''
            at = skip(space, nameEnd)
            if (html[at] === '=') {
                at = skip(valueStart, at)
                const quote = html[at]
                if (quote === '"' || quote === "'") {
                    const quoteEnd = html.indexOf(quote, at + 1)
                    if (quoteEnd === -1) return -1
                    value = html.slice(at + 1, quoteEnd)
                    at = quoteEnd + 1
                } else {
                    const valueAt = at
                    at = skip(unquoted, at)
                    value = html.slice(valueAt, at)
                }
            }
            if (!attrs.some(attr => attr.name === name)) attrs.push({name, value: decode(value)})
            gap = at
            at = skip(between, at)
        }
        selfClosing = at > gap && html[at - 1] === '/'
        return at < html.length ? at : -1
    }

    /** Where the comment whose text starts at `from` ends, or the page's end when it never does. */
    function commentEnd(from: number): number {
        // `<!-->` and `<!--->` are whole comments.
        if (html[from] === '>') return from + 1
        if (html.startsWith('->', from)) return from + 2
        commentCloser.lastIndex = from
        return commentCloser.exec(html) === null ? html.length : commentCloser.lastIndex
    }

    /** Where the closer of the raw text that starts at `from` begins, or -1 when it never does. */
    function rawTextEnd(name: string, from: number): number {
        if (name === 'script') return scriptEnd(from)
        let closer = closers.get(name)
        if (closer === undefined) {
            closer = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')
            closers.set(name, closer)
        }
        closer.lastIndex = from
        return closer.exec(html)?.index ?? -1
    }

    // In `<!--<script>`, a </script> stays text until the comment's own </script>.
    function scriptEnd(from: number): number {
        let escaped = false
        let nested = false
        scriptSyntax.lastIndex = from
        for (let token = scriptSyntax.exec(html); token !== null; token = scriptSyntax.exec(html)) {
            if (token[0] === '<!--') {
                escaped = true
                // `<!-->` opens and closes at once.
                scriptSyntax.lastIndex = token.index + 2
            } else if (token[0] === '-->') escaped = nested = false
            else if (token[1] === '/') {
                if (!nested) return token.index
                nested = false
            } else if (escaped) nested = true
        }
        return -1
    }

    function close(name: string) {
        const position = positions.get(name)?.at(-1)
        if (position === undefined) return
        while (open.length > position) positions.get(open.pop()!.tagName)!.pop()
    }

    /** An element's namespace, which the serializer does not write: a child takes its parent's. */
    function namespaceOf(name: string, parent: Dom.Element | undefined): spec.NS {
        if (name === 'svg') return SVG
        if (name === 'math') return MATHML
        if (parent?.namespaceURI === SVG) return parent.tagName === 'foreignobject' ? HTML : SVG
        if (parent?.namespaceURI === MATHML) return mathTokens.has(parent.tagName) ? HTML : MATHML
        return HTML
    }

    let at = 0
    for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', at)) {
        text(decode(html.slice(at, lt)))
        at = lt + 1
        if (html.startsWith('!--', at)) {
            at = commentEnd(at + 3)
            continue
        }
        const closing = html[at] === '/'
        tagName.lastIndex = closing ? at + 1 : at
        const name = tagName.exec(html)?.[0].toLowerCase()
        if (name === undefined) {
            if (closing || html[at] === '!' || html[at] === '?') {
                const end = html.indexOf('>', at)
                at = end === -1 ? html.length : end + 1
            } else text('<')
            continue
        }
        const attrs: Array<{name: string; value: string}> = []
        const end = tagEnd(tagName.lastIndex, attrs)
        // A browser drops a tag the page never finishes, and all after it.
        if (end === -1) return root
        at = end + 1
        if (closing) {
            close(name)
            continue
        }
        const namespaceURI = namespaceOf(name, open.at(-1))
        const node = tree.createElement(name, namespaceURI, attrs)
        if (isTemplate(node)) tree.setTemplateContent(node, tree.createDocumentFragment())
        tree.appendChild(into(), node)
        if (namespaceURI !== HTML ? selfClosing : voids.has(name)) continue
        if (namespaceURI === HTML && rawText.has(name)) {
            const contentEnd = rawTextEnd(name, at)
            const content = html.slice(at, contentEnd === -1 ? html.length : contentEnd)
            if (content.length > 0)
                tree.insertText(node, escapedText.has(name) ? decode(content) : content)
            const closerEnd = contentEnd === -1 ? -1 : tagEnd(contentEnd + name.length + 2, [])
            at = closerEnd === -1 ? html.length : closerEnd + 1
            continue
        }
        let ofName = positions.get(name)
        if (ofName === undefined) positions.set(name, (ofName = []))
        ofName.push(open.length)
        open.push(node)
    }
    text(decode(html.slice(at)))
    return root
}
