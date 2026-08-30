/**
 * render-check tests — the RENDERED-DOM judgment, which catches the blank-page and
 * no-router classes a `curl` of the same URL cannot see, plus the
 * discover-don't-install browser lookup. `judgeRenderedDom` is pure;
 * `runRenderCheck` runs against an injected browser path — a small node script
 * standing in for `chrome --dump-dom` — so the flow is hermetic. One real-browser
 * smoke runs when a browser is present.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    findHeadlessBrowser,
    judgeRenderedDom,
    parseConsoleLines,
    playwrightCachedChromium,
    runRenderCheck,
    withConsoleEvidence
} from '../../src/task/render-check.js'

describe('judgeRenderedDom', () => {
    test('a mounted SPA (visible text under #root) PASSes', () => {
        const dom =
            '<html><head></head><body><div id="root"><h1>Sign in</h1>'
            + '<form><input name="phone"/></form></div><script src="/main.js"></script></body></html>'
        const j = judgeRenderedDom(dom)
        expect(j.ok).toBe(true)
        expect(j.detail).toContain('Sign in')
    })

    test('run-8 blank-page class: an empty mount point after JS ran FAILs', () => {
        // The ESM-in-classic-script-tag defect: HTTP 200, script present, but the
        // client never mounted — #root stays empty.
        const dom =
            '<html><head><title>App</title></head><body><div id="root"></div>'
            + '<script src="/bundle.js"></script></body></html>'
        const j = judgeRenderedDom(dom)
        expect(j.ok).toBe(false)
        expect(j.detail).toContain('EMPTY')
    })

    test('a page with only visual/interactive elements (no text) PASSes', () => {
        const dom = '<html><body><canvas id="game" width="640" height="480"></canvas></body></html>'
        expect(judgeRenderedDom(dom).ok).toBe(true)
    })

    test('scripts, styles, and comments do not count as rendered content', () => {
        const dom =
            '<html><body><div id="root"></div>'
            + '<style>.x{color:red}</style><script>const a = "hello world"</script>'
            + '<!-- a comment with words --></body></html>'
        expect(judgeRenderedDom(dom).ok).toBe(false)
    })

    test('no <body> tag → judges the whole document rather than crashing', () => {
        expect(judgeRenderedDom('<div>Loaded</div>').ok).toBe(true)
        expect(judgeRenderedDom('   ').ok).toBe(false)
    })
})

describe('findHeadlessBrowser', () => {
    test('honours an explicit CHROME_BIN that exists', () => {
        const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-')), 'chrome')
        fs.writeFileSync(fake, '')
        const old = process.env.CHROME_BIN
        process.env.CHROME_BIN = fake
        try {
            expect(findHeadlessBrowser()).toBe(fake)
        } finally {
            if (old === undefined) delete process.env.CHROME_BIN
            else process.env.CHROME_BIN = old
        }
    })

    test('a non-existent CHROME_BIN is ignored (falls through to discovery)', () => {
        const old = process.env.CHROME_BIN
        process.env.CHROME_BIN = '/no/such/chrome/binary'
        try {
            // Whatever discovery returns, it must NOT be the bogus override.
            expect(findHeadlessBrowser()).not.toBe('/no/such/chrome/binary')
        } finally {
            if (old === undefined) delete process.env.CHROME_BIN
            else process.env.CHROME_BIN = old
        }
    })
})

describe('runRenderCheck', () => {
    // A stand-in "browser": a node script that ignores chrome flags and prints a
    // fixed DOM to stdout, exactly like `chrome --dump-dom`. Lets the flow be tested
    // without a real browser on the box.
    const fakeBrowser = (domToPrint: string, exit = 0): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-chrome-'))
        const js = path.join(dir, 'dump.js')
        fs.writeFileSync(
            js,
            `process.stdout.write(${JSON.stringify(domToPrint)}); process.exit(${exit})`
        )
        const sh = path.join(dir, 'chrome')
        fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`)
        fs.chmodSync(sh, 0o755)
        return sh
    }

    // The fake browser is a `#!/bin/sh` script, so these cases are gated to
    // platforms that run one. They only prove the spawn-to-judge plumbing; the
    // rendered/blank JUDGMENT itself is judgeRenderedDom above, which is pure and
    // runs everywhere.
    const spawnFlow = process.platform === 'win32' ? test.skip : test

    spawnFlow('a rendered page → pass', () => {
        const b = fakeBrowser('<html><body><h1>Listings</h1></body></html>')
        const r = runRenderCheck('http://127.0.0.1:3000/', b)
        expect(r.outcome).toBe('pass')
    })

    spawnFlow('a blank-mount page → fail', () => {
        const b = fakeBrowser('<html><body><div id="root"></div></body></html>')
        const r = runRenderCheck('http://127.0.0.1:3000/', b)
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('EMPTY')
    })

    test('no browser found → skip (env gap, never a false FAIL)', () => {
        const r = runRenderCheck('http://127.0.0.1:3000/', null)
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('no headless')
    })

    spawnFlow('a browser that crashes with no DOM → skip, not fail', () => {
        const b = fakeBrowser('', 1)
        const r = runRenderCheck('http://127.0.0.1:3000/', b)
        expect(r.outcome).toBe('skip')
    })

    // Gated on the Playwright headless SHELL specifically, not on whatever
    // findHeadlessBrowser would return. That function takes a system browser on
    // PATH only as a last resort, and asserting a hard `pass` through one would
    // make this test depend on a binary the module itself does not trust. Absent
    // the shell, skip.
    const realBrowser = playwrightCachedChromium()
    const smoke = realBrowser ? test : test.skip
    smoke('real headless browser executes page JS and renders the mount', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-smoke-'))
        const page = path.join(dir, 'index.html')
        fs.writeFileSync(
            page,
            '<html><body><div id="root"></div>'
                + '<script>document.getElementById("root").textContent="Mounted OK"</script>'
                + '</body></html>'
        )
        const r = runRenderCheck(`file://${page}`, realBrowser)
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('Mounted OK')
    })
})

// ─── The probe carries the evidence it already had ──────────────────────────
//
// "the body is EMPTY" names the symptom and nothing else, while the browser has
// already printed the cause to stderr. `--enable-logging=stderr --v=0` is what
// routes it there, and render-check.ts records that those flags leave the
// `--dump-dom` stdout the judge reads byte-identical.

/** A verbatim Chrome stderr capture: fontconfig noise, a React DevTools notice,
 *  and the uncaught error that is the real cause of the empty body. */
