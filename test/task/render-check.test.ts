/**
 * render-check tests — the RENDERED-DOM judgment, which catches the blank-page and
 * no-router classes a `curl` of the same URL cannot see, plus the
 * discover-don't-install browser lookup. `judgeRenderedDom` is pure;
 * `runRenderCheck` runs against an injected browser path — a small node script
 * standing in for `chrome --dump-dom` — so the flow is hermetic. One real-browser
 * smoke runs when a browser is present.
 */
import {describe, expect, test} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {spawn} from 'node:child_process'
import {
    findHeadlessBrowser,
    httpAnswer,
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

    test('the title is not rendered content, even with no closing body tag', () => {
        expect(
            judgeRenderedDom('<html><head><title>App</title></head><body><div id="root"></div>').ok
        ).toBe(false)
    })

    test('the title is not rendered content when the page has no <body> tag', () => {
        expect(
            judgeRenderedDom('<html><head><title>App</title></head><div id="root"></div></html>').ok
        ).toBe(false)
    })

    // A serializer that leaves `<` raw in attribute values hands these back.
    for (const opener of ['<!--', '<script>']) {
        test(`a ${opener} inside a head attribute does not hide the body`, () => {
            const dom =
                `<html><head><meta name="x" content="a${opener}b"></head>`
                + '<body><h1>Hi</h1><!-- c --><script>x</script></body></html>'
            expect(judgeRenderedDom(dom).ok).toBe(true)
        })
    }

    test('a <body> inside a head attribute does not start the body', () => {
        const dom =
            '<html><head><meta name="d" content="use <body> tags"><title>App</title></head>'
            + '<body><div id="root"></div></body></html>'
        expect(judgeRenderedDom(dom).ok).toBe(false)
    })

    // Each `shows` is what Chromium's innerText reads from the same page.
    for (const [what, dom, shows] of [
        [
            'a quote inside an unquoted value',
            '<body><img alt=x=" title>Shown text</body>',
            'Shown text'
        ],
        ['the empty comment <!-->', '<body><!-->A<!-- x -->B</body>', 'AB'],
        ['the empty comment <!--->', '<body><!--->A<!-- x -->B</body>', 'AB'],
        ['a comment closed by --!>', '<body><!-- x --!>A</body>', 'A'],
        ['a comment never closed', '<body>Hi<!-- never closed Bye</body>', 'Hi'],
        ['a script never closed', '<body>A<script>x</body>B', 'A'],
        ['an <!-- inside xmp', '<body><xmp><!--</xmp>hidden?<!-- c -->V</body>', '<!-- hidden?V'],
        ['an <!-- inside iframe', '<body><iframe><!--</iframe>A<!-- c -->V</body>', 'AV'],
        ['an <!-- inside noembed', '<body><noembed><!--</noembed>A<!-- c -->V</body>', 'AV'],
        ['an <!-- inside noframes', '<body><noframes><!--</noframes>A<!-- c -->V</body>', 'AV'],
        ['a nested template', '<body><template><template></template>LEAK</template>V</body>', 'V'],
        ['a comment between words', '<body>Hello<!-- -->World</body>', 'HelloWorld'],
        ['a script between words', '<body>Build<script>x</script>Missing</body>', 'BuildMissing'],
        ['a bare less-than sign', '<body>1<2</body>', '1<2'],
        ['a > inside a closer attribute', '<body><script>a</script x=">">V</body>', 'V'],
        ['text after </body>', '<html><body>A</body> B</html> C', 'A B C'],
        ['text in the head', '<html><head><title>T</title> X </head><body> B</body></html>', 'X B']
    ] as const) {
        test(`${what} shows what a browser shows`, () => {
            expect(judgeRenderedDom(dom).detail).toBe(`rendered visible text ("${shows}")`)
        })
    }

    test('a nested template shows nothing', () => {
        expect(
            judgeRenderedDom('<body><template><template></template>LEAK</template></body>').ok
        ).toBe(false)
    })
})

