/**
 * render-check — one headless-browser page load against the booted app's live
 * listener, judging whether the client actually RENDERED anything.
 *
 * The failure class: every other "renders without runtime errors" check in the
 * pipeline is curl-shaped (boot-probe.ts says so at its own call site), and curl
 * cannot execute JavaScript. An app whose client bundle throws on load answers
 * HTTP 200 on every route and shows a permanently BLANK page, with every such
 * check green. The gate's boot check proves a LISTENER exists; this proves the
 * listener serves a page whose client code MOUNTS something.
 *
 * Mechanism, deterministic and dependency-free: discover a Chrome-family binary
 * (system chromium/chrome or the Playwright browser cache — nothing is installed,
 * only found), load the page once with `--headless --dump-dom` (which executes the
 * page's JS under a virtual-time budget), and judge the RENDERED body: it must
 * contain visible text or concrete visual/interactive elements. A blank mount
 * point after JS ran is the class — FAIL with the body's shape. What it
 * deliberately does NOT judge: whether what rendered is CORRECT. That needs app
 * knowledge no generic gate has.
 *
 * Env-gap contract as everywhere: no browser found, a browser that cannot launch,
 * or a dump that produced nothing → SKIP with a note (the caller surfaces it as
 * UNOBSERVED), never a false FAIL. Only a page the browser really loaded and
 * rendered EMPTY fails.
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readdirSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {clampOutput} from './clamp-output.js'

export type RenderOutcome =
    | {outcome: 'pass'; detail: string}
    | {outcome: 'fail'; detail: string}
    | {outcome: 'skip'; note: string}
    /** The server answered with an error status: worth asking again while it boots. */
    | {outcome: 'unready'; detail: string}

/** PATH names tried in order for a system Chrome-family binary. */
const CHROME_PATH_CANDIDATES = [
    'chromium',
    'chromium-browser',
    'google-chrome-stable',
    'google-chrome',
    'chrome'
]

/** Does `bin` resolve on PATH? (`command -v` shape, portable via spawnSync.) */
function onPath(bin: string): boolean {
    const probe = process.platform === 'win32' ? 'where' : 'which'
    const r = spawnSync(probe, [bin], {encoding: 'utf8', timeout: 4000})
    return !r.error && r.status === 0 && (r.stdout ?? '').trim().length > 0
}

/**
 * The newest Playwright-cache Chromium, if any — the HEADLESS SHELL preferred over
 * the full build. Found, never installed: the cache exists on any box that ever
 * ran Playwright browsers, which many projects install as a test dependency. The
 * headless shell is preferred because it is purpose-built for exactly this — one
 * `--dump-dom` and exit — with no browser UI to bring up.
 */
export function playwrightCachedChromium(): string | null {
    const cache =
        process.env.PLAYWRIGHT_BROWSERS_PATH
        ?? (process.platform === 'darwin' ?
            path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
        :   path.join(os.homedir(), '.cache', 'ms-playwright'))
    let entries: string[]
    try {
        entries = readdirSync(cache)
    } catch {
        return null
    }
    // Headless shell first (fast, purpose-built), then the full chromium build.
    // Within each family the newest revision wins (revs sort ascending → reverse).
    const families: Array<{prefix: string; rels: string[]}> = [
        {
            prefix: 'chromium_headless_shell-',
            rels: [
                path.join('chrome-headless-shell-linux64', 'chrome-headless-shell'),
                path.join('chrome-linux', 'headless_shell')
            ]
        },
        {
            prefix: 'chromium-',
            rels: [path.join('chrome-linux64', 'chrome'), path.join('chrome-linux', 'chrome')]
        }
    ]
    for (const {prefix, rels} of families) {
        const revs = entries.filter(e => e.startsWith(prefix)).sort()
        for (const rev of revs.reverse()) {
            for (const rel of rels) {
                const p = path.join(cache, rev, rel)
                if (existsSync(p)) return p
            }
        }
    }
    return null
}

/**
 * A launchable Chrome-family binary, or null when this box has none: the explicit
 * CHROME_BIN override first, then the Playwright cache (headless shell — reliable
 * on network URLs), then a system browser on PATH as a last resort. Null → the
 * render check SKIPs (env gap) — it never installs anything.
 */
export function findHeadlessBrowser(): string | null {
    const explicit = process.env.CHROME_BIN
    if (explicit && existsSync(explicit)) return explicit
    const cached = playwrightCachedChromium()
    if (cached) return cached
    for (const bin of CHROME_PATH_CANDIDATES) {
        if (onPath(bin)) return bin
    }
    return null
}

/** Elements whose presence means the page rendered CONCRETE UI even with no text. */
const VISUAL_ELEMENTS = new Set([
    'img',
    'svg',
    'canvas',
    'video',
    'audio',
    'input',
    'button',
    'textarea',
    'select',
    'iframe'
])

/**
 * Judge a RENDERED (post-JS) DOM: the body must carry visible text or concrete
 * visual/interactive elements. Pure text analysis so the judgment is unit-tested
 * against real captured DOMs; `detail` describes what was (or wasn't) found.
 */
