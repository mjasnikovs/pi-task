/**
 * nexttask 3 A/B — does comparing RESOLVED COMMAND BODIES catch the scope
 * shrink that the label comparison walked through?
 *
 * VERDICT (2026-08-05): PASS, wired. Baseline rejects nothing on mx5@dfbdd6f;
 * treatment rejects it naming `bun run test` and quoting `AGENT=1 bun test` →
 * `AGENT=1 bun test ./test`. All six invariants HOLD, including zero new
 * rejections on the other recorded fix commit (mx5@a9c6145 — read by hand, a
 * relocation, see the base-rate script's header).
 *
 * The corpus is small (2 recorded fix commits) BY NATURE — a final-gate autofix
 * commit is rare. The false-positive question is answered by the wide corpus in
 * scripts/command-shrink-baserate.ts (274 commits), not here.
 *
 * Both arms run in one process over the recorded fix-commit corpus (`~/hub/*`,
 * autofix / lint-fix commits), replayed through the SHIPPED guard entry point
 * `runFinalGateAutofix` — not a re-implementation of it. The fix child is
 * replaced by a replay that materializes the commit's own before/after
 * manifests, so the arms differ in exactly one wiring bit:
 *
 *   baseline    discoverLabels only          (the guard as shipped before this)
 *   treatment   + discoverBodies             (the resolved-body narrowing rules)
 *
 * Pre-registered metric: THE SET OF ATTEMPTS REJECTED, per commit, as sets.
 *
 *   PASS      baseline rejects nothing on mx5@dfbdd6f; treatment rejects it with
 *             a reason naming `test`; AND all six invariants hold.        exit 0
 *   FAIL      treatment misses it, or any invariant breaks.               exit 1
 *   ABSTAIN   no recorded fix commits available.                          exit 2
 *
 * INVARIANTS (each one a named check, all reported):
 *   inv-label-guard-kept       every rejection the baseline makes is still made
 *   inv-no-new-rejections      no extra rejection on any other fix commit
 *   inv-widening-allowed       `bun test ./test` → `bun test` is NOT rejected
 *   inv-env-and-flags-allowed  added env/`--bail`/`--reporter`/reorder pass
 *   inv-makefile-parity        a Makefile `test:` recipe gaining a directory
 *                              argument is rejected identically
 *   inv-discard-path           on rejection the edits are discarded and
 *                              guardTripped/editsDiscarded are set
 *
 * Run: bun run scripts/command-shrink-ab.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {runFinalGateAutofix, type FinalFixDeps, type FinalFixResult} from '../src/task/final-gate-fix.js'
import {discoverGateCommandBodies, discoverGateCommandLabels} from '../src/task/final-gate.js'

const HUB = path.join(os.homedir(), 'hub')
const LEAD = {repo: 'mx5', sha: 'dfbdd6f'}
const MANIFESTS = ['package.json', 'Makefile']

function gitOrNull(repo: string, args: string[]): string | null {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        })
    } catch {
        return null
    }
}

function repos(): string[] {
    if (!fs.existsSync(HUB)) return []
    return fs
        .readdirSync(HUB)
        .map(n => path.join(HUB, n))
        .filter(d => fs.existsSync(path.join(d, '.git')))
        .sort()
}

function fixCommits(repo: string): string[] {
    const out = gitOrNull(repo, [
        'log',
        '--all',
        '--format=%H',
        '-i',
        '--grep=FINAL GATE AUTOFIX',
        '--grep=lint-fix',
        '--grep=autofix'
    ])
    return (out ?? '').split('\n').filter(Boolean)
}

function addedFiles(repo: string, sha: string): string[] {
    const out = gitOrNull(repo, [
        'diff-tree',
        '--no-commit-id',
        '--name-status',
        '-r',
        '--first-parent',
        sha
    ])
    return (out ?? '')
        .split('\n')
        .map(l => l.split('\t'))
        .filter(([s, f]) => s?.startsWith('A') && f)
        .map(([, f]) => f)
}

function writeManifests(repo: string, sha: string, dir: string): void {
    fs.mkdirSync(dir, {recursive: true})
    for (const m of MANIFESTS) {
        const text = gitOrNull(repo, ['show', `${sha}:${m}`])
        const at = path.join(dir, m)
        if (text !== null) fs.writeFileSync(at, text)
        else if (fs.existsSync(at)) fs.rmSync(at)
    }
}

// ── the replayed attempt ────────────────────────────────────────────────────

interface Attempt {
    /** `repo@sha` or the fixture's name. */
    id: string
    /** Puts the pre-fix tree in `cwd`. */
    seed: (cwd: string) => void
    /** Plays the fix child's edits into `cwd`. */
    apply: (cwd: string) => void
    /** Files the "fix" created, for rule 4's provenance. */
    added: string[]
}