describe('findHeadlessBrowser', () => {
    test('honours an explicit CHROME_BIN that exists', () => {
        const fake = path.join(tmpDir('chrome-'), 'chrome')
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
        const dir = tmpDir('fake-chrome-')
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

    // mx5-n: the server's 503 text "Client build missing" was judged a rendered page.
    /** A server in its own process: the check blocks this one while it fetches. */
    const serve = async (handler: string): Promise<{url: string; stop: () => void}> => {
        const server = spawn(process.execPath, [
            '-e',
            `require('http').createServer(${handler})`
                + `.listen(0, '127.0.0.1', function () { console.log(this.address().port) })`
        ])
        const port = await new Promise<string>(resolve =>
            server.stdout.once('data', d => resolve(String(d).trim()))
        )
        return {url: `http://127.0.0.1:${port}/`, stop: () => server.kill()}
    }
    const buildMissing = 'Client build missing — run bun run build.'
    const answer503 = `(q, r) => { r.writeHead(503); r.end(${JSON.stringify(buildMissing)}) }`

    spawnFlow('an HTTP 5xx answer is unready, never a rendered page', async () => {
        const server = await serve(answer503)
        try {
            const r = runRenderCheck(
                server.url,
                fakeBrowser(`<html><body>${buildMissing}</body></html>`)
            )
            expect(r.outcome).toBe('unready')
            expect((r as {detail: string}).detail).toContain('HTTP 503')
        } finally {
            server.stop()
        }
    })

    // The status needs no browser, so a box without one still sees the 503.
    spawnFlow('an HTTP 5xx answer is unready even with no browser on the box', async () => {
        const server = await serve(answer503)
        try {
            expect(runRenderCheck(server.url, null).outcome).toBe('unready')
        } finally {
            server.stop()
        }
    })

    // The status is in the headers. An error body that stalls must not hide it.
    spawnFlow('a 5xx whose body never ends still reports its status', async () => {
        const server = await serve(`(q, r) => { r.writeHead(503); r.write('building') }`)
        try {
            expect(httpAnswer(server.url, 2000)?.status).toBe(503)
        } finally {
            server.stop()
        }
    })

    spawnFlow('the 5xx excerpt is the page text, not its stylesheet', async () => {
        const page =
            '<html><head><style>body{margin:0;font-family:system-ui}</style></head>'
            + `<body><h1>${buildMissing}</h1></body></html>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            const r = runRenderCheck(server.url, null)
            expect((r as {detail: string}).detail).toContain(`("${buildMissing}")`)
        } finally {
            server.stop()
        }
    })

    // A whole body sent back through the pipe was cut off at process exit.
    spawnFlow('a 5xx with a body of megabytes still gives its excerpt', async () => {
        const head = JSON.stringify(`<html><body><h1>${buildMissing}</h1><script>`)
        const page = `${head} + 'x'.repeat(3_000_000) + '</script></body></html>'`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${page}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    spawnFlow('a 5xx page whose only words are its title gives the title', async () => {
        const page = `<html><head><title>${buildMissing}</title></head><body><div id="root"></div><script>boot()</script></body></html>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    spawnFlow('a 5xx page with body text gives the body, not its title', async () => {
        const page = `<html><head><title>503 Service Unavailable</title></head><body><h1>${buildMissing}</h1></body></html>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    // Each opener with no closer rescanned the rest of the page.
    spawnFlow('a 5xx page of many unclosed openers still gives its excerpt', async () => {
        const head = JSON.stringify(`<html><body><h1>${buildMissing}</h1>`)
        const page = `${head} + ('<style>' + 'x'.repeat(93)).repeat(30_000)`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${page}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toStartWith(buildMissing)
        } finally {
            server.stop()
        }
    })

    // HTML lets a page leave </body> out.
    spawnFlow('a 5xx page with no closing body tag gives the body, not its title', async () => {
        const page = `<html><head><title>503 Service Unavailable</title></head><body><h1>${buildMissing}</h1>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    // HTML lets a page leave the <body> tag out too.
    spawnFlow('a 5xx page with no body tag gives its text, not its title', async () => {
        const page = `<html><head><title>503 Service Unavailable</title></head><h1>${buildMissing}</h1>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    spawnFlow('a body tag inside a head script does not start the body', async () => {
        const page = `<html><head><script>el.innerHTML = '<body class=x>'</script></head><body><h1>${buildMissing}</h1>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    spawnFlow('a comment opener in the title does not swallow the body', async () => {
        const page = `<html><head><title>a <!-- b</title></head><body><h1>${buildMissing}</h1><!-- x --></body></html>`
        const server = await serve(`(q, r) => { r.writeHead(503); r.end(${JSON.stringify(page)}) }`)
        try {
            expect(httpAnswer(server.url)?.text).toBe(buildMissing)
        } finally {
            server.stop()
        }
    })

    for (const [what, unit] of [
        ['body openers and no closer', '<body>'],
        ['comment openers and no closer', '<!--'],
        ['title openers and no closer', '<title>'],
        ['quoted attributes and no closing quote', '<a b="'],
        ['less-than signs and no later greater-than', 'a<b']
    ] as const) {
        spawnFlow(`a 5xx page of many ${what} still gives its excerpt`, async () => {
            const head = JSON.stringify(`<html><body><h1>${buildMissing}</h1>`)
            const tail = JSON.stringify(unit)
            const page = `${head} + (${tail} + 'x'.repeat(${100 - unit.length})).repeat(30_000)`
            const server = await serve(`(q, r) => { r.writeHead(503); r.end(${page}) }`)
            try {
                expect(httpAnswer(server.url)?.text).toStartWith(buildMissing)
            } finally {
                server.stop()
            }
        })
    }

    // A healthy status is read from the headers alone: a root that streams forever
    // must not hold the probe until its timeout.
    spawnFlow(
        'a 2xx root whose body never ends is judged without waiting on the body',
        async () => {
            const server = await serve(`(q, r) => { r.writeHead(200); r.write('x') }`)
            try {
                const b = fakeBrowser('<html><body><h1>Listings</h1></body></html>')
                expect(runRenderCheck(server.url, b).outcome).toBe('pass')
            } finally {
                server.stop()
            }
        },
        10_000
    )

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
        const dir = tmpDir('render-smoke-')
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
