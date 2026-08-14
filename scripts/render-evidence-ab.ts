/**
 * A/B for 19B — the render probe carries the evidence it already had.
 *
 * THE DEFECT. mx5 run 21's render probe judged the page EMPTY and reported exactly
 * that. It was holding the cause on stderr and threw it away. The fix child got
 * "the body is EMPTY" and nothing else, and burned 45 minutes on tests, bundler
 * config and static serving. `Uncaught ReferenceError: process is not defined`,
 * main.js:322, was available at the moment of the verdict.
 *
 * SAY THE 1 OUT LOUD. In the ~/hub corpus this is ONE episode in 33 gate runs (58
 * recorded render FAILs corpus-wide, but 56 of those are A/B harness re-runs of
 * ONE project shape — see `scripts/gate-demote-baserate.ts`). 19B is NOT justified
 * by frequency. It is justified by strict additivity: it appends text to a detail
 * that is ALREADY a FAIL, and can neither invent a fact nor move a verdict.
 *
 * ── PRE-REGISTERED METRIC ──────────────────────────────────────────────────
 * Over a corpus of DOM + stderr pairs, compare baseline (the last commit without
 * the lever) against the working tree on FOUR channels:
 *
 *   1. the judged VERDICT (`judgeRenderedDom(dom).ok`)           byte-identical
 *   2. every PASS detail                                          byte-identical
 *   3. every SKIP note                                            byte-identical
 *   4. a FAIL with console output                                 GAINS it, clamped
 *      a FAIL with no console output                              byte-identical
 *
 * exit 0 iff all four hold. Any drift on 1–3 means the verdict channel moved and
 * the A/B is VOID, not merely failed.
 *
 * PLUS a LIVE arm, because the whole claim rests on a measurement of Chrome: serve
 * the shipped run-21 bundle from a scratch copy and run both binaries the probe
 * can discover, with and without the new flags. stdout must be byte-identical in
 * every arm. NEVER inside ~/hub — the bundle is copied to a temp dir first.
 *
 * Run: bun run scripts/render-evidence-ab.ts
 */
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'

import * as os from 'node:os'
import * as path from 'node:path'
import {
    findHeadlessBrowser,
    judgeRenderedDom,
    playwrightCachedChromium,
    runRenderCheck,
    type RenderOutcome
} from '../src/task/render-check.js'

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'run21-render')
const MX5_DIST = path.join(os.homedir(), 'hub', 'mx5', 'dist')

// ─── corpus ──────────────────────────────────────────────────────────────────

interface Case {
    name: string
    dom: string
    stderr: string
    /** Must the FAIL detail GROW? (only meaningful when the DOM judges ok:false) */
    expectGrowth: boolean
}

const run21Dom = fs.readFileSync(path.join(FIXTURES, 'dom.html'), 'utf8')
const run21Err = fs.readFileSync(path.join(FIXTURES, 'stderr-with-flags.txt'), 'utf8')

/** The synthetic DOMs render-check.test.ts already judges, so the A/B covers the
 *  same shapes the unit tests do rather than a private corpus. */
const CORPUS: Case[] = [
    {name: 'run-21 blank page + real console stderr', dom: run21Dom, stderr: run21Err, expectGrowth: true},
    {
        name: 'run-21 blank page, NO console output',
        dom: run21Dom,
        stderr: fs.readFileSync(path.join(FIXTURES, 'stderr-no-flags.txt'), 'utf8'),
        expectGrowth: false
    },
    {
        name: 'blank page, fontconfig noise only (not a console line)',
        dom: run21Dom,
        stderr: 'Fontconfig warning: We will not regenerate the cache because some cache files…\n',
        expectGrowth: false
    },
    {
        name: 'PASS — visible text',
        dom: '<html><body><h1>Listings</h1></body></html>',
        stderr: run21Err,
        expectGrowth: false
    },
    {
        name: 'PASS — visual elements, no text',
        dom: '<html><body><div><img src="a.png"><button></button></div></body></html>',
        stderr: run21Err,
        expectGrowth: false
    },
    {
        name: 'PASS — script/style only counts as no text, but a canvas rendered',
        dom: '<html><body><script>var x=1</script><canvas></canvas></body></html>',
        stderr: run21Err,
        expectGrowth: false
    },
    {
        name: 'blank page + a wedged console (clamp must bite)',
        dom: run21Dom,
        stderr:
            Array.from(
                {length: 400},
                (_, i) => `[1:1:0814/090315.7:ERROR:CONSOLE:${i}] "overflowing message number ${i}"`
            ).join('\n') + '\n',
        expectGrowth: true
    },
    {
        name: 'no <body> at all — the degenerate-dump path',
        dom: '<html>nothing here</html>',
        stderr: run21Err,
        expectGrowth: false // judges ok:true on the whole document's text
    }
]

// ─── arms ────────────────────────────────────────────────────────────────────

interface Arm {
    judge: (html: string) => {ok: boolean; detail: string}
}