interface ArmResult {
    id: string
    rejected: boolean
    reason: string
    discarded: boolean
    guardTripped: boolean
    gateRuns: number
}

/** Run one attempt through the SHIPPED guard. `bodies` off = baseline arm. */
async function runArm(a: Attempt, bodies: boolean): Promise<ArmResult> {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-shrink-ab-'))
    try {
        a.seed(cwd)
        let discarded = false
        let gateRuns = 0
        const deps: FinalFixDeps = {
            cwd,
            failReason: '`bun run test` exited 1',
            runChild: () => {
                a.apply(cwd)
                return Promise.resolve('FINAL-GATE-FIX: DONE')
            },
            gate: () => {
                gateRuns++
                return Promise.resolve({ok: true, reason: 'green after the fix'})
            },
            discoverLabels: discoverGateCommandLabels,
            ...(bodies ? {discoverBodies: discoverGateCommandBodies} : {}),
            discard: () => {
                discarded = true
                return Promise.resolve()
            },
            treeChanges: () =>
                Promise.resolve({modified: ['package.json'], deleted: [], added: a.added})
        }
        const r: FinalFixResult = await runFinalGateAutofix(deps)
        return {
            id: a.id,
            rejected: r.guardTripped === true,
            reason: r.reason,
            discarded,
            guardTripped: r.guardTripped === true,
            gateRuns
        }
    } finally {
        fs.rmSync(cwd, {recursive: true, force: true})
    }
}

/** A real recorded fix commit, replayed from its own blobs. */
function commitAttempt(repo: string, sha: string): Attempt {
    const parent = gitOrNull(repo, ['rev-parse', `${sha}^`])?.trim() ?? ''
    return {
        id: `${path.basename(repo)}@${sha.slice(0, 7)}`,
        seed: cwd => writeManifests(repo, parent, cwd),
        apply: cwd => writeManifests(repo, sha, cwd),
        added: addedFiles(repo, sha)
    }
}

/** A synthetic manifest pair, for the invariant fixtures. */
function pkgAttempt(
    id: string,
    before: Record<string, string>,
    after: Record<string, string>,
    added: string[] = []
): Attempt {
    const write = (cwd: string, scripts: Record<string, string>) =>
        fs.writeFileSync(
            path.join(cwd, 'package.json'),
            JSON.stringify({name: 'fixture', scripts}, null, 2)
        )
    return {id, seed: cwd => write(cwd, before), apply: cwd => write(cwd, after), added}
}

/** A Makefile pair (no package.json — the non-npm ecosystem parity check). */
function makeAttempt(id: string, before: string, after: string): Attempt {
    const write = (cwd: string, text: string) => fs.writeFileSync(path.join(cwd, 'Makefile'), text)
    return {id, seed: cwd => write(cwd, before), apply: cwd => write(cwd, after), added: []}
}

// ── main ────────────────────────────────────────────────────────────────────

interface Check {
    name: string
    ok: boolean
    detail: string
}

