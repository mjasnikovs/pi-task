/**
 * A/B + FP suite for nexttask 15A part 1 — the deletion guard stops rejecting a
 * fix pass over regenerable test-runner output, and still rejects everything it
 * rejected before.
 *
 * THE RECORDED EPISODE (mx5 run 20, `.pi-tasks/final-gate-debug.log`):
 *
 *     08:36:47  tree changes: MODIFIED [package.json, src/client/api.test.tsx]
 *               DELETED [3 × test-results/…-actual.png]
 *     08:36:47  DELETION GUARD — … edits discarded
 *     08:40:44  same three deletions again, attempt 2, discarded again
 *     08:42:13  attempt 3 re-does the api.test.tsx repair and keeps it
 *
 * The three files are Playwright FAILURE screenshots (`*-actual.png` exists only
 * when a screenshot assertion failed). They were tracked because TASK_0027's own
 * `git add -A` swept them in (mx5 3e87014). 6m14s of an 8m16s gate, and two
 * thirds of the repair budget, spent on files that regenerate on the next test
 * run — and the pipeline then committed those exact three deletions anyway, in
 * the stranded-fix commit (mx5 5d4147e), so the guard did not even preserve what
 * it rejected two attempts to protect.
 *
 * Deterministic: no model. The fix child is a fake that performs the recorded
 * edits on disk; git, `parseTreeChanges` and the real `runFinalGateAutofix` seam
 * are all live in BOTH arms. The baseline arm runs against a `git archive HEAD`
 * export of `src/` — the whole shipped module graph, imported from a temp dir —
 * so the comparison is shipped code vs working tree, not a re-implementation of
 * one against the other. An earlier version of this script injected the arm's
 * guard through `treeChanges` instead; that was wrong, because the guard call
 * INSIDE `runFinalGateAutofix` is the working-tree one either way, and both arms
 * came out identical.
 *
 *   bun run scripts/artifact-deletion-guard-ab.ts
 *
 * Exit 0 iff BOTH gates pass:
 *   A/B  baseline REJECTS the attempt and discards its edits;
 *        treatment ACCEPTS and keeps BOTH modified files.
 *   FP   every real-deliverable deletion still REJECTS (admin.tsx,
 *        playwright-ct.config.ts, playwright/index.ts — the fixtures
 *        `scripts/live-crosstask-deletion-ab.ts` exists for), a `dist/app.css`
 *        deletion still REJECTS, and a rename still passes.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runFinalGateAutofix, type FinalFixDeps} from '../src/task/final-gate-fix.js'
import {parseTreeChanges, findForbiddenDeletions, type TreeChangeSummary} from '../src/task/write-guard.js'

const ROOT = path.join(os.tmpdir(), `artifact-deletion-guard-ab-${process.pid}`)

/** The three run-20 screenshots, verbatim from the debug log. */
const SCREENSHOTS = [
    'test-results/client-pages-AdminPage-Adm-89eae-nel-with-users-and-listings/admin-panel-default-actual.png',
    'test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png',
    'test-results/client-pages-LoginPage-LoginPage-screenshot-baseline/LoginPage-screenshot-baseline-1-actual.png'
]

function git(cwd: string, args: string[]): string {
    const r = spawnSync('git', ['-c', 'user.name=ab', '-c', 'user.email=ab@local', ...args], {
        cwd,
        encoding: 'utf8'
    })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
    return r.stdout
}

function write(dir: string, rel: string, body: string): void {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), {recursive: true})
    fs.writeFileSync(p, body)
}

/**
 * The run-20 repository as of TASK_0027 (3e87014): the two files the fix pass
 * modifies, plus the three screenshots the task's `git add -A` swept in, all
 * committed under a real task-commit subject.
 */
function makeFixture(name: string): string {
    const dir = path.join(ROOT, name)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    git(dir, ['init', '-q'])
    write(dir, 'package.json', JSON.stringify({name: 'mx5', scripts: {test: 'bun test'}}, null, 2) + '\n')
    write(dir, 'src/client/api.test.tsx', "test('api', () => { expect(1).toBe(2) })\n")
    write(dir, 'src/client/pages/admin.tsx', 'export const Admin = () => null\n')
    write(dir, 'playwright-ct.config.ts', 'export default {}\n')
    write(dir, 'playwright/index.ts', 'export {}\n')
    write(dir, 'dist/app.css', 'body{}\n')
    for (const s of SCREENSHOTS) write(dir, s, 'PNGDATA')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'task: Polish — … (TASK_0027)'])
    return dir
}