export function judgeRenderedDom(html: string): {ok: boolean; detail: string} {
    const page = readPage(html, true)
    if (page.shown.length > 0) {
        return {ok: true, detail: `rendered visible text ("${page.shown.slice(0, 80)}")`}
    }
    if ([...VISUAL_ELEMENTS].some(tag => page.tags.has(tag))) {
        return {ok: true, detail: 'rendered visual/interactive elements (no text)'}
    }
    return {
        ok: false,
        detail:
            'the rendered body is EMPTY after client JS executed — no visible text, no '
            + 'visual or interactive elements (the blank-page class: HTTP serves, nothing mounts)'
    }
}

// pageText and readPage also run as source in httpAnswer's child: readPage holds its own helpers.

/** The words a reader sees in a raw page, or the title when nothing else has any. */
function pageText(html: string): string {
    const page = readPage(html, false)
    return page.shown || page.title
}

/**
 * A page read as a browser builds it. Markup, comments, scripts, templates and
 * what the browser's own stylesheet hides are not shown. A `dumped` page is a DOM
 * Chrome serialized: it closes every element itself and holds no shadow roots, so
 * the parser's own closing rules would misplace what a script nested.
 */
function readPage(
    html: string,
    dumped: boolean
): {shown: string; title: string; tags: Set<string>} {
    const unseen = new Set(['script', 'style', 'noscript', 'iframe', 'noembed', 'noframes'])
    const rawText = new Set([...unseen, 'title', 'textarea', 'xmp'])
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
    const closesP = new Set([
        'address',
        'article',
        'aside',
        'blockquote',
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
        'li',
        'listing',
        'main',
        'menu',
        'nav',
        'ol',
        'p',
        'plaintext',
        'pre',
        'search',
        'section',
        'summary',
        'table',
        'ul',
        'xmp'
    ])
    // Each starts a line, so the words either side of one do not run together.
    const blocks = new Set([
        ...closesP,
        'body',
        'br',
        'caption',
        'html',
        'optgroup',
        'option',
        'tbody',
        'td',
        'text',
        'tfoot',
        'th',
        'thead',
        'tr'
    ])
    // Boundaries only as SVG or MathML elements: an HTML <mi> is no boundary.
    const foreignBounds = new Set([
        'annotation-xml',
        'desc',
        'foreignobject',
        'mi',
        'mn',
        'mo',
        'ms',
        'mtext',
        'title'
    ])
    // Where the parser stops looking for an open element to close.
    const scope = new Set([
        ...foreignBounds,
        'applet',
        'caption',
        'html',
        'marquee',
        'object',
        'table',
        'td',
        'th'
    ])
    const buttonScope = new Set([...scope, 'button'])
    const listScope = new Set([...scope, 'ol', 'ul'])
    const tableScope = new Set(['html', 'table'])
    const special = new Set([
        ...[...closesP].filter(name => name !== 'dialog'),
        ...scope,
        'button',
        'colgroup',
        'frameset',
        'select',
        'tbody',
        'tfoot',
        'thead',
        'tr'
    ])
    const itemScope = new Set([...special].filter(name => !['address', 'div', 'p'].includes(name)))
    const scopes = [scope, buttonScope, listScope, tableScope, itemScope, special]
    const headings = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
    const tableSections = new Set(['tbody', 'tfoot', 'thead'])
    // Where the parser moves content out in front of the table.
    const fosters = new Set(['table', 'tbody', 'tfoot', 'thead', 'tr'])
    const tableParts = new Set([...tableSections, 'caption', 'col', 'colgroup', 'td', 'th', 'tr'])
    const formatting = new Set([
        'a',
        'b',
        'big',
        'code',
        'em',
        'font',
        'i',
        'nobr',
        's',
        'small',
        'strike',
        'strong',
        'tt',
        'u'
    ])
    // Formatting a parent left open does not carry into these.
    const markers = new Set(['applet', 'caption', 'marquee', 'object', 'td', 'th'])
    // The start tags that do not reopen formatting a block end cut off.
    const keepsFormattingShut = new Set([
        ...[...closesP].filter(name => name !== 'xmp'),
        'base',
        'basefont',
        'bgsound',
        'body',
        'caption',
        'col',
        'colgroup',
        'frame',
        'frameset',
        'head',
        'html',
        'iframe',
        'link',
        'meta',
        'noembed',
        'noframes',
        'noscript',
        'param',
        'rb',
        'rp',
        'rt',
        'rtc',
        'script',
        'source',
        'style',
        'tbody',
        'td',
        'textarea',
        'tfoot',
        'th',
        'thead',
        'title',
        'tr',
        'track'
    ])
    const shadowHosts = new Set([
        'article',
        'aside',
        'blockquote',
        'div',
        'footer',
        ...headings,
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
    const leavesForeign = new Set([
        'b',
        'big',
        'blockquote',
        'body',
        'br',
        'center',
        'code',
        'dd',
        'div',
        'dl',
        'dt',
        'em',
        'embed',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'head',
        'hr',
        'i',
        'img',
        'li',
        'listing',
        'menu',
        'meta',
        'nobr',
        'ol',
        'p',
        'pre',
        'ruby',
        's',
        'small',
        'span',
        'strike',
        'strong',
        'sub',
        'sup',
        'table',
        'tt',
        'u',
        'ul',
        'var'
    ])
    const foreignUnseen = new Set(['desc', 'script', 'style', 'title'])
    const integrationPoints = new Set([
        'desc',
        'foreignobject',
        'mi',
        'mn',
        'mo',
        'ms',
        'mtext',
        'title'
    ])
    // SVG draws text only in <text>, MathML only in its token elements.
    const drawsText = new Set(['foreignobject', 'mi', 'mn', 'mo', 'ms', 'mtext', 'text'])
    const svgText = new Set(['a', 'text', 'textpath', 'tspan'])
    const inSvgText = new Set(['a', 'textpath', 'tspan'])
    // The public ids the spec renders in quirks mode, where a table leaves a p open.
    const quirkyPublicId = new RegExp(
        '^(?:'
            + [
                String.raw`\+//silmaril//dtd html pro v0r11 19970101//`,
                String.raw`-//(?:advasoft ltd|as)//dtd html 3\.0 aswedit \+ extensions//`,
                String.raw`-//ietf//dtd html(?: 2\.0(?: strict)?(?: level [12])?| 2\.1e| 3\.0| 3\.2(?: final)?| 3|(?: strict)? level [0-3]| strict)?//`,
                String.raw`-//metrius//dtd metrius presentational//`,
                String.raw`-//microsoft//dtd internet explorer [23]\.0 (?:html strict|html|tables)//`,
                String.raw`-//netscape comm\. corp\.//dtd (?:strict )?html//`,
                String.raw`-//o'reilly and associates//dtd html (?:2\.0|extended 1\.0|extended relaxed 1\.0)//`,
                String.raw`-//sq//dtd html 2\.0 hotmetal \+ extensions//`,
                String.raw`-//softquad software//dtd hotmetal pro 6\.0::19990601::extensions to html 4\.0//`,
                String.raw`-//softquad//dtd hotmetal pro 4\.0::19971010::extensions to html 4\.0//`,
                String.raw`-//spyglass//dtd html 2\.0 extended//`,
                String.raw`-//sun microsystems corp\.//dtd hotjava (?:strict )?html//`,
                String.raw`-//w3c//dtd html (?:3 1995-03-24|3\.2 draft|3\.2 final|3\.2|3\.2s draft|4\.0 frameset|4\.0 transitional|experimental 19960712|experimental 970421)//`,
                String.raw`-//w3c//dtd w3 html//`,
                String.raw`-//w3o//dtd w3 html 3\.0//`,
                String.raw`-//webtechs//dtd mozilla html(?: 2\.0)?//`,
                String.raw`-//w3o//dtd w3 html strict 3\.0//en//$`,
                String.raw`-/w3c/dtd html 4\.0 transitional/en$`,
                'html$'
            ].join('|')
            + ')'
    )
    const quirkyWithoutSystemId = /^-\/\/w3c\/\/dtd html 4\.01 (?:frameset|transitional)\/\//
    const doctypeStart = /doctype/iy
    const doctype =
        /doctype[\t\n\f\r ]*([^\t\n\f\r >]*)(?:[\t\n\f\r ]+(?:public[\t\n\f\r ]*(?:"([^">]*)"|'([^'>]*)')(?:[\t\n\f\r ]*(?:"([^">]*)"|'([^'>]*)'))?|system[\t\n\f\r ]*(?:"([^">]*)"|'([^'>]*)')))?[\t\n\f\r ]*>/iy
    const nonSpace = /[^\t\n\f\r ]/
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
    // The named references a serializer writes. Any other is a word either way.
    const reference =
        /&(?:#(\d+);?|#[xX]([\da-fA-F]+);?|(amp|AMP|lt|LT|gt|GT|quot|QUOT|nbsp);?|apos;)/g
    const named: Record<string, string> = {amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' '}
    const attributes = {
        hidden: false,
        open: false,
        shadowRootMode: '',
        type: '',
        slot: undefined as string | undefined,
        name: '',
        selfClosing: false
    }

    const skip = (re: RegExp, from: number) => {
        re.lastIndex = from
        re.exec(html)
        return re.lastIndex
    }

    /** Where the tag whose attributes start at `from` ends, or -1 when it never does. Fills `attributes`. */
    function tagEnd(from: number): number {
        attributes.hidden = attributes.open = false
        attributes.type = attributes.shadowRootMode = attributes.name = ''
        attributes.slot = undefined
        let gap = from
        let at = skip(between, from)
        while (at < html.length && html[at] !== '>') {
            const nameEnd = skip(attributeName, at)
            const name = html.slice(at, nameEnd).toLowerCase()
            if (name === 'hidden') attributes.hidden = true
            else if (name === 'open') attributes.open = true
            else if (name === 'slot') attributes.slot = ''
            at = skip(space, nameEnd)
            if (html[at] === '=') {
                at = skip(valueStart, at)
                const quote = html[at]
                let value: string
                if (quote === '"' || quote === "'") {
                    const close = html.indexOf(quote, at + 1)
                    if (close === -1) return -1
                    value = html.slice(at + 1, close)
                    at = close + 1
                } else {
                    const valueAt = at
                    at = skip(unquoted, at)
                    value = html.slice(valueAt, at)
                }
                if (name === 'type') attributes.type = value.toLowerCase()
                else if (name === 'shadowrootmode') attributes.shadowRootMode = value.toLowerCase()
                else if (name === 'slot') attributes.slot = value
                else if (name === 'name') attributes.name = value
            }
            gap = at
            at = skip(between, at)
        }
        attributes.selfClosing = at > gap && html[at - 1] === '/'
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

    /** Whether the doctype at `from` puts the page in quirks mode, or undefined when it is no doctype. */
    function quirkyDoctype(from: number): boolean | undefined {
        doctypeStart.lastIndex = from
        if (!doctypeStart.test(html)) return undefined
        doctype.lastIndex = from
        const id = doctype.exec(html)
        if (id === null || id[1]!.toLowerCase() !== 'html') return true
        const publicId = (id[2] ?? id[3])?.toLowerCase()
        const systemId = (id[4] ?? id[5] ?? id[6] ?? id[7])?.toLowerCase()
        if (systemId === 'http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd') return true
        if (publicId === undefined) return false
        return (
            quirkyPublicId.test(publicId)
            || (systemId === undefined && quirkyWithoutSystemId.test(publicId))
        )
    }

    // The spec reads &#128; to &#159; as windows-1252, as the pages that write them mean.
    const windows1252 = '€\x81‚ƒ„…†‡ˆ‰Š‹Œ\x8dŽ\x8f' + '\x90‘’“”•–—˜™š›œ\x9džŸ'
    const character = (code: number) =>
        code >= 0x80 && code <= 0x9f ? windows1252[code - 0x80]!
        : code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ?
            String.fromCodePoint(code)
        :   '�'
    const decode = (text: string) =>
        text.includes('&') ?
            text.replace(reference, (ref, decimal?: string, hex?: string, name?: string) =>
                name ? named[name.toLowerCase()]!
                : ref === '&apos;' ? "'"
                : character(decimal ? Number(decimal) : parseInt(hex!, 16))
            )
        :   text

    type Slots = {fallback: boolean; named: Set<string>}
    type Open = {
        name: string
        foreign: boolean
        /** A foreign element draws its text only inside <text>, foreignObject or a MathML token. */
        draws: boolean
        hidden: boolean
        hides: boolean
        /** How much it adds to `hiding` while it is open. */
        weight: number
        /** `hiding` where it opened. */
        hidingBefore: number
        visible: boolean
        /** On the stack. An element the parser took out of the middle stays in the array, dead. */
        live: boolean
        index: number
        /** In its fragment's list of formatting to reopen. */
        listed: boolean
        closedDetails: boolean
        summarized: boolean
        shadowHost: boolean
        /** The slots of its shadow root, once the root is closed. */
        slots: Slots | undefined
        slot: string | undefined
        /** Where its text starts in `shown`. */
        shownAt: number
        /** Its children that named a slot before its shadow root came. */
        slotted: Array<{name: string; from: number; to: number}> | undefined
        /** Clones the adoption agency put right under it, ahead of its open children. */
        adopted: Open[] | undefined
    }
    /** A document or a template's content: end tags in one never close elements in the other. */
    type Fragment = {
        stack: Open[]
        /** Where each open name sits in the stack, innermost last. Dead entries are dropped on read. */
        positions: Map<string, number[]>
        /** Where each scope's boundaries sit in the stack, innermost last. */
        bounds: Map<Set<string>, number[]>
        /** Formatting the parser reopens after a block end cut it off. Null is a cell's boundary. */
        formatting: Array<Open | null>
        /** The element a shadow root attached to. A template without one is inert. */
        host: Open | undefined
        start: number
        slots: Slots
    }
    const fragment = (host?: Open): Fragment => ({
        stack: [],
        positions: new Map(),
        bounds: new Map(scopes.map(names => [names, []])),
        formatting: [],
        host,
        start: shown.length,
        slots: {fallback: false, named: new Set()}
    })
    let shown = ''
    const fragments = [fragment()]
    let current = fragments[0]!
    const tags = new Set<string>()
    // Light content a shadow root shows no slot for: ranges of `shown` to drop.
    const cuts: Array<[number, number]> = []
    let quirks: boolean | undefined = dumped ? false : undefined
    let pageHidden = false
    let inert = 0
    let hiding = 0
    let title: string | null = null
    let at = 0
    const top = () => current.stack.at(-1)
    const show = (text: string) => {
        const node = top()
        if (inert === 0 && hiding === 0 && !node?.closedDetails && (!node?.foreign || node.draws))
            shown += text
    }
    const inForeign = () => {
        const node = top()
        return node !== undefined && node.foreign && !integrationPoints.has(node.name)
    }
    /** Whether the browser's own stylesheet hides the element just opened. */
    const hiddenByBrowser = (name: string, foreign: boolean) =>
        foreign ?
            foreignUnseen.has(name)
        :   attributes.hidden
            || (name === 'dialog' && !attributes.open)
            || (name === 'input' && attributes.type === 'hidden')
            || name === 'datalist'
    const stops = (node: Open, names: Set<string>) =>
        names.has(node.name) && node.foreign === foreignBounds.has(node.name)
    const fills = (slots: Slots, slot: string | undefined) =>
        slot ? slots.named.has(slot) : slots.fallback

    function element(
        name: string,
        foreign: boolean,
        hidden: boolean,
        hides: boolean,
        slot: string | undefined,
        parent = top()
    ): Open {
        if (parent?.closedDetails) {
            // A closed details shows its first summary only.
            if (name === 'summary' && !parent.summarized) parent.summarized = true
            else hides = true
        }
        if (
            foreign
            && parent?.foreign
            && parent.draws
            && svgText.has(parent.name)
            && !inSvgText.has(name)
        )
            hides = true
        let weight = hides ? 1 : 0
        const slots = parent?.slots
        // The host's light content hides as a whole; a child a slot takes shows.
        if (slots !== undefined && fills(slots, slot) !== slots.fallback)
            weight += slots.fallback ? 1 : -1
        return {
            name,
            foreign,
            draws:
                foreign
                && name !== 'svg'
                && name !== 'math'
                && (drawsText.has(name) || (parent?.foreign === true && parent.draws)),
            hidden,
            hides,
            weight,
            hidingBefore: 0,
            visible: inert === 0 && hiding === 0 && !hides,
            live: false,
            index: -1,
            listed: false,
            closedDetails: name === 'details' && !foreign && !attributes.open,
            summarized: false,
            shadowHost: false,
            slots: undefined,
            slot,
            shownAt: 0,
            slotted: undefined,
            adopted: undefined
        }
    }

    function push(node: Open) {
        const {stack, positions, bounds} = current
        node.index = stack.length
        node.live = true
        node.shownAt = shown.length
        let ofName = positions.get(node.name)
        if (ofName === undefined) positions.set(node.name, (ofName = []))
        ofName.push(node.index)
        for (const [names, edges] of bounds) if (stops(node, names)) edges.push(node.index)
        stack.push(node)
        node.hidingBefore = hiding
        hiding += node.weight
    }

    /** Takes the top entry off the stack, with no side effect of the element ending. */
    function pop(): Open {
        const {stack, positions, bounds} = current
        const node = stack.pop()!
        const ofName = positions.get(node.name)!
        if (ofName.at(-1) === stack.length) ofName.pop()
        for (const [names, edges] of bounds)
            if (stops(node, names) && edges.at(-1) === stack.length) edges.pop()
        if (node.live) remove(node)
        for (const clone of node.adopted ?? []) if (clone.live) remove(clone)
        node.adopted = undefined
        return node
    }

    function remove(node: Open) {
        node.live = false
        hiding -= node.weight
    }

    function popTo(position: number) {
        const {stack} = current
        while (stack.length > position || stack.at(-1)?.live === false) {
            const node = stack.at(-1)!
            const ended = node.live
            pop()
            if (!ended || dumped) continue
            if (markers.has(node.name) && !node.foreign) clearToMarker()
            const parent = stack[node.index - 1]
            if (node.slot && parent !== undefined && !parent.shadowHost)
                (parent.slotted ??= []).push({
                    name: node.slot,
                    from: node.shownAt,
                    to: shown.length
                })
        }
    }
    const popTop = () => popTo(current.stack.length - 1)

    /** Where the innermost open `name` sits, if no boundary of `names` stands above it. */
    function reach(name: string, names: Set<string>): number {
        const {stack, positions, bounds} = current
        const ofName = positions.get(name)
        while (ofName?.length && !stack[ofName.at(-1)!]!.live) ofName.pop()
        const position = ofName?.at(-1) ?? -1
        const bound = bounds.get(names)!.at(-1) ?? -1
        return position !== -1 && position >= bound ? position : -1
    }
    const closeOpen = (name: string, names: Set<string>) => {
        const position = reach(name, names)
        if (position !== -1) popTo(position)
    }
    function innermost(names: Iterable<string>, within: Set<string>): number {
        let position = -1
        for (const name of names) position = Math.max(position, reach(name, within))
        return position
    }

    function list(node: Open) {
        const entries = current.formatting
        let twins = 0
        // The spec keeps three alike after the last boundary. Only `hidden` tells two apart here.
        for (let i = entries.length - 1; i >= 0 && entries[i] !== null; i--) {
            const entry = entries[i]!
            if (entry.name === node.name && entry.hidden === node.hidden && ++twins === 3) {
                unlist(i)
                break
            }
        }
        entries.push(node)
        node.listed = true
    }
    function unlist(index: number) {
        current.formatting[index]!.listed = false
        current.formatting.splice(index, 1)
    }
    function listed(name: string): number {
        const entries = current.formatting
        for (let i = entries.length - 1; i >= 0 && entries[i] !== null; i--)
            if (entries[i]!.name === name) return i
        return -1
    }
    function clearToMarker() {
        for (let entry = current.formatting.pop(); entry; entry = current.formatting.pop())
            entry.listed = false
    }

    /** Reopens the formatting a block end cut off, as the parser does before content. */
    function reconstruct() {
        const entries = current.formatting
        let i = entries.length
        while (i > 0 && entries[i - 1] !== null && !entries[i - 1]!.live) i--
        for (; i < entries.length; i++) {
            const {name, hidden} = entries[i]!
            const clone = element(name, false, hidden, hidden, undefined)
            const table = fosterTable()
            if (table !== undefined) foster(clone, table)
            push(clone)
            entries[i]!.listed = false
            entries[i] = clone
            clone.listed = true
        }
    }

    /** The adoption agency: false when `name`'s end tag is left to the generic rule. */
    function adopt(name: string): boolean {
        const {stack} = current
        const entries = current.formatting
        if (top()?.name === name && !top()!.listed) {
            popTop()
            return true
        }
        for (let round = 0; round < 8; round++) {
            const entry = listed(name)
            if (entry === -1) return round > 0
            const formatter = entries[entry]!
            if (!formatter.live) {
                unlist(entry)
                return true
            }
            if ((current.bounds.get(scope)!.at(-1) ?? -1) > formatter.index) return true
            let block = Math.floor(formatter.index) + 1
            while (block < stack.length && !(stack[block]!.live && stops(stack[block]!, special)))
                block++
            if (block === stack.length) {
                popTo(Math.ceil(formatter.index))
                if (formatter.live) remove(formatter)
                unlist(entry)
                return true
            }
            let kept = 0
            for (let i = block - 1; i > formatter.index; i--) {
                const node = stack[i]!
                if (!node.live) continue
                if (node.listed && ++kept > 3) unlist(current.formatting.lastIndexOf(node))
                if (!node.listed) remove(node)
            }
            remove(formatter)
            // The spec moves the clone to a bookmark in the list. Visibility never depends on that order.
            const clone = element(
                name,
                false,
                formatter.hidden,
                formatter.hidden,
                undefined,
                stack[block]
            )
            formatter.listed = false
            entries[current.formatting.lastIndexOf(formatter)] = clone
            clone.listed = true
            if (block === stack.length - 1) push(clone)
            else {
                // Splicing it into the array would cost every element above: it waits on the block instead.
                clone.index = block + 0.5
                clone.live = true
                hiding += clone.weight
                ;(stack[block]!.adopted ??= []).push(clone)
            }
        }
        return true
    }

    /** False when the parser drops a table part outside any table. */
    function enterTable(name: string): boolean {
        const table = reach('table', tableScope)
        if (table === -1) return fragments.length > 1
        if (name === 'col' && top()?.name === 'colgroup') return true
        const context =
            name === 'td' || name === 'th' ? ['tr', ...tableSections]
            : name === 'tr' ? tableSections
            : []
        popTo(Math.max(table, innermost(context, tableScope)) + 1)
        return true
    }

    /** Applies what the parser implies when `name` opens on a raw page. False: it drops the tag. */
    function startTag(name: string): boolean {
        if (top()?.name === 'colgroup' && name !== 'col') popTop()
        if (tableParts.has(name)) return enterTable(name)
        if (name === 'table' ? !quirks : closesP.has(name)) closeOpen('p', buttonScope)
        if (name === 'li') closeOpen('li', itemScope)
        else if (name === 'dd' || name === 'dt') {
            const item = innermost(['dd', 'dt'], itemScope)
            if (item !== -1) popTo(item)
        } else if (headings.has(name) && headings.has(top()?.name ?? '')) popTop()
        else if (name === 'option' || name === 'optgroup') {
            if (top()?.name === 'option') popTop()
            if (name === 'optgroup' && top()?.name === 'optgroup') popTop()
        } else if (name === 'button') closeOpen('button', scope)
        else if (name === 'table') {
            const table = reach('table', tableScope)
            if (table > innermost(['caption', 'td', 'th'], tableScope)) popTo(table)
        } else if (name === 'a' && listed('a') !== -1) {
            const anchor = current.formatting[listed('a')]!
            adopt('a')
            if (anchor.listed) unlist(current.formatting.lastIndexOf(anchor))
            if (anchor.live) remove(anchor)
            popTo(current.stack.length)
        }
        if (!keepsFormattingShut.has(name)) reconstruct()
        if (name === 'nobr' && reach('nobr', scope) !== -1) {
            adopt('nobr')
            reconstruct()
        }
        return true
    }

    function closeTag(name: string) {
        // The parser keeps body and html open to the end: text after them is still theirs.
        if (name === 'html' || name === 'head' || name === 'body') return
        if (!dumped && formatting.has(name) && !top()?.foreign && adopt(name)) return
        const names =
            name === 'p' ? buttonScope
            : name === 'li' ? listScope
            : tableParts.has(name) || name === 'table' ? tableScope
            : special.has(name) || top()?.foreign ? scope
            : special
        const position = headings.has(name) ? innermost(headings, scope) : reach(name, names)
        if (position === -1) {
            // A stray </p> leaves an empty paragraph behind.
            if (name === 'br' || name === 'p') show(' ')
            return
        }
        const node = current.stack[position]!
        popTo(position)
        if (node.visible && blocks.has(name)) shown += ' '
    }

    function openTemplate() {
        const host = top()
        const mode = attributes.shadowRootMode
        // A dump holds no shadow roots: a template still in one was never attached.
        const attaches =
            !dumped
            && (mode === 'open' || mode === 'closed')
            && host !== undefined
            && !host.foreign
            && !host.shadowHost
            && (shadowHosts.has(host.name)
                || (host.name.includes('-') && !reservedNames.has(host.name)))
        if (attaches) host.shadowHost = true
        else inert++
        fragments.push((current = fragment(attaches ? host : undefined)))
    }

    function closeTemplate() {
        popTo(0)
        const {host, start, slots} = fragments.pop()!
        current = fragments.at(-1)!
        if (host === undefined) {
            inert--
            return
        }
        host.slots = slots
        const drop = (from: number, to: number, slot?: string) => {
            if (to > from && !fills(slots, slot)) cuts.push([from, to])
        }
        let from = host.shownAt
        for (const child of host.slotted ?? []) {
            drop(from, child.from)
            drop(child.from, child.to, child.name)
            from = child.to
        }
        drop(from, start)
        if (!slots.fallback) {
            host.weight++
            hiding++
        }
    }

    /** The table that raw content opening here is moved in front of. */
    function fosterTable(): Open | undefined {
        const node = top()
        return !dumped && node !== undefined && !node.foreign && fosters.has(node.name) ?
                current.stack[reach('table', tableScope)]
            :   undefined
    }
    /** Shows `node` as the table's parent shows it, not as the table does. */
    function foster(node: Open, table: Open) {
        node.weight -= hiding - table.hidingBefore
        node.visible = inert === 0 && table.hidingBefore === 0 && !node.hides
    }

    function characters(raw: string) {
        if (raw.length === 0) return
        if (!dumped) {
            const words = nonSpace.test(raw)
            if (words) {
                quirks ??= true
                if (top()?.name === 'colgroup') popTop()
            }
            // Spaces between table rows stay in the table, with no formatting reopened.
            if (!inForeign() && (words || fosterTable() === undefined)) reconstruct()
            const table = words ? fosterTable() : undefined
            if (table !== undefined) {
                if (inert === 0 && table.hidingBefore === 0) shown += decode(raw)
                return
            }
        }
        show(decode(raw))
    }

    for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', at)) {
        characters(html.slice(at, lt))
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
                if (html[at] === '!' && quirks === undefined) quirks = quirkyDoctype(at + 1)
                const end = html.indexOf('>', at)
                at = end === -1 ? html.length : end + 1
            } else characters('<')
            continue
        }
        const end = tagEnd(tagName.lastIndex)
        if (end === -1) {
            // A browser drops a tag the page never finishes, and all after it.
            at = html.length
            break
        }
        at = end + 1
        quirks ??= true
        // A dump holds what a script built: an HTML element inside an svg stays there.
        if (
            !dumped
            && inForeign()
            && (closing ? name === 'p' || name === 'br' : leavesForeign.has(name))
        )
            while (inForeign()) popTop()
        const foreign = name === 'svg' || name === 'math' || inForeign()
        if (name === 'template' && !foreign) {
            if (!closing) openTemplate()
            else if (fragments.length > 1) closeTemplate()
            continue
        }
        if (closing) {
            closeTag(name)
            continue
        }
        const parsed = !dumped && !inForeign()
        if (parsed && !startTag(name)) continue
        if ((name === 'html' || name === 'body') && !foreign && fragments.length === 1)
            pageHidden ||= attributes.hidden
        const hides = hiddenByBrowser(name, foreign)
        const node = element(name, foreign, attributes.hidden, hides, attributes.slot)
        const table =
            parsed && !tableParts.has(name) && name !== 'table' ? fosterTable() : undefined
        if (table !== undefined) foster(node, table)
        if (node.visible) {
            tags.add(name)
            if (blocks.has(name)) shown += ' '
        }
        if (!foreign && rawText.has(name)) {
            const close = rawTextEnd(name, at)
            const text = html.slice(at, close === -1 ? html.length : close)
            if (name === 'title') {
                if (inert === 0) title ??= decode(text)
            } else if (node.visible && !unseen.has(name))
                shown += ` ${name === 'xmp' ? text : decode(text)} `
            const closerEnd = close === -1 ? -1 : tagEnd(close + name.length + 2)
            at = closerEnd === -1 ? html.length : closerEnd + 1
            continue
        }
        if (name === 'slot' && current.host !== undefined) {
            if (attributes.name) current.slots.named.add(attributes.name)
            else current.slots.fallback = true
        }
        const childless = foreign ? attributes.selfClosing : voids.has(name)
        if (childless || name === 'html' || name === 'head' || name === 'body') continue
        push(node)
        if (parsed && formatting.has(name)) list(node)
        if (parsed && markers.has(name)) current.formatting.push(null)
    }
    characters(html.slice(at))
    const words = (text: string) => text.replace(/\s+/g, ' ').trim()
    if (pageHidden) return {shown: '', title: words(title ?? ''), tags: new Set()}
    let kept = shown
    if (cuts.length > 0) {
        cuts.sort((a, b) => a[0] - b[0])
        kept = ''
        let from = 0
        for (const [start, end] of cuts) {
            if (start > from) kept += shown.slice(from, start)
            from = Math.max(from, end)
        }
        kept += shown.slice(from)
    }
    return {shown: words(kept), title: words(title ?? ''), tags}
}

/** Wall-clock cap for the whole browser run; virtual-time budget for the page JS. */
const RENDER_TIMEOUT_MS = 30_000
const VIRTUAL_TIME_BUDGET_MS = 8_000

/**
 * A Chrome console line on stderr, as chrome-headless-shell writes it:
 *
 *     [0830/084427.287122:INFO:CONSOLE:1] "Uncaught ReferenceError: process is
 *         not defined", source: http://127.0.0.1:8791/boom.html (1)
 *
 * Only the severity and the message survive. The bracketed timestamp prefix — some
 * builds prepend a pid/tid pair too, which is why the prefix is matched loosely —
 * is DROPPED on purpose: it changes every run, and the failure detail is the string
 * `normalizeFailureDetail` (final-gate-progress.ts) compares across autofix
 * attempts. A volatile prefix in there would make two runs of the SAME defect look
 * different, silently changing the non-progress classifier's behaviour.
 */
const CONSOLE_LINE_RE = /^\[[^\]]*:(INFO|WARNING|ERROR|VERBOSE\d*):CONSOLE:\d*\]\s*(.*)$/

