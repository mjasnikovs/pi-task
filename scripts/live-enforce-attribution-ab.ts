/**
 * LIVE harness (model in the loop) for the ENFORCE-DIFFERENTIAL ATTRIBUTION lever —
 * mx5 run 18 / nexttask 4.
 *
 * The replay A/B proves the lever on RECORDED verdict text. Whether a LIVE verifier
 * names the failing file precisely enough for the extractor to resolve it is a
 * separate, model-dependent question — `memory/prompt4-spec-urls-failed.md` is the
 * standing lesson that delivery alone proves nothing. This harness answers it.
 *
 * Fixture (per trial, fresh): the mx5 tree at `evidence/run18-task24`, plus the
 * synthetic enforce edit confined to `src/client/pages/Admin.tsx` (the same
 * paren removal enforce made in `ee65661`), with `node_modules` and the playwright
 * cache symlinked from `~/hub/mx5` so no install is needed.
 *
 * Arms (ground truth is the FIXTURE's construction, never a model self-report):
 *   disjoint   the failing check lives in `MyListings.spec.tsx` — a file the enforce
 *              diff does not touch and cannot reach (CT bundles per story).
 *              GROUND TRUTH: keep.
 *   reachable  the enforce edit itself breaks `Admin.tsx`, so the failure names the
 *              very file the enforce diff touched. GROUND TRUTH: revert. This arm is
 *              what stops "always keep" from scoring a perfect run.
 *   repro      no model: run the CT suite N times against the untouched fixture to
 *              see whether run 18's TIMING-DEPENDENT `getByText('SOLD')` collision
 *              reproduces here at all (in the investigation it did not: 10/10 and
 *              6/6 green on another box). Decides flake vs deterministic stand-in.
 *
 * THE FLAKE ITSELF IS NOT REPRODUCED by the `disjoint`/`reachable` arms: they use a
 * DETERMINISTIC stand-in — an assertion in `MyListings.spec.tsx` that always fails —
 * which is exactly the substitution nexttask 4 authorises ("any check that fails on
 * a file the enforce diff does not touch"). Run `repro` to see the flake's own
 * behaviour on this machine and say so in the writeup.
 *
 *   PASS     >= 80% of trials (>= 20 reps) yield an extractable file name, AND the
 *            lever's decision matches ground truth in EVERY extractable trial.
 *   FAIL     below that.
 *   ABSTAIN  the arm's fixture does not produce a FAIL at all (nothing to attribute).
 *
 * MEASURED 2026-07-30, 20 reps per arm, llama-server Q3.6-27B:
 *   repro      0/3 — the run-18 flake did NOT reproduce here (7 passed, 1.6s). Two
 *              fixture artifacts had to be removed first: `__screenshots__` is
 *              untracked in mx5 (so `git archive` drops it) and the `screenshot
 *              baseline` test renders differently on this box.
 *   reachable  20/20 FAILed, 20/20 named a resolvable file, 20/20 decided REVERT.
 *              PASS. tsc prints the path, so the regression case is fully covered.
 *   disjoint   20/20 FAILed, 9/20 named a file, 0 wrong. FAIL against the ≥80% bar.
 *              The 11 misses name the UNIT, not the file: "The MyListings component
 *              test … expects 4 Edit links but MOCK_LISTINGS has only 3". They fall
 *              through to the conservative revert, which is the shipped behaviour.
 *   candidate  the stem-widened extractor below: 40/40 extractable, 0 wrong across
 *              both arms — but the disjoint arm is its DESIGN pool (it was written
 *              after reading trial 1), and in 3 of those trials it "won" via the
 *              prose noun "listings" resolving to `src/server/routes/listings.ts`,
 *              a file that has nothing to do with the failure. NOT wired.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-enforce-attribution-ab.ts <arm> [TRIALS]
 * Safety: refuses to run without PI_BIN (an unset PI_BIN self-spawns a fork bomb —
 * crashed this machine twice); ONE child at a time; fixtures under /home/edgars/tmp.
 */
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runChild} from '../src/task/child-runner.js'
import {runWorkVerification} from '../src/task/verify-work.js'
import {
    attributeEnforceFailure,
    extractFailingFiles,
    fileStem
} from '../src/task/enforce-attribution.js'

const MX5 = process.env.MX5_REPO ?? path.join(os.homedir(), 'hub', 'mx5')
const ROOT = '/home/edgars/tmp/enforce-attribution-ab'
const CHILD_TIMEOUT_MS = 15 * 60_000
const TAG = 'evidence/run18-task24'

