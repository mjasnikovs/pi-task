/**
 * render-check tests — the RENDERED-DOM judgment (mx5 runs 8/11: the blank-page /
 * no-Switch classes that curl can never catch) and the discover-don't-install
 * browser lookup. judgeRenderedDom is pure; runRenderCheck is exercised with an
 * injected browser path (a tiny node script standing in for chrome --dump-dom) so
 * the flow is hermetic, plus one real-browser smoke when a browser is present.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    findHeadlessBrowser,
    judgeRenderedDom,
    playwrightCachedChromium,
    runRenderCheck
} from './render-check.js'

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

    // The fake browser is a POSIX shell script (shebang exec) — Windows has no
    // /bin/sh and won't run it, so the spawn-flow cases are POSIX-only. The
    // rendered/blank JUDGMENT they cover is the pure judgeRenderedDom above,
    // exercised on every platform; here we only prove the spawn→judge plumbing.
    const spawnFlow = process.platform === 'win32' ? test.skip : test

    spawnFlow('a rendered page → pass', () => {
        const b = fakeBrowser('<html><body><h1>Listings</h1></body></html>')
        const r = runRenderCheck('http://127.0.0.1:3000/', b)
        expect(r.outcome).toBe('pass')
    })

    spawnFlow('a blank-mount page → fail (the run-8 class, now caught)', () => {
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

    // Real-browser smoke: gated on the Playwright headless SHELL specifically,
    // not any discovered browser. The module treats a full system chromium as an
    // unreliable last resort (it stalls/varies under --dump-dom --virtual-time-
    // budget), so a hard-`pass` assertion through one is wrong — that is exactly
    // how CI's system google-chrome (no PW cache) failed this. The shell is what
    // real mx5-class projects ship; when it is absent (CI), skip rather than
    // assert through the unreliable path.
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