/** At most this many console lines ride along; the whole block is clamped again. */
const MAX_CONSOLE_LINES = 12

/**
 * The page's console output, as captured while the DOM was being rendered.
 *
 * `--enable-logging=stderr --v=0` is what routes the page's console to stderr.
 * The DOM the judge reads is untouched by those flags: with and without them,
 * `--dump-dom` writes byte-identical stdout on both binaries this probe can
 * discover.
 */
export function parseConsoleLines(stderr: string): string[] {
    const out: string[] = []
    for (const raw of stderr.split('\n')) {
        const m = CONSOLE_LINE_RE.exec(raw.trim())
        if (!m) continue
        const text = m[2]!.trim()
        if (text.length === 0) continue
        const line = `${m[1]!.toLowerCase()}: ${text}`
        if (!out.includes(line)) out.push(line)
        if (out.length >= MAX_CONSOLE_LINES) break
    }
    return out
}

/**
 * Append the console output to a FAIL detail — and to nothing else.
 *
 * Without it the fix child is told "the body is EMPTY" and nothing more, while the
 * probe was holding the cause the whole time: the page's own
 * `Uncaught ReferenceError`, with the source file and line Chrome already printed.
 *
 * Strictly additive by construction: it takes an existing FAIL detail and returns
 * it with text appended. It cannot turn a PASS into a FAIL, cannot reach
 * `judgeRenderedDom`, and returns the detail unchanged when the page logged
 * nothing.
 */
