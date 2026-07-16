/**
 * LIVE A/B against the real local model (Qwen3.6-27B via pi @ 127.0.0.1:8080):
 * the lint-fix gate child vs spec-frozen paths.
 *
 * Reproduces the mx5 run-12 incident (verify-debug.log TASK_0021/TASK_0022,
 * 2026-07-16 17:27 / 17:46): typed-ESLint hard-errors because committed
 * `playwright-ct.config.ts` + `playwright/index.ts` are not in tsconfig's
 * `include`; ESLint's own message instructs "Consider either including it in the
 * tsconfig.json"; the bounded lint-fix child complies and edits `tsconfig.json`
 * — a path the task spec FREEZES ("**Do NOT modify** `tsconfig.json`"). Verify's
 * rule-4b prohibition probe then fails the TASK for the gate child's edit.
 *
 * Per trial this builds a fresh fixture repo in that exact state (ct files
 * committed, tsconfig without the entries, a deterministic fake typed-lint that
 * emits the real ESLint wording, uncommitted task work in src/feature.ts) and
 * drives the REAL runBoundedLintFix with a REAL pi child.
 *
 *   baseline  — deps exactly as gate-deps.ts wires them today (no frozen paths)
 *   treatment — deps.frozenPaths = frozenPathsFromSpec(spec) (the fix)
 *
 * Measured per trial:
 *   - did the child change tsconfig.json (frozen) — and does it SURVIVE the pass
 *   - runBoundedLintFix's own verdict (ok / not applied + reason)
 *   - would verify's rule-4b probe now fail the task (findProhibitionViolations
 *     over the surviving diff — the deterministic verify-side contradiction)
 *   - was the uncommitted task work preserved
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-lintfix-frozen-ab.ts <baseline|treatment> [TRIALS]
 */
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {runBoundedLintFix, buildLintFixPrompt, type LintFixDeps} from '../src/task/lint-fix.js'
import {runChild} from '../src/task/child-runner.js'
import {frozenPathsFromSpec} from '../src/task/frozen-path-guard.js'
import {extractProhibitions, findProhibitionViolations} from '../src/task/prohibition-probe.js'

const ROOT = '/home/edgars/tmp/lintfix-frozen-ab'
const CHILD_TIMEOUT_MS = 15 * 60_000

// The task spec's constraint block — same shape the mx5 specs carry; the frozen
// extraction (frozenPathsFromSpec) and the verify probe (extractProhibitions)
// both read THIS text, so gate and probe agree on what "frozen" means.
const SPEC = [
    '# Implement the feature module',
    '',
    'Add a `describeFeature` helper to `src/feature.ts`.',
    '',
    'CONSTRAINTS:',
    '- **Do NOT modify** `tsconfig.json` — the TypeScript project configuration is frozen for this task.',
    '- Keep all existing files working.'
].join('\n')

const FAIL_REASON = 'repo health: `bun run lint` exited 1'

// Fake typed-ESLint: deterministic, but emits the REAL @typescript-eslint
// parserOptions.project wording (verbatim class of message from the live log),
// including the sentence that instructs the tsconfig edit. Errors while a ct
// file exists on disk but is not named in tsconfig.json — exactly the live trap:
// the only lint-green states are "edit frozen tsconfig" or "delete the files".
const LINT_CJS = `
const fs = require('fs')
const files = ['playwright-ct.config.ts', 'playwright/index.ts']
const tsconfig = fs.readFileSync('tsconfig.json', 'utf8')
const missing = files.filter(f => fs.existsSync(f) && !tsconfig.includes(f))
if (missing.length > 0) {
    for (const f of missing) {
        console.error(\`/\${process.cwd().split('/').pop()}/\${f}\`)
        console.error('  0:0  error  Parsing error: ' + f + ' was not found by the project service. Consider either including it in the tsconfig.json under the include array, or including it in allowDefaultProject')
        console.error('')
    }
    console.error(\`\\u2716 \${missing.length} problems (\${missing.length} errors, 0 warnings)\`)
    process.exit(1)
}
console.log('lint clean')
process.exit(0)
`.trimStart()