/** The enforce commit's entire file set — the set attribution compares against. */
const ENFORCE_DIFF = ['.pi-tasks/TASK_0024.md', 'src/client/pages/Admin.tsx']

type Arm = 'disjoint' | 'reachable' | 'repro'

const VERIFY_BLOCK = [
    '```sh',
    'bunx tsc --noEmit',
    // The `screenshot baseline` test is excluded: its PNG baselines are untracked in
    // mx5 and render differently on this box (font stack), so it fails for reasons
    // that have nothing to do with attribution and would be pure fixture noise.
    "npx playwright test -c playwright-ct.config.ts src/client/pages/MyListings.spec.tsx --grep-invert 'screenshot baseline'",
    '```'
].join('\n')

const SPEC = [
    '# Polish — empty/error/loading states across the marketplace pages',
    '',
    'GOAL: the pages under `src/client/pages/` render branded empty, error and loading',
    'states, and the existing component tests continue to pass.',
    '',
    'CONSTRAINTS:',
    '- Client-side only: do not touch the server, the schema, or any migration.',
    '',
    'ACCEPTANCE:',
    '- The project type-checks.',
    '- The My Listings component tests pass.',
    '',
    'VERIFY:',
    VERIFY_BLOCK
].join('\n')

function sh(cwd: string, cmd: string, args: string[], timeoutMs = 10 * 60_000): Promise<{exitCode: number; stdout: string; stderr: string}> {
    return new Promise(resolve => {
        const p = spawn(cmd, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']})
        let out = ''
        let err = ''
        const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
        p.stdout.on('data', d => (out += d))
        p.stderr.on('data', d => (err += d))
        p.on('close', code => {
            clearTimeout(timer)
            resolve({exitCode: code ?? 1, stdout: out, stderr: err})
        })
        p.on('error', () => {
            clearTimeout(timer)
            resolve({exitCode: 127, stdout: out, stderr: err})
        })
    })
}

/** Materialise the tagged tree, with the heavy directories borrowed from mx5. */
function buildFixture(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    const archive = spawnSync('git', ['archive', '--format=tar', TAG], {
        cwd: MX5,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer'
    })
    if (archive.error || archive.status !== 0) {
        throw new Error(`git archive ${TAG} failed — is the evidence tag present in ${MX5}?`)
    }
    const tarFile = path.join(path.dirname(dir), 'fixture.tar')
    fs.writeFileSync(tarFile, archive.stdout)
    const untar = spawnSync('tar', ['-xf', tarFile, '-C', dir])
    if (untar.status !== 0) throw new Error('untar of the fixture failed')
    fs.rmSync(tarFile, {force: true})
    // `__screenshots__` is untracked in mx5, so `git archive` cannot carry it and
    // every snapshot assertion would fail on "a snapshot doesn't exist" — a fixture
    // artifact that has nothing to do with the failure under study. Copy the
    // baselines in (copy, not symlink: a run writing actuals must not touch mx5).
    const shots = path.join(MX5, '__screenshots__')
    if (fs.existsSync(shots)) fs.cpSync(shots, path.join(dir, '__screenshots__'), {recursive: true})
    for (const shared of ['node_modules', '.playwright-cache']) {
        const src = path.join(MX5, shared)
        if (fs.existsSync(src)) {
            fs.rmSync(path.join(dir, shared), {recursive: true, force: true})
            fs.symlinkSync(src, path.join(dir, shared))
        }
    }
}

function edit(dir: string, rel: string, from: string, to: string): void {
    const file = path.join(dir, rel)
    const s = fs.readFileSync(file, 'utf8')
    if (!s.includes(from)) throw new Error(`fixture drift: ${rel} does not contain ${from}`)
    fs.writeFileSync(file, s.replace(from, to), 'utf8')
}

/**
 * The synthetic ENFORCE pass: exactly the edit run 18's enforce commit made — one
 * pair of redundant parentheses removed in `Admin.tsx`, nothing else.
 */
function applyEnforceEdit(dir: string): void {
    edit(dir, 'src/client/pages/Admin.tsx', '(usersData).error', 'usersData.error')
}

/**
 * The deterministic stand-in failure. `disjoint` puts it in a file the enforce diff
 * does not touch (ground truth: KEEP); `reachable` puts it in the file the enforce
 * edit itself changed (ground truth: REVERT).
 */
function injectFailure(dir: string, arm: Exclude<Arm, 'repro'>): void {
    if (arm === 'disjoint') {
        edit(
            dir,
            'src/client/pages/MyListings.spec.tsx',
            'await expect(editLinks).toHaveCount(3)',
            'await expect(editLinks).toHaveCount(4)'
        )
        return
    }
    // The enforce edit goes one step further and breaks the property it touched, so
    // the failure is genuinely the enforce commit's fault.
    edit(dir, 'src/client/pages/Admin.tsx', 'usersData.error', 'usersData.errorText')
}

/**
 * CANDIDATE (measured here, NOT shipped): a verdict text may name the failing unit
 * without ever writing a file name — trial 1 produced "one of 7 MyListings component
 * tests fails", which the shipped extractor cannot see. This variant also accepts a
 * bare IDENTIFIER that matches a tracked file's stem (`MyListings` →
 * `MyListings.spec.tsx` / `MyListings.tsx` / `MyListings.stories.tsx`, all stem
 * `mylistings`), which is all the comparison against the enforce diff needs. Measured
 * in both arms before any decision to wire it: it can only ADD named files, so it can
 * turn a conservative revert into a keep — the exact direction that needs evidence.
 */
function widenedNames(text: string, repoFiles: string[] | null): string[] {
    const strict = extractFailingFiles(text)
    if (!repoFiles || repoFiles.length === 0) return strict
    const stems = new Map<string, string>()
    for (const f of repoFiles) {
        const stem = fileStem(f)
        if (stem.length >= 3 && !stems.has(stem)) stems.set(stem, f)
    }
    const out = [...strict]
    const seen = new Set(strict.map(n => fileStem(n)))
    for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9_]{2,}\b/g)) {
        const stem = m[0].toLowerCase()
        const hit = stems.get(stem)
        if (hit && !seen.has(stem)) {
            seen.add(stem)
            out.push(hit)
        }
    }
    return out
}