export function withConsoleEvidence(detail: string, stderr: string): string {
    const lines = parseConsoleLines(stderr)
    if (lines.length === 0) return detail
    return `${detail} — console output during the load: ${clampOutput(lines.join(' | '))}`
}

const EXCERPT_LENGTH = 120

/**
 * The root's HTTP answer: its status, plus a short text excerpt of the body when
 * the status is a server error and `excerpt` is wanted. Null when nothing answered
 * within `budgetMs`. The body of a healthy answer is never read: a root that streams
 * must not hold the probe. Spawned rather than awaited because the caller is
 * synchronous.
 */
export function httpAnswer(
    url: string,
    budgetMs = RENDER_TIMEOUT_MS,
    {excerpt = true}: {excerpt?: boolean} = {}
): {status: number; text: string} | null {
    // The status line is written before the body is read: a body that stalls until
    // the timeout kills the child must not take the status with it. The excerpt is
    // cut in the child, because process.exit drops the unflushed tail of a long write.
    const script =
        `${pageText};${readPage};`
        + `fetch(${JSON.stringify(url)}).then(async r => {`
        + `process.stdout.write(r.status + '\\n');`
        + (excerpt ?
            `if (r.status >= 500) process.stdout.write(pageText(await r.text()).slice(0, ${EXCERPT_LENGTH}));`
        :   '')
        + `}, () => {}).then(() => process.exit(0))`
    const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: budgetMs})
    const out = r.stdout ?? ''
    const newline = out.indexOf('\n')
    if (newline <= 0) return null
    const status = Number(out.slice(0, newline))
    if (!Number.isInteger(status)) return null
    return {status, text: out.slice(newline + 1)}
}