/** The commit that ADDED clamp-output.ts is 19B's landing commit; its parent is
 *  the last tree without the lever. NEVER `HEAD` — memory/ab-baseline-ref-must-not-move.md. */
function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H', '--', 'src/task/clamp-output.ts'],
        {encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    // Before 19B is committed there is no such commit; the working tree's own HEAD
    // is then the last tree without the lever, which is exactly the baseline.
    return sha ? `${sha}^` : 'HEAD'
}

async function baselineArm(): Promise<Arm> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-evidence-ab-base-'))
    const ref = baselineRef()
    const tar = spawnSync('git', ['archive', ref, 'src'], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024
    })
    if (tar.status !== 0) throw new Error(`git archive ${ref} src failed`)
    fs.writeFileSync(path.join(dir, 'b.tar'), tar.stdout)
    if (spawnSync('tar', ['-xf', path.join(dir, 'b.tar'), '-C', dir]).status !== 0) {
        throw new Error('tar extract failed')
    }
    const m = (await import(path.join(dir, 'src/task/render-check.js'))) as {
        judgeRenderedDom: Arm['judge']
    }
    return {judge: m.judgeRenderedDom}
}

/**
 * What the probe REPORTS for a case, in each arm. Baseline had no evidence path at
 * all, so its report is the judge's detail verbatim — which is precisely the defect.
 */
function baselineReport(arm: Arm, c: Case): RenderOutcome {
    const j = arm.judge(c.dom)
    return j.ok ? {outcome: 'pass', detail: j.detail} : {outcome: 'fail', detail: j.detail}
}

async function treatmentReport(c: Case): Promise<RenderOutcome> {
    const {judgeRenderedDom: judge, withConsoleEvidence} = (await import(
        '../src/task/render-check.js'
    )) as typeof import('../src/task/render-check.js')
    const j = judge(c.dom)
    return j.ok ?
            {outcome: 'pass', detail: j.detail}
        :   {outcome: 'fail', detail: withConsoleEvidence(j.detail, c.stderr)}
}

// ─── live arm: does the flag pair move stdout? ───────────────────────────────

interface LiveArm {
    bin: string
    label: string
    withFlags: boolean
    stdout: string
    consoleLines: number
}

/**
 * Serve the bundle from a SEPARATE PROCESS. Two constraints, both learned the hard
 * way while building this harness:
 *
 *   1. It has to be a separate PROCESS. The live arms use `spawnSync` — the same
 *      call `runRenderCheck` makes — which blocks this process's event loop, so an
 *      in-process server can never answer the browser. First version did that and
 *      every arm returned 0 bytes.
 *   2. It has to be `python3 -m http.server`. A `Bun.serve` child answers `curl`
 *      with 200 and the right bytes, and BOTH headless binaries then hang on it
 *      until their 30s timeout with an empty dump. Measured, not guessed. A
 *      harness whose server wedges the browser reports "no difference between the
 *      arms" for a reason that has nothing to do with the lever.
 *
 * NEVER run a probe inside ~/hub — the bundle is copied to a temp dir first.
 * No python3 ⇒ null ⇒ the live arm is SKIPPED and says so, never faked.
 */
async function serveDist(): Promise<{port: number; close: () => void} | null> {
    if (!fs.existsSync(MX5_DIST)) return null
    if (spawnSync('python3', ['--version'], {encoding: 'utf8'}).status !== 0) return null
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-evidence-ab-dist-'))
    fs.cpSync(MX5_DIST, dir, {recursive: true})
    // Port 0 makes the kernel pick; `-u` is required or the banner never flushes.
    const child = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1'], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    const close = (): void => {
        child.kill('SIGKILL')
        fs.rmSync(dir, {recursive: true, force: true})
    }
    // Read the port BEFORE any spawnSync runs — this await is the last moment the
    // event loop is free.
    const port = await new Promise<number | null>(resolve => {
        let buf = ''
        const timer = setTimeout(() => resolve(null), 20_000)
        const onData = (d: Buffer): void => {
            buf += String(d)
            const m = /port (\d+)|127\.0\.0\.1:(\d+)/i.exec(buf)
            if (m) {
                clearTimeout(timer)
                resolve(Number(m[1] ?? m[2]))
            }
        }
        child.stdout.on('data', onData)
        child.stderr.on('data', onData)
        child.on('exit', () => {
            clearTimeout(timer)
            resolve(null)
        })
    })
    if (port === null) {
        close()
        return null
    }
    return {port, close}
}