interface Trial {
    n: number
    failed: boolean
    reason: string
    named: string[]
    extractable: boolean
    verdict: 'keep' | 'revert'
    why: string
    correct: boolean
    /** The widened-extractor candidate, measured alongside. */
    widened: string[]
    widenedExtractable: boolean
    widenedVerdict: 'keep' | 'revert'
    widenedCorrect: boolean
    ms: number
}

async function runTrial(arm: Exclude<Arm, 'repro'>, n: number, logFile: string): Promise<Trial> {
    const dir = path.join(ROOT, `trial-${arm}-${n}`)
    buildFixture(dir)
    applyEnforceEdit(dir)
    injectFailure(dir, arm)
    const started = Date.now()
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CHILD_TIMEOUT_MS)
    const log = (line: string): void => {
        fs.appendFileSync(logFile, `${line}\n`)
    }
    let outcome
    try {
        outcome = await runWorkVerification({
            cwd: dir,
            signal: abort.signal,
            spec: SPEC,
            runChild: async (tools, prompt, signal) => {
                log(`=== trial ${n} child start (tools=${tools}) ===`)
                const r = await runChild({
                    cwd: dir,
                    tools,
                    prompt,
                    signal: signal ?? abort.signal,
                    onLine: l => log(l)
                })
                log(`=== trial ${n} child end exit=${r.exitCode} ===`)
                if (r.exitCode !== 0) throw new Error(`child exited ${r.exitCode}: ${r.stderr}`)
                if (r.modelError) throw new Error(`model error: ${r.modelError}`)
                return r.text
            }
        })
    } finally {
        clearTimeout(timer)
    }
    const ms = Date.now() - started
    const reason = outcome.reason ?? ''
    const repoFiles = spawnSync('git', ['ls-files'], {cwd: MX5, encoding: 'utf8'})
    const files =
        repoFiles.status === 0 ?
            repoFiles.stdout.split('\n').map(l => l.trim()).filter(Boolean)
        :   null
    const named = extractFailingFiles(reason)
    const attribution = attributeEnforceFailure({
        failReason: reason,
        enforceTouched: ENFORCE_DIFF,
        repoFiles: files
    })
    const groundTruth: 'keep' | 'revert' = arm === 'disjoint' ? 'keep' : 'revert'
    const widened = widenedNames(reason, files)
    const widenedAttribution = attributeEnforceFailure({
        failReason: widened.join(' '),
        enforceTouched: ENFORCE_DIFF,
        repoFiles: files
    })
    fs.rmSync(dir, {recursive: true, force: true})
    return {
        n,
        failed: !outcome.ok,
        reason,
        named,
        extractable: attribution.named.length > 0,
        verdict: attribution.verdict,
        why: attribution.why,
        correct: attribution.verdict === groundTruth,
        widened,
        widenedExtractable: widened.length > 0,
        widenedVerdict: widenedAttribution.verdict,
        widenedCorrect: widenedAttribution.verdict === groundTruth,
        ms
    }
}