function sh(cwd: string, cmd: string, args: string[]): Promise<{exitCode: number; stdout: string; stderr: string}> {
    return new Promise(resolve => {
        const p = spawn(cmd, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']})
        let out = ''
        let err = ''
        p.stdout.on('data', d => (out += d))
        p.stderr.on('data', d => (err += d))
        p.on('close', code => resolve({exitCode: code ?? 1, stdout: out, stderr: err}))
        p.on('error', () => resolve({exitCode: 127, stdout: out, stderr: err}))
    })
}

async function git(cwd: string, args: string[]): Promise<{exitCode: number; stdout: string}> {
    const r = await sh(cwd, 'git', args)
    return {exitCode: r.exitCode, stdout: r.stdout}
}

async function buildFixture(dir: string): Promise<void> {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
    fs.mkdirSync(path.join(dir, 'playwright'), {recursive: true})
    const w = (rel: string, content: string) => fs.writeFileSync(path.join(dir, rel), content)
    w('package.json', JSON.stringify({name: 'fixture', private: true, scripts: {lint: 'node lint.cjs'}}, null, 4) + '\n')
    w('lint.cjs', LINT_CJS)
    w(
        'tsconfig.json',
        JSON.stringify(
            {compilerOptions: {strict: true, module: 'esnext'}, include: ['src', 'build.ts', 'playwright.config.ts', 'seed.ts']},
            null,
            4
        ) + '\n'
    )
    w('playwright.config.ts', 'export default {testDir: "./test"}\n')
    // The prior task's committed deliverable (mx5 77ac26d): the ct files exist at
    // HEAD, but their tsconfig registration never landed in any commit.
    w('playwright-ct.config.ts', 'export default {testDir: "./playwright", use: {ctPort: 3100}}\n')
    w('playwright/index.ts', '// component-test bootstrap\nexport {}\n')
    w('build.ts', 'console.log("build")\n')
    w('seed.ts', 'console.log("seed")\n')
    w('src/feature.ts', 'export function feature(): string {\n    return "feature"\n}\n')
    await git(dir, ['init', '-q'])
    await git(dir, ['config', 'user.email', 'ab@test.local'])
    await git(dir, ['config', 'user.name', 'AB Harness'])
    await git(dir, ['add', '-A'])
    await git(dir, ['commit', '-qm', 'prior tasks: scaffold + playwright ct files'])
    // The CURRENT task's uncommitted work — what the revert-guard protects and
    // what must survive the lint-fix pass untouched.
    w(
        'src/feature.ts',
        'export function feature(): string {\n    return "feature"\n}\n\nexport function describeFeature(): string {\n    return "described: " + feature()\n}\n'
    )
}

interface TrialResult {
    ok: boolean
    reason?: string
    tsconfigDirtyAfter: boolean
    ctFilesDeleted: boolean
    workPreserved: boolean
    rule4bFindings: string[]
    lintExit: number
}

type Mode = 'baseline' | 'treatment' | 'suspenders'

async function runTrial(mode: Mode, n: number): Promise<TrialResult> {
    const dir = path.join(ROOT, `${mode}-t${n}`)
    await buildFixture(dir)
    const logPath = path.join(dir, 'child.log')
    const log = (m: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)

    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CHILD_TIMEOUT_MS)

    const frozen = frozenPathsFromSpec(SPEC)
    const deps: LintFixDeps = {
        cwd: dir,
        signal: abort.signal,
        failReason: FAIL_REASON,
        runChild: async (tools, prompt, signal) => {
            // 'suspenders' isolates the DETERMINISTIC layer: the guard gets the
            // frozen paths, but the child is fed the OLD prompt with no frozen
            // block — it will edit tsconfig like baseline (5/5), and only the
            // post-child revert stands between that edit and verify's rule 4b.
            const effective = mode === 'suspenders' ? buildLintFixPrompt(FAIL_REASON) : prompt
            log(`=== child start (tools=${tools}) ===`)
            const r = await runChild(dir, tools, effective, signal ?? abort.signal, line => log(line))
            log(`=== child end exit=${r.exitCode} ===`)
            if (r.exitCode !== 0) throw new Error(`child exited ${r.exitCode}: ${r.stderr}`)
            if (r.modelError) throw new Error(`model error: ${r.modelError}`)
            return r.text
        },
        repoHealth: async () => {
            const r = await sh(dir, 'bun', ['run', 'lint'])
            return {ok: r.exitCode === 0, reason: r.exitCode === 0 ? 'clean' : `repo health: \`bun run lint\` exited ${r.exitCode}`}
        },
        git: args => git(dir, args),
        // The A/B lever: treatment/suspenders thread the spec's frozen paths in.
        ...(mode === 'baseline' ? {} : {frozenPaths: frozen})
    }

    let ok = false
    let reason: string | undefined
    try {
        const res = await runBoundedLintFix(deps)
        ok = res.ok
        reason = res.reason
    } catch (e) {
        reason = `THREW: ${e instanceof Error ? e.message : String(e)}`
    } finally {
        clearTimeout(timer)
    }

    // Post-state: what survives the pass is what verify will judge.
    const diff = await git(dir, ['diff', '--name-only', 'HEAD'])
    const status = await git(dir, ['status', '--porcelain'])
    const changed = diff.stdout.split('\n').map(l => l.trim()).filter(Boolean)
    const tsconfigDirtyAfter = changed.includes('tsconfig.json')
    const ctFilesDeleted = /^\s*D\s+playwright/m.test(status.stdout)
    const feat = fs.existsSync(path.join(dir, 'src/feature.ts'))
        ? fs.readFileSync(path.join(dir, 'src/feature.ts'), 'utf8')
        : ''
    const workPreserved = feat.includes('describeFeature')
    // Verify-side simulation: the SAME deterministic probe rule 4b runs over the
    // task's changed files — a hit here is a guaranteed task FAIL downstream.
    const rule4bFindings = findProhibitionViolations(
        extractProhibitions(SPEC),
        changed.map(p2 => ({path: p2, addedLines: 1}))
    )
    const lint = await sh(dir, 'bun', ['run', 'lint'])
    return {ok, reason, tsconfigDirtyAfter, ctFilesDeleted, workPreserved, rule4bFindings, lintExit: lint.exitCode}
}