/**
 * Load `url` once in a headless Chrome and judge the rendered DOM. Blocking
 * (spawnSync) by design — the caller holds the booted server alive exactly for
 * this window. `browser` is injectable for tests; the default is discovery.
 *
 * The status is asked first: `--dump-dom` hides it, and an error page has text
 * (mx5-n's "Client build missing" 503 was judged a rendered app). It needs no
 * browser, so a box without one still sees it. Both steps share one budget.
 */
export function runRenderCheck(url: string, browser?: string | null): RenderOutcome {
    const started = Date.now()
    if (/^https?:/i.test(url)) {
        const answer = httpAnswer(url, RENDER_TIMEOUT_MS)
        if (answer !== null && answer.status >= 500) {
            const text = answer.text ? ` ("${answer.text}")` : ''
            return {
                outcome: 'unready',
                detail: `answered HTTP ${answer.status}${text} — an error response, not a rendered app`
            }
        }
    }
    const bin = browser === undefined ? findHeadlessBrowser() : browser
    if (!bin) {
        return {
            outcome: 'skip',
            note: 'no headless Chrome-family browser found on this box (PATH, CHROME_BIN, Playwright cache)'
        }
    }
    const budgetLeft = RENDER_TIMEOUT_MS - (Date.now() - started)
    if (budgetLeft <= 0) {
        return {outcome: 'skip', note: 'the page sent no answer within the render timeout'}
    }
    const r = spawnSync(
        bin,
        [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
            // Route the page's console to stderr. stdout — the DOM the judge
            // reads — is byte-identical with and without these; see
            // parseConsoleLines.
            '--enable-logging=stderr',
            '--v=0',
            '--dump-dom',
            url
        ],
        {encoding: 'utf8', timeout: budgetLeft, env: {...process.env}}
    )
    if (r.error || r.status === null) {
        return {outcome: 'skip', note: `browser did not run (${r.error?.message ?? 'timeout'})`}
    }
    const dom = (r.stdout ?? '').trim()
    if (r.status !== 0 || dom.length === 0) {
        // A crash/empty dump is a browser/env condition on this box, not proof the
        // app is blank — skip with the tail so the trail explains it.
        const tail = (r.stderr ?? '').trim().slice(-200)
        return {
            outcome: 'skip',
            note: `browser exited ${r.status} with no DOM${tail ? ` — ${tail}` : ''}`
        }
    }
    const judged = judgeRenderedDom(dom)
    // The verdict is the judge's, unchanged. Only a FAIL grows: it carries the
    // console output the probe already had at the moment it judged.
    return judged.ok ?
            {outcome: 'pass', detail: judged.detail}
        :   {outcome: 'fail', detail: withConsoleEvidence(judged.detail, r.stderr ?? '')}
}