async function main(): Promise<void> {
    const corpus: Attempt[] = []
    for (const repo of repos()) {
        for (const sha of fixCommits(repo)) {
            if (!gitOrNull(repo, ['rev-parse', `${sha}^`])) continue
            corpus.push(commitAttempt(repo, sha))
        }
    }
    if (corpus.length === 0) {
        console.log('ABSTAIN — no recorded fix commits in the corpus')
        process.exit(2)
    }

    const fixtures: Attempt[] = [
        pkgAttempt(
            'fixture:widening',
            {test: 'AGENT=1 bun test ./test'},
            {test: 'AGENT=1 bun test'}
        ),
        pkgAttempt(
            'fixture:env-and-flags',
            {test: 'bun test', lint: 'eslint . && tsc --noEmit'},
            {
                test: 'AGENT=1 bun test --bail --reporter junit',
                lint: 'tsc --noEmit && eslint .'
            }
        ),
        pkgAttempt(
            'fixture:new-script',
            {test: 'bun test'},
            {test: 'bun test', build: 'bun build ./src/index.ts --outdir dist'}
        ),
        makeAttempt(
            'fixture:makefile-narrow',
            'lint:\n\truff check .\n\ntest:\n\tpytest -q\n',
            'lint:\n\truff check .\n\ntest:\n\tpytest -q tests/unit\n'
        ),
        makeAttempt(
            'fixture:makefile-neutral',
            'test:\n\tpytest -q\n',
            'test:\n\tPYTHONPATH=. pytest -q --maxfail=1\n'
        ),
        pkgAttempt(
            'fixture:config-swap-created',
            {test: 'playwright test -c playwright.config.ts'},
            {test: 'playwright test -c playwright.smoke.ts'},
            ['playwright.smoke.ts']
        ),
        pkgAttempt(
            'fixture:label-vanished',
            {test: 'bun test', lint: 'eslint .'},
            {test: 'bun test'}
        )
    ]

    const all = [...corpus, ...fixtures]
    const base = new Map<string, ArmResult>()
    const treat = new Map<string, ArmResult>()
    for (const a of all) {
        base.set(a.id, await runArm(a, false))
        treat.set(a.id, await runArm(a, true))
    }

    const leadId = `${LEAD.repo}@${LEAD.sha}`
    const leadBase = base.get(leadId)
    const leadTreat = treat.get(leadId)

    console.log('per-attempt rejection sets (baseline → treatment):')
    for (const a of all) {
        const b = base.get(a.id)!
        const t = treat.get(a.id)!
        const mark = b.rejected === t.rejected ? ' ' : '*'
        console.log(
            `${mark} ${a.id.padEnd(28)} ${b.rejected ? 'REJECT' : '  ok  '} → ${t.rejected ? 'REJECT' : '  ok  '}`
        )
        if (t.rejected && !b.rejected) console.log(`      ${t.reason}`)
    }

    const checks: Check[] = []
    const corpusIds = new Set(corpus.map(a => a.id))

    // inv-label-guard-kept — every baseline rejection survives.
    const lost = all.filter(a => base.get(a.id)!.rejected && !treat.get(a.id)!.rejected)
    checks.push({
        name: 'inv-label-guard-kept',
        ok: lost.length === 0,
        detail:
            lost.length === 0 ?
                `all ${all.filter(a => base.get(a.id)!.rejected).length} baseline rejection(s) still made`
            :   `LOST: ${lost.map(a => a.id).join(', ')}`
    })

    // inv-no-new-rejections — no extra rejection on any OTHER recorded fix commit.
    const extra = corpus.filter(
        a => a.id !== leadId && !base.get(a.id)!.rejected && treat.get(a.id)!.rejected
    )
    checks.push({
        name: 'inv-no-new-rejections',
        ok: extra.length === 0,
        detail:
            extra.length === 0 ?
                `0 new rejections across ${corpusIds.size - 1} other fix commit(s)`
            :   `NEW: ${extra.map(a => `${a.id} — ${treat.get(a.id)!.reason}`).join(' | ')}`
    })

    const passes = (id: string) => !treat.get(id)!.rejected
    checks.push({
        name: 'inv-widening-allowed',
        ok: passes('fixture:widening'),
        detail: passes('fixture:widening') ? '`bun test ./test` → `bun test` passes' : (
            treat.get('fixture:widening')!.reason
        )
    })
    const flagsOk = passes('fixture:env-and-flags') && passes('fixture:new-script')
    checks.push({
        name: 'inv-env-and-flags-allowed',
        ok: flagsOk,
        detail:
            flagsOk ? 'added env/--bail/--reporter, reordering, and a new script all pass' : (
                `${treat.get('fixture:env-and-flags')!.reason} ${treat.get('fixture:new-script')!.reason}`
            )
    })
    const mkOk = treat.get('fixture:makefile-narrow')!.rejected && passes('fixture:makefile-neutral')
    checks.push({
        name: 'inv-makefile-parity',
        ok: mkOk,
        detail:
            mkOk ? 'Makefile `test:` gaining `tests/unit` is rejected; an env/flag edit is not' : (
                `narrow=${treat.get('fixture:makefile-narrow')!.rejected} neutral-ok=${passes('fixture:makefile-neutral')}`
            )
    })

    // inv-discard-path — every treatment rejection discarded the edits, set the
    // flags, and never reached the gate.
    const bad = all
        .map(a => treat.get(a.id)!)
        .filter(r => r.rejected && !(r.discarded && r.guardTripped && r.gateRuns === 0))
    checks.push({
        name: 'inv-discard-path',
        ok: bad.length === 0,
        detail:
            bad.length === 0 ?
                'every rejection discarded the edits, set guardTripped/editsDiscarded, and skipped the gate'
            :   `BROKEN: ${bad.map(r => r.id).join(', ')}`
    })

    console.log('\ninvariants:')
    for (const c of checks) {
        console.log(`  ${c.ok ? 'HOLD ' : 'BREAK'} ${c.name.padEnd(26)} ${c.detail}`)
    }

    const leadOk =
        leadBase !== undefined
        && leadTreat !== undefined
        && !leadBase.rejected
        && leadTreat.rejected
        && /\btest\b/.test(leadTreat.reason)
    console.log(
        `\nLEAD ${leadId}: baseline ${leadBase?.rejected ? 'REJECT' : 'ok'} → treatment ${
            leadTreat?.rejected ? 'REJECT' : 'ok'
        }${leadTreat?.rejected ? ` (${leadTreat.reason})` : ''}`
    )

    const ok = leadOk && checks.every(c => c.ok)
    console.log(`\nVERDICT: ${ok ? 'PASS' : 'FAIL'}`)
    process.exit(ok ? 0 : 1)
}

await main()