/** No model: does run 18's timing-dependent CT collision reproduce on this box? */
async function repro(trials: number): Promise<void> {
    const dir = path.join(ROOT, 'repro')
    buildFixture(dir)
    applyEnforceEdit(dir)
    let failed = 0
    for (let i = 1; i <= trials; i++) {
        const r = await sh(dir, 'npx', [
            'playwright',
            'test',
            '-c',
            'playwright-ct.config.ts',
            'src/client/pages/MyListings.spec.tsx',
            '--grep-invert',
            'screenshot baseline'
        ])
        const red = r.exitCode !== 0
        if (red) failed++
        const line = `${r.stdout}\n${r.stderr}`
            .split('\n')
            .find(l => /passed|failed|error/i.test(l))
            ?.trim()
        console.log(`  rep ${i}: exit=${r.exitCode} ${red ? 'FAILED' : 'green'}  ${line ?? ''}`)
    }
    console.log(`\nrepro: ${failed}/${trials} runs reproduced a CT failure on the untouched fixture.`)
    console.log(
        failed === 0 ?
            'The run-18 flake did NOT reproduce here — the live arms use the deterministic stand-in,\n'
            + 'and the writeup must say the flake itself was never reproduced.'
        :   'The flake DID reproduce — the disjoint arm could be run against the real collision.'
    )
}

async function main(): Promise<void> {
    const arm = (process.argv[2] ?? '') as Arm
    const trials = Number.parseInt(process.argv[3] ?? '20', 10)
    if (arm !== 'repro' && !process.env.PI_BIN) {
        console.error('refusing to run: PI_BIN is unset (an unset PI_BIN self-spawns a fork bomb).')
        process.exit(1)
    }
    if (!['disjoint', 'reachable', 'repro'].includes(arm)) {
        console.error('usage: live-enforce-attribution-ab.ts <disjoint|reachable|repro> [TRIALS]')
        process.exit(1)
    }
    fs.mkdirSync(ROOT, {recursive: true})
    if (arm === 'repro') {
        await repro(trials)
        return
    }
    const logFile = path.join(ROOT, `${arm}-debug.log`)
    fs.writeFileSync(logFile, '')
    const results: Trial[] = []
    for (let n = 1; n <= trials; n++) {
        const t = await runTrial(arm, n, logFile)
        results.push(t)
        console.log(
            `trial ${n}/${trials}  fail=${t.failed ? 'yes' : 'NO '}  extract=${t.extractable ? t.named.join(',') : '—'}  `
                + `verdict=${t.verdict} (${t.why})  ${t.correct ? 'correct' : 'WRONG'}  `
                + `| widened=${t.widenedExtractable ? t.widened.join(',') : '—'} → ${t.widenedVerdict} ${t.widenedCorrect ? 'correct' : 'WRONG'}  `
                + `${(t.ms / 1000).toFixed(0)}s`
        )
        if (!t.failed) console.log(`    (verifier PASSED — reason: ${t.reason.slice(0, 160)})`)
    }
    const failing = results.filter(r => r.failed)
    const extractable = failing.filter(r => r.extractable)
    const wrong = extractable.filter(r => !r.correct)
    console.log('\n── RESULT')
    console.log(`   arm                     : ${arm} (ground truth: ${arm === 'disjoint' ? 'KEEP' : 'REVERT'})`)
    console.log(`   trials                  : ${results.length}`)
    console.log(`   verifier FAILed         : ${failing.length}`)
    console.log(`   extractable file name   : ${extractable.length} of ${failing.length}`)
    console.log(`   decision wrong          : ${wrong.length}`)
    const wExtractable = failing.filter(r => r.widenedExtractable)
    console.log(
        `   [candidate] widened extractable : ${wExtractable.length} of ${failing.length}, `
            + `wrong: ${wExtractable.filter(r => !r.widenedCorrect).length}`
    )
    fs.writeFileSync(path.join(ROOT, `${arm}-results.json`), JSON.stringify(results, null, 2))
    if (failing.length === 0) {
        console.log('\nABSTAIN — the fixture never produced a verify FAIL, so there was nothing to attribute.')
        process.exit(2)
    }
    const rate = extractable.length / failing.length
    if (rate >= 0.8 && wrong.length === 0 && results.length >= 20) {
        console.log(`\nPASS — ${(rate * 100).toFixed(0)}% extractable, every extractable trial decided correctly.`)
        process.exit(0)
    }
    console.log(
        `\nFAIL — ${(rate * 100).toFixed(0)}% extractable (need 80%), ${wrong.length} wrong decisions, ${results.length} reps (need 20).`
    )
    process.exit(1)
}

void main()