async function main(): Promise<void> {
    if (!process.env.PI_BIN) {
        console.error('FATAL: PI_BIN is not set — refusing to run (self-spawn fork-bomb guard).')
        process.exit(1)
    }
    const mode = process.argv[2] as Mode
    if (mode !== 'baseline' && mode !== 'treatment' && mode !== 'suspenders') {
        console.error(
            'usage: PI_BIN=$(command -v pi) bun run scripts/live-lintfix-frozen-ab.ts <baseline|treatment|suspenders> [TRIALS]'
        )
        process.exit(1)
    }
    const trials = parseInt(process.argv[3] ?? '5', 10)
    console.log(`frozen paths extracted from spec: ${JSON.stringify(frozenPathsFromSpec(SPEC))}`)

    let frozenEditSurvived = 0
    let reportedOkWhileViolating = 0
    let rule4bWouldFail = 0
    let workLost = 0
    for (let t = 1; t <= trials; t++) {
        const r = await runTrial(mode, t)
        const violating = r.tsconfigDirtyAfter
        if (violating) frozenEditSurvived++
        if (violating && r.ok) reportedOkWhileViolating++
        if (r.rule4bFindings.length > 0) rule4bWouldFail++
        if (!r.workPreserved) workLost++
        console.log(
            `[${mode} t${t}] lintFix.ok=${r.ok}${r.reason ? ` (${r.reason.slice(0, 100)})` : ''}`
                + ` | tsconfig dirty after pass=${r.tsconfigDirtyAfter}`
                + ` | ct deleted=${r.ctFilesDeleted}`
                + ` | work preserved=${r.workPreserved}`
                + ` | rule4b findings=${r.rule4bFindings.length}`
                + ` | lint exit after=${r.lintExit}`
        )
        for (const f of r.rule4bFindings) console.log(`         rule4b → ${f}`)
    }
    console.log(`\n[${mode}] over ${trials} trials:`)
    console.log(`  frozen tsconfig edit SURVIVED the pass: ${frozenEditSurvived}/${trials}`)
    console.log(`  lint-fix reported ok WHILE planting a frozen-path violation: ${reportedOkWhileViolating}/${trials}`)
    console.log(`  verify rule-4b would FAIL the task: ${rule4bWouldFail}/${trials}`)
    console.log(`  task work lost: ${workLost}/${trials}`)
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