/** Same invocation gate-deps.ts:337 uses, so the arms see the pipeline's own view. */
const porcelain = (dir: string): TreeChangeSummary =>
    parseTreeChanges(git(dir, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks']))

interface GateModules {
    runFinalGateAutofix: (deps: FinalFixDeps) => Promise<{ok: boolean; reason?: string}>
    parseTreeChanges: (s: string) => TreeChangeSummary
    findForbiddenDeletions: (c: TreeChangeSummary) => string[]
}

/**
 * The whole shipped `src/` tree as of git HEAD, exported with `git archive` and
 * imported from a temp dir. Exporting the tree rather than a single file matters:
 * `final-gate-fix.ts` calls `findForbiddenDeletions` through a relative import, so
 * swapping only `write-guard.ts` would leave the guard inside the seam untouched.
 */
async function headModules(): Promise<GateModules> {
    const dir = path.join(ROOT, '_head')
    fs.mkdirSync(dir, {recursive: true})
    const tar = spawnSync('git', ['archive', 'HEAD', 'src'], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024})
    if (tar.status !== 0) throw new Error('git archive HEAD src failed')
    const tarPath = path.join(dir, 'head.tar')
    fs.writeFileSync(tarPath, tar.stdout)
    const untar = spawnSync('tar', ['-xf', tarPath, '-C', dir])
    if (untar.status !== 0) throw new Error('tar extract failed')
    const fix = (await import(path.join(dir, 'src/task/final-gate-fix.js'))) as {
        runFinalGateAutofix: GateModules['runFinalGateAutofix']
    }
    const wg = (await import(path.join(dir, 'src/task/write-guard.js'))) as {
        parseTreeChanges: GateModules['parseTreeChanges']
        findForbiddenDeletions: GateModules['findForbiddenDeletions']
    }
    return {runFinalGateAutofix: fix.runFinalGateAutofix, ...wg}
}

interface ArmResult {
    ok: boolean
    reason: string
    apiTestRepaired: boolean
    packageJsonEdited: boolean
}

/**
 * One arm: run that arm's own `runFinalGateAutofix` over the fixture with a fake
 * child that performs run 20's recorded attempt-1 edits, and report what the tree
 * holds afterwards. The arm's module graph is the ONLY difference.
 */
async function runArm(name: string, mods: GateModules): Promise<ArmResult> {
    const dir = makeFixture(name)

    // The fake fix child: the two real repairs, plus `rm` on the three
    // screenshots — byte-for-byte what run 20's attempt 1 did.
    const runChild = (): Promise<string> => {
        write(dir, 'src/client/api.test.tsx', "test('api', () => { expect(1).toBe(1) })\n")
        write(
            dir,
            'package.json',
            JSON.stringify({name: 'mx5', scripts: {test: 'bun test', seed: 'bun run src/server/seed.ts'}}, null, 2)
                + '\n'
        )
        for (const s of SCREENSHOTS) fs.rmSync(path.join(dir, s))
        return Promise.resolve('fixed the failing assertion')
    }

    const deps: FinalFixDeps = {
        cwd: dir,
        failReason: 'test: `bun run test` exited 1',
        runChild,
        gate: () => Promise.resolve({ok: true, reason: 'gate green'}),
        discoverLabels: () => ['test'],
        discard: (c: string) => {
            git(c, ['checkout', '--', '.'])
            git(c, ['clean', '-fdq'])
            return Promise.resolve()
        },
        // Parsed by the ARM's own write-guard, exactly as gate-deps.ts:337 does.
        treeChanges: () =>
            Promise.resolve(
                mods.parseTreeChanges(git(dir, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks']))
            )
    }

    const res = await mods.runFinalGateAutofix(deps)
    const apiTest = fs.readFileSync(path.join(dir, 'src/client/api.test.tsx'), 'utf8')
    const pkg = fs.readFileSync(path.join(dir, 'package.json'), 'utf8')
    return {
        ok: res.ok,
        reason: res.reason ?? '',
        apiTestRepaired: apiTest.includes('toBe(1)'),
        packageJsonEdited: pkg.includes('seed')
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FP suite — mandatory. Each case is a real deletion the guard MUST keep
// rejecting; the first three are the fixtures `live-crosstask-deletion-ab.ts`
// exists for (a fix child deleted the ct files to make typed-lint go green).
// ─────────────────────────────────────────────────────────────────────────────

interface FpCase {
    label: string
    delete: string[]
    /** Files created alongside — the rename allowance. */
    add?: Array<{from: string; to: string}>
    mustReject: boolean
}

const FP_CASES: FpCase[] = [
    {label: 'deliverable: src/client/pages/admin.tsx', delete: ['src/client/pages/admin.tsx'], mustReject: true},
    {label: 'deliverable: playwright-ct.config.ts', delete: ['playwright-ct.config.ts'], mustReject: true},
    {label: 'deliverable: playwright/index.ts', delete: ['playwright/index.ts'], mustReject: true},
    {label: 'both ct files at once (run 12)', delete: ['playwright-ct.config.ts', 'playwright/index.ts'], mustReject: true},
    {label: 'build output: dist/app.css', delete: ['dist/app.css'], mustReject: true},
    {
        // The relocation allowance, "as today": the target lands in an ALREADY
        // TRACKED directory. `git status --porcelain` without `-uall` — which is
        // what gate-deps.ts:337 runs — collapses a brand-new directory to `?? dir/`,
        // so a move into a NEW directory has no same-basename add to match and is
        // rejected by the shipped guard too. That is pre-existing behaviour, not
        // something 15A touches, and the fixture must not pretend otherwise.
        label: 'relocation: admin.tsx → src/client/admin.tsx',
        delete: ['src/client/pages/admin.tsx'],
        add: [{from: 'src/client/pages/admin.tsx', to: 'src/client/admin.tsx'}],
        mustReject: false
    },
    {label: 'the run-20 screenshots', delete: SCREENSHOTS, mustReject: false}
]

function runFp(): {pass: boolean; lines: string[]} {
    const lines: string[] = []
    let pass = true
    for (const c of FP_CASES) {
        const dir = makeFixture(`fp-${c.label.replace(/[^a-z0-9]+/gi, '-')}`)
        for (const m of c.add ?? []) {
            const body = fs.readFileSync(path.join(dir, m.from), 'utf8')
            write(dir, m.to, body)
        }
        for (const p of c.delete) fs.rmSync(path.join(dir, p))
        const gone = findForbiddenDeletions(porcelain(dir))
        const rejected = gone.length > 0
        const ok = rejected === c.mustReject
        if (!ok) pass = false
        lines.push(
            `  ${ok ? 'ok  ' : 'FAIL'}  ${c.mustReject ? 'REJECTS' : 'passes '}  ${c.label}`
                + (rejected ? `  → ${gone.join(', ')}` : '')
        )
    }
    return {pass, lines}
}

async function main(): Promise<void> {
    fs.rmSync(ROOT, {recursive: true, force: true})
    fs.mkdirSync(ROOT, {recursive: true})

    const head = await headModules()
    const baseline = await runArm('baseline', head)
    const treatment = await runArm('treatment', {runFinalGateAutofix, parseTreeChanges, findForbiddenDeletions})

    console.log('A/B — mx5 run 20 attempt 1, replayed through runFinalGateAutofix')
    console.log('')
    console.log(`  baseline  (src/ @ git HEAD)`)
    console.log(`      ok=${baseline.ok}  reason=${baseline.reason.slice(0, 110)}`)
    console.log(`      api.test.tsx repair kept: ${baseline.apiTestRepaired}   package.json edit kept: ${baseline.packageJsonEdited}`)
    console.log(`  treatment (working tree)`)
    console.log(`      ok=${treatment.ok}  reason=${treatment.reason.slice(0, 110)}`)
    console.log(`      api.test.tsx repair kept: ${treatment.apiTestRepaired}   package.json edit kept: ${treatment.packageJsonEdited}`)

    const abPass =
        baseline.ok === false
        && /DELETED tracked file/.test(baseline.reason)
        && baseline.apiTestRepaired === false
        && baseline.packageJsonEdited === false
        && treatment.ok === true
        && treatment.apiTestRepaired === true
        && treatment.packageJsonEdited === true

    console.log('')
    console.log(`  A/B: ${abPass ? 'PASS' : 'FAIL'} — baseline must reject and lose both repairs; treatment must accept and keep both`)

    const fp = runFp()
    console.log('')
    console.log('FP suite — every real deletion must still reject')
    for (const l of fp.lines) console.log(l)
    console.log('')
    console.log(`  FP: ${fp.pass ? 'PASS' : 'FAIL'}`)

    fs.rmSync(ROOT, {recursive: true, force: true})

    const verdict = abPass && fp.pass
    console.log('')
    console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
