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
const VISUAL_ELEMENT_RE = /<(?:img|svg|canvas|video|audio|input|button|textarea|select|iframe)\b/i

/**
 * Judge a RENDERED (post-JS) DOM: the body must carry visible text or concrete
 * visual/interactive elements. Pure text analysis so the judgment is unit-tested
 * against real captured DOMs; `detail` describes what was (or wasn't) found.
 */
export function judgeRenderedDom(html: string): {ok: boolean; detail: string} {
    const bodyMatch = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)
    // No <body> at all in a dumped DOM → the browser rendered something degenerate;
    // judge the whole document rather than fail on shape.
    const body = bodyMatch ? bodyMatch[1] : html
    const visible = body
        .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
    const text = visible
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    if (text.length > 0) {
        return {ok: true, detail: `rendered visible text ("${text.slice(0, 80)}")`}
    }
    if (VISUAL_ELEMENT_RE.test(visible)) {
        return {ok: true, detail: 'rendered visual/interactive elements (no text)'}
    }
    return {
        ok: false,
        detail:
            'the rendered body is EMPTY after client JS executed — no visible text, no '
            + 'visual or interactive elements (the blank-page class: HTTP serves, nothing mounts)'
    }
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

/**
 * Load `url` once in a headless Chrome and judge the rendered DOM. Blocking
 * (spawnSync) by design — the caller holds the booted server alive exactly for
 * this window. `browser` is injectable for tests; the default is discovery.
 */
export function runRenderCheck(url: string, browser?: string | null): RenderOutcome {
    const bin = browser === undefined ? findHeadlessBrowser() : browser
    if (!bin) {
        return {
            outcome: 'skip',
            note: 'no headless Chrome-family browser found on this box (PATH, CHROME_BIN, Playwright cache)'
        }
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
        {encoding: 'utf8', timeout: RENDER_TIMEOUT_MS, env: {...process.env}}
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
