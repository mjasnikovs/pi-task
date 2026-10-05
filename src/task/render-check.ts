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
    const page = readPage(html)
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

// pageText and what it calls also run as source in httpAnswer's child: keep them self-contained.

/** The words a reader sees, or the title when nothing else has any. */
function pageText(html: string): string {
    const page = readPage(html)
    return page.shown || page.title
}

/** A page read as a browser tokenizes it: markup, comments, scripts and templates are not shown. */
function readPage(html: string): {shown: string; title: string; tags: Set<string>} {
    const unseen = new Set(['script', 'style', 'noscript', 'iframe', 'noembed', 'noframes'])
    const rawText = new Set([...unseen, 'title', 'textarea', 'xmp'])
    const tagName = /[a-z][^\t\n\f\r />]*/iy
    const tags = new Set<string>()
    let shown = ''
    let title: string | null = null
    let templates = 0
    let at = 0
    const show = (text: string) => {
        if (templates === 0) shown += text
    }
    for (let lt = html.indexOf('<'); lt !== -1; lt = html.indexOf('<', at)) {
        show(html.slice(at, lt))
        at = lt + 1
        if (html.startsWith('!--', at)) {
            at = commentEnd(html, at + 3)
            continue
        }
        const closing = html[at] === '/'
        tagName.lastIndex = closing ? at + 1 : at
        const name = tagName.exec(html)?.[0].toLowerCase()
        if (name === undefined) {
            if (closing || html[at] === '!' || html[at] === '?') {
                const end = html.indexOf('>', at)
                at = end === -1 ? html.length : end + 1
            } else show('<')
            continue
        }
        const end = tagEnd(html, tagName.lastIndex)
        if (end === -1) {
            // A browser drops a tag the page never finishes, and all after it.
            at = html.length
            break
        }
        at = end + 1
        if (name === 'template') {
            templates = Math.max(0, templates + (closing ? -1 : 1))
            continue
        }
        if (!closing && templates === 0) tags.add(name)
        if (closing || !rawText.has(name)) {
            show(' ')
            continue
        }
        // An element never closed holds the rest of the page.
        const closer = new RegExp(`</${name}[\\t\\n\\f\\r />]`, 'gi')
        closer.lastIndex = at
        const found = closer.exec(html)
        const text = html.slice(at, found?.index ?? html.length)
        if (name === 'title') {
            if (templates === 0) title ??= text
        } else if (!unseen.has(name)) show(` ${text} `)
        const closerEnd = found ? tagEnd(html, found.index + name.length + 2) : -1
        at = closerEnd === -1 ? html.length : closerEnd + 1
    }
    show(html.slice(at))
    return {shown: words(shown), title: words(title ?? ''), tags}
}

function words(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/** Where the comment whose text starts at `from` ends, or the page's end when it never does. */
function commentEnd(html: string, from: number): number {
    // `<!-->` and `<!--->` are whole comments.
    if (html[from] === '>') return from + 1
    if (html.startsWith('->', from)) return from + 2
    const closer = /--!?>/g
    closer.lastIndex = from
    return closer.exec(html) === null ? html.length : closer.lastIndex
}

/** Where the tag whose attributes start at `from` ends, or -1 when it never does. */
function tagEnd(html: string, from: number): number {
    const between = /[\t\n\f\r /]*/y
    const attributeName = /[^\t\n\f\r />][^\t\n\f\r />=]*[\t\n\f\r ]*/y
    const valueStart = /=[\t\n\f\r ]*/y
    // Only a value that opens with a quote is quoted: `alt=x="` is one unquoted value.
    const unquoted = /[^\t\n\f\r >]*/y
    const skip = (re: RegExp, at: number) => {
        re.lastIndex = at
        re.exec(html)
        return re.lastIndex
    }
    let at = skip(between, from)
    while (at < html.length && html[at] !== '>') {
        at = skip(attributeName, at)
        if (html[at] === '=') {
            at = skip(valueStart, at)
            const quote = html[at]
            if (quote === '"' || quote === "'") {
                const close = html.indexOf(quote, at + 1)
                if (close === -1) return -1
                at = close + 1
            } else at = skip(unquoted, at)
        }
        at = skip(between, at)
    }
    return at < html.length ? at : -1
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
        `${pageText};${readPage};${words};${commentEnd};${tagEnd};`
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