function liveArm(bin: string, label: string, url: string, withFlags: boolean): LiveArm {
    const r = spawnSync(
        bin,
        [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--virtual-time-budget=8000',
            ...(withFlags ? ['--enable-logging=stderr', '--v=0'] : []),
            '--dump-dom',
            url
        ],
        {encoding: 'utf8', timeout: 60_000}
    )
    return {
        bin,
        label,
        withFlags,
        stdout: r.stdout ?? '',
        consoleLines: ((r.stderr ?? '').match(/:CONSOLE:/g) ?? []).length
    }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('A/B — 19B: the render probe carries the evidence it already had')
    console.log(`baseline src/ @ ${baselineRef()}`)
    console.log('')

    const base = await baselineArm()
    const checks: Array<[string, boolean]> = []

    console.log('CORPUS — baseline vs treatment, per case')
    for (const c of CORPUS) {
        const b = baselineReport(base, c)
        const t = await treatmentReport(c)
        const sameOutcome = b.outcome === t.outcome
        const bDetail = 'detail' in b ? b.detail : b.note
        const tDetail = 'detail' in t ? t.detail : t.note
        const grew = tDetail.length > bDetail.length
        const prefixKept = tDetail.startsWith(bDetail)
        const clamped = tDetail.length <= bDetail.length + 1400

        const want = c.expectGrowth
        const ok =
            sameOutcome
            && (b.outcome === 'fail' ?
                want ? grew && prefixKept && clamped
                :   tDetail === bDetail
            :   tDetail === bDetail)
        checks.push([`${c.name}`, ok])
        console.log(
            `  ${ok ? 'ok  ' : 'FAIL'}  ${b.outcome.toUpperCase().padEnd(4)} ${c.name}`
        )
        console.log(`          baseline  ${bDetail.slice(0, 120)}`)
        if (tDetail !== bDetail) console.log(`          treatment ${tDetail.slice(0, 200)}`)
        else console.log('          treatment BYTE-IDENTICAL')
    }

    // The verdict channel itself: `judgeRenderedDom` must be untouched.
    const verdictsIdentical = CORPUS.every(c => {
        const b = base.judge(c.dom)
        const t = judgeRenderedDom(c.dom)
        return b.ok === t.ok && b.detail === t.detail
    })
    checks.push(['inv-verdict-channel-frozen: judgeRenderedDom is byte-identical in both arms', verdictsIdentical])

    // A SKIP note must be untouched — the env-gap contract is not 19B's business.
    const skipBase = runRenderCheck('http://127.0.0.1:1/', null)
    const skipNote = skipBase.outcome === 'skip' ? skipBase.note : ''
    checks.push([
        'inv-skip-note-frozen: a no-browser SKIP still reports the env gap verbatim',
        skipBase.outcome === 'skip' && skipNote.includes('no headless Chrome-family browser found')
    ])

    // ── LIVE ──
    console.log('\nLIVE — the shipped run-21 bundle, served from a temp COPY (never ~/hub)')
    const served = await serveDist()
    if (served === null) {
        console.log(
            '  SKIP — no ~/hub/mx5/dist or no python3 on this box. The offline corpus above still '
                + 'decides; the live claim is NOT reported as proven.'
        )
    } else {
        const url = `http://127.0.0.1:${served.port}/`
        const bins: Array<[string, string | null]> = [
            ['discovered default', findHeadlessBrowser()],
            ['playwright headless shell', playwrightCachedChromium()],
            ['/usr/bin/chromium', fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null]
        ]
        const seen = new Set<string>()
        const byBin = new Map<string, LiveArm[]>()
        for (const [label, bin] of bins) {
            if (bin === null || seen.has(bin)) continue
            seen.add(bin)
            byBin.set(label, [
                liveArm(bin, `${label} (no flags)`, url, false),
                liveArm(bin, `${label} (19B flags)`, url, true)
            ])
        }
        served.close()
        let usable = 0
        for (const [label, arms] of byBin) {
            for (const a of arms) {
                console.log(
                    `  ${a.label.padEnd(34)} stdout ${String(a.stdout.length).padStart(5)}B  `
                        + `console lines ${a.consoleLines}`
                )
            }
            const [noFlags, withFlags] = arms as [LiveArm, LiveArm]
            if (noFlags.stdout.length === 0 && withFlags.stdout.length === 0) {
                // A binary that cannot load the page here says nothing either way.
                // Reported, never counted — and never silently treated as agreement.
                console.log(`      ${label}: UNAVAILABLE on this box (both arms dumped nothing)`)
                continue
            }
            usable++
            checks.push([
                `inv-dom-unchanged-live [${label}]: the DOM is byte-identical with and without the flags`,
                noFlags.stdout === withFlags.stdout && withFlags.stdout.length > 0
            ])
            checks.push([
                `inv-evidence-present-live [${label}]: the 19B arm captures the page's console output`,
                withFlags.consoleLines > 0
            ])
            if (noFlags.consoleLines === 0) {
                console.log(
                    `      ${label}: the flags were REQUIRED here — `
                        + `${noFlags.consoleLines} console line(s) without, ${withFlags.consoleLines} with`
                )
            } else {
                console.log(
                    `      ${label}: this binary logs console lines anyway `
                        + `(${noFlags.consoleLines}); the flags neither add nor remove any`
                )
            }
        }
        checks.push([
            'the live control is not dead: at least one binary really loaded the page',
            usable > 0
        ])
    }

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    const verdict = checks.every(([, ok]) => ok)
    console.log(`\nA/B 19B: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
