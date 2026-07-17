/**
 * Run-13 replay for the ARTIFACT-PRODUCTION CLOSURE (nexttask PROMPT 2 item 5)
 * — deterministic, NO model involved (both seams are host-side scans).
 *
 * Reproduces the mx5 run of 2026-07-16→17: the server's SPA fallback reads
 * `Bun.file('dist/index.html')`; the build emits ONLY dist/app.css (tailwind
 * -o) + dist/main.js (Bun.build entrypoint). No task, script, or build output
 * ever creates index.html — the shipped app 404s on every non-API GET while
 * coverage reports "0 unowned".
 *
 * Fixture (fresh dir per arm): the run-13 tree shape with a REAL runnable
 * build (`bun build.ts` actually emits dist/main.js), a green test script, and
 * the dangling server read. Ground truth is the gate's returned outcome object
 * — file existence and parsed build outputs of a real tree, never self-report.
 *
 * Arms:
 *   gate baseline  — final-gate.ts at git HEAD (throwaway worktree): expect NO
 *                    dangling-artifact failure (ships silently today).
 *   gate treatment — working tree: expect a ranked `dangling artifact:` failure
 *                    naming src/server/index.ts → dist/index.html, ranked first.
 *   plan-time      — treatment-only (the channel does not exist at baseline —
 *                    silence is structural): the distilled spec text flags
 *                    `index.html` unowned; a coverage round that adds a
 *                    producing title clears it.
 *
 * Run: bun scripts/replay-run13-dangling-artifact.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TMP_ROOT = '/home/edgars/tmp'
const REPO = path.resolve(import.meta.dir, '..')

function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'run13-dangling-'))
    fs.mkdirSync(path.join(dir, 'src/server'), {recursive: true})
    fs.mkdirSync(path.join(dir, 'src/client'), {recursive: true})
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(
            {
                name: 'run13-dangling-fixture',
                scripts: {test: 'exit 0', build: 'bun build.ts'}
            },
            null,
            2
        )
    )
    // The real build.ts shape minus tailwind (not installed here): Bun.build
    // emits dist/main.js; app.css is an explicit Bun.write output. index.html
    // appears in NEITHER.
    fs.writeFileSync(
        path.join(dir, 'build.ts'),
        [
            "import * as fs from 'node:fs'",
            "fs.mkdirSync('dist', {recursive: true})",
            "await Bun.write('dist/app.css', '/* css */')",
            "await Bun.build({entrypoints: ['src/client/main.tsx'], outdir: 'dist'})"
        ].join('\n')
    )
    fs.writeFileSync(
        path.join(dir, 'src/server/index.ts'),
        [
            '// SPA fallback: serve dist/index.html for GETs that miss /api',
            "const htmlFile = Bun.file('dist/index.html')",
            'export const dangling = htmlFile'
        ].join('\n')
    )
    fs.writeFileSync(path.join(dir, 'src/client/main.tsx'), 'export const x = 1\n')
    return dir
}

interface Outcome {
    ok: boolean
    reason: string
    failures?: string[]
}

async function runGateArm(label: string, modulePath: string): Promise<Outcome> {
    const mod = (await import(modulePath)) as {
        runFinalIntegrationGate: (cwd: string, timeoutMs?: number) => Promise<Outcome>
    }
    const dir = makeFixture()
    try {
        const out = await mod.runFinalIntegrationGate(dir, 120_000)
        console.log(`\n=== ${label} ===`)
        console.log(`ok: ${out.ok}`)
        console.log(`failures: ${out.failures ? JSON.stringify(out.failures, null, 2) : '(none)'}`)
        return out
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

const SPEC = [
    '## 3. File tree',
    '```',
    '├─ src/',
    '│  └─ client/',
    '│     ├─ main.tsx               # React root',
    '│     ├─ index.css              # tailwind',
    '```',
    '',
    '**SPA fallback:** non-`/api` GETs serve the built `index.html`.',
    '',
    '## 9. Build & run',
    '- **Client CSS:** `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`',
    '- **Client JS:** `Bun.build({ entrypoints: ["src/client/main.tsx"], outdir: "dist" })`'
].join('\n')

async function main(): Promise<void> {
    fs.mkdirSync(TMP_ROOT, {recursive: true})
    const wt = fs.mkdtempSync(path.join(TMP_ROOT, 'run13-dangling-wt-'))
    execFileSync('git', ['worktree', 'add', '--detach', wt, 'HEAD'], {cwd: REPO, stdio: 'pipe'})
    try {
        const base = await runGateArm('GATE BASELINE (git HEAD)', path.join(wt, 'src/task/final-gate.ts'))
        const treat = await runGateArm(
            'GATE TREATMENT (working tree)',
            path.join(REPO, 'src/task/final-gate.ts')
        )
        const isDangle = (f: string): boolean =>
            f.startsWith('dangling artifact:')
            && f.includes('src/server/index.ts')
            && f.includes('dist/index.html')
        const baseSilent = !(base.failures ?? [base.reason]).some(isDangle)
        const treatFails = !treat.ok && (treat.failures ?? []).some(isDangle)
        const rankedFirst = isDangle(treat.failures?.[0] ?? '')

        // Plan-time seam (treatment only — channel absent at baseline).
        const closure = (await import(path.join(REPO, 'src/task/artifact-closure.ts'))) as {
            findSpecDanglingArtifacts: (
                s: string,
                e: (rel: string) => boolean
            ) => Array<{path: string}>
            titlesCoverArtifact: (titles: string[], ref: {path: string}) => boolean
        }
        const dangles = closure.findSpecDanglingArtifacts(SPEC, () => false)
        const planFlags = dangles.length === 1 && dangles[0].path === 'index.html'
        const backendOnly = ['Build the API server', 'Set up Postgres schema']
        const withProducer = [...backendOnly, 'Create index.html SPA shell served by the fallback']
        const unownedBefore = planFlags && !closure.titlesCoverArtifact(backendOnly, dangles[0])
        const ownedAfter = planFlags && closure.titlesCoverArtifact(withProducer, dangles[0])

        console.log('\n=== VERDICT ===')
        console.log(`gate baseline ships the dangle silently: ${baseSilent} (expected true)`)
        console.log(`gate treatment FAILS naming referencer+path: ${treatFails} (expected true)`)
        console.log(`gate treatment ranks it first: ${rankedFirst} (expected true)`)
        console.log(`plan-time flags the spec dangle: ${planFlags} (expected true)`)
        console.log(`unowned until a title claims it: ${unownedBefore} (expected true)`)
        console.log(`coverage round assigning a producer clears it: ${ownedAfter} (expected true)`)
        const pass =
            baseSilent && treatFails && rankedFirst && planFlags && unownedBefore && ownedAfter
        console.log(pass ? '\nREPLAY: PASS' : '\nREPLAY: FAIL')
        process.exitCode = pass ? 0 : 1
    } finally {
        execFileSync('git', ['worktree', 'remove', '--force', wt], {cwd: REPO, stdio: 'pipe'})
    }
}

void main()