const CHROME_STDERR =
    'Fontconfig warning: We will not regenerate the cache because some cache files were generated '
    + 'by a newer version (0x2012001) of Fontconfig.\n'
    + '[11506:11506:0814/090315.684843:INFO:CONSOLE:226] "%cDownload the React DevTools for a better '
    + 'development experience: https://react.dev/link/react-devtools font-weight:bold", source: '
    + 'http://localhost:8791/main.js (226)\n'
    + '[11506:11506:0814/090315.702981:INFO:CONSOLE:322] "Uncaught ReferenceError: process is not '
    + 'defined", source: http://localhost:8791/main.js (322)\n'

describe('parseConsoleLines', () => {
    test('extracts the console messages and drops the fontconfig noise', () => {
        const lines = parseConsoleLines(CHROME_STDERR)
        expect(lines).toHaveLength(2)
        expect(lines[1]).toContain('Uncaught ReferenceError: process is not defined')
        expect(lines.join(' ')).not.toContain('Fontconfig')
    })

    test('the volatile pid/timestamp prefix is DROPPED — two runs must compare equal', () => {
        const a = parseConsoleLines('[11506:11506:0814/090315.7:ERROR:CONSOLE:1] "boom"')
        const b = parseConsoleLines('[99999:99999:0901/235959.1:ERROR:CONSOLE:1] "boom"')
        expect(a).toEqual(b)
        expect(a[0]).toBe('error: "boom"')
    })

    test('duplicate messages collapse, and the count is bounded', () => {
        const many = Array.from(
            {length: 50},
            (_, i) => `[1:1:0814/1.1:ERROR:CONSOLE:${i}] "message ${i}"`
        ).join('\n')
        expect(parseConsoleLines(many).length).toBeLessThanOrEqual(12)
        const dupes = Array.from({length: 5}, () => '[1:1:0814/1.1:ERROR:CONSOLE:1] "same"').join(
            '\n'
        )
        expect(parseConsoleLines(dupes)).toHaveLength(1)
    })

    test('a stderr with no console lines yields none', () => {
        expect(parseConsoleLines('Fontconfig warning: blah\n')).toEqual([])
        expect(parseConsoleLines('')).toEqual([])
    })
})

describe('withConsoleEvidence', () => {
    const EMPTY = judgeRenderedDom('<html><body></body></html>').detail

    test('a FAIL detail GAINS the cause, with the original text intact in front', () => {
        const out = withConsoleEvidence(EMPTY, CHROME_STDERR)
        expect(out.startsWith(EMPTY)).toBe(true)
        expect(out).toContain('Uncaught ReferenceError: process is not defined')
    })

    test('a FAIL with no console output is BYTE-IDENTICAL', () => {
        expect(withConsoleEvidence(EMPTY, 'Fontconfig warning: blah\n')).toBe(EMPTY)
        expect(withConsoleEvidence(EMPTY, '')).toBe(EMPTY)
    })

    test('a wedged console is clamped, not embedded whole', () => {
        // Distinct messages: identical ones collapse (see the dedup test above),
        // so a degenerate flood would prove nothing about the clamp.
        const flood = Array.from(
            {length: 12},
            (_, i) => `[1:1:0814/1.1:ERROR:CONSOLE:${i}] "msg ${i} ${'x'.repeat(400)}"`
        ).join('\n')
        const out = withConsoleEvidence(EMPTY, flood)
        expect(out.length).toBeLessThan(EMPTY.length + 1400)
        expect(out.endsWith('…')).toBe(true)
    })

    test('it never touches the verdict — judgeRenderedDom is not reached', () => {
        // The PASS details this probe emits must be unreachable from here: the
        // caller only ever hands a FAIL detail in, and the function only appends.
        const pass = judgeRenderedDom('<html><body><h1>Listings</h1></body></html>')
        expect(pass.ok).toBe(true)
        expect(withConsoleEvidence(pass.detail, 'Fontconfig warning\n')).toBe(pass.detail)
    })
})
