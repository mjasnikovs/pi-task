/**
 * Replay for nexttask 15A part 2 — the per-task snapshot commit stops sweeping
 * untracked test-runner output into the index.
 *
 * THE RECORDED EPISODE. mx5 TASK_0027 (3e87014) ran the Playwright suite, three
 * screenshot assertions failed, and the runner wrote three `*-actual.png` files
 * into `test-results/`. The task's snapshot commit then ran a bare `git add -A`
 * and committed them. They became tracked deliverables, and the final gate's
 * next two fix attempts were rejected whole for deleting them — 6m14s of an 8m16s
 * gate. Verify the provenance yourself:
 *
 *     cd ~/hub/mx5 && git log --oneline --diff-filter=A -- \
 *       'test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png'
 *     → 3e87014 task: Polish … (TASK_0027)
 *
 * Fixture: mx5 as of 3e87014's PARENT, plus the three untracked `*-actual.png`
 * and a `.last-run.json`, plus the real src/ change the task made. Real git, real
 * `gitCommitAll`. No model.
 *
 *   bun run scripts/artifact-commit-replay.ts
 *
 * Exit 0 iff, in the treatment arm:
 *   - the task commit CONTAINS the src/ change, and
 *   - contains NO test-results/ path, and
 *   - `git status --porcelain` afterwards is empty of TRACKED changes, and
 *   - the excluded paths are reported back to the caller (not silently dropped),
 * and iff the baseline arm (`git add -A` at HEAD) commits the screenshots — i.e.
 * the replay reproduces the defect before it shows the fix.
 *
 * PLUS the tracked-path control, which is what stops the fix from being a
 * regression: a project that ALREADY tracks a path under one of these names must
 * still have its edits to that path committed.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {gitCommitAll} from '../src/task/auto-commit.js'

const ROOT = path.join(os.tmpdir(), `artifact-commit-replay-${process.pid}`)

const SCREENSHOTS = [
    'test-results/client-pages-AdminPage-Adm-89eae-nel-with-users-and-listings/admin-panel-default-actual.png',
    'test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png',
    'test-results/client-pages-LoginPage-LoginPage-screenshot-baseline/LoginPage-screenshot-baseline-1-actual.png'
]

function git(cwd: string, args: string[]): string {
    const r = spawnSync('git', ['-c', 'user.name=replay', '-c', 'user.email=replay@local', ...args], {
        cwd,
        encoding: 'utf8'
    })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
}

function write(dir: string, rel: string, body: string): void {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), {recursive: true})
    fs.writeFileSync(p, body)
}

/**
 * mx5 at 3e87014^ — the pre-task state — then the task's own work applied on top:
 * a real src/ edit plus the litter the Playwright run left behind.
 * `trackedArtifact` seeds an ALREADY-TRACKED `coverage/badge.svg`, for the control.
 */
function makeFixture(name: string, opts: {trackedArtifact: boolean}): string {
    const dir = path.join(ROOT, name)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    git(dir, ['init', '-q'])
    write(dir, 'package.json', '{"name":"mx5"}\n')
    write(dir, 'src/client/pages/admin.tsx', 'export const Admin = () => null\n')
    if (opts.trackedArtifact) write(dir, 'coverage/badge.svg', '<svg>old</svg>\n')
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'chore: checkpoint before "Polish"'])

    // The task's work: a real source edit …
    write(dir, 'src/client/pages/admin.tsx', 'export const Admin = () => <div>polished</div>\n')
    // … and what the failing Playwright run wrote, untracked.
    for (const s of SCREENSHOTS) write(dir, s, 'PNGDATA')
    write(dir, 'test-results/.last-run.json', '{"status":"failed"}\n')
    // … and, in the control, an edit to a path the project already tracks.
    if (opts.trackedArtifact) write(dir, 'coverage/badge.svg', '<svg>new</svg>\n')
    return dir
}

interface Arm {
    committedFiles: string[]
    excluded: string[]
    dirtyTracked: string[]
    untrackedLeft: string[]
}

/** Run one arm's commit and report exactly what landed. */
async function runArm(dir: string, mode: 'baseline' | 'treatment'): Promise<Arm> {
    if (mode === 'baseline') {
        // What shipped before 15A: a bare `git add -A`, verbatim.
        git(dir, ['add', '-A'])
        git(dir, ['commit', '-q', '-m', 'task: Polish (TASK_0027)'])
    } else {
        const res = await gitCommitAll(dir, 'task: Polish (TASK_0027)')
        if (!res.committed) throw new Error(`treatment did not commit: ${res.reason ?? '?'}`)
        return {
            committedFiles: git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean),
            excluded: res.excluded ?? [],
            dirtyTracked: git(dir, ['status', '--porcelain', '--untracked-files=no'])
                .split('\n')
                .filter(Boolean),
            untrackedLeft: git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
        }
    }
    return {
        committedFiles: git(dir, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean),
        excluded: [],
        dirtyTracked: git(dir, ['status', '--porcelain', '--untracked-files=no']).split('\n').filter(Boolean),
        untrackedLeft: git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)
    }
}

const hasTestResults = (files: string[]): boolean => files.some(f => f.startsWith('test-results/'))

async function main(): Promise<void> {
    fs.rmSync(ROOT, {recursive: true, force: true})
    fs.mkdirSync(ROOT, {recursive: true})

    const base = await runArm(makeFixture('baseline', {trackedArtifact: false}), 'baseline')
    const treat = await runArm(makeFixture('treatment', {trackedArtifact: false}), 'treatment')
    const control = await runArm(makeFixture('control', {trackedArtifact: true}), 'treatment')

    console.log('REPLAY — mx5 TASK_0027 (3e87014), the commit that made three failure screenshots tracked')
    console.log('')
    console.log('  baseline  (bare `git add -A`, as shipped)')
    console.log(`      committed: ${base.committedFiles.join(', ')}`)
    console.log(`      → test-results/ in the commit: ${hasTestResults(base.committedFiles)}   (the defect)`)
    console.log('  treatment (gitCommitAll, working tree)')
    console.log(`      committed: ${treat.committedFiles.join(', ')}`)
    console.log(`      excluded (reported): ${treat.excluded.join(', ') || '(none)'}`)
    console.log(`      dirty tracked after: ${treat.dirtyTracked.join(', ') || '(clean)'}`)
    console.log(`      untracked left on disk: ${treat.untrackedLeft.length} file(s)`)

    const defectReproduced = hasTestResults(base.committedFiles)
    const srcCommitted = treat.committedFiles.includes('src/client/pages/admin.tsx')
    const noArtifacts = !hasTestResults(treat.committedFiles)
    const cleanTracked = treat.dirtyTracked.length === 0
    const reported = treat.excluded.length === 4 && treat.excluded.every(p => p.startsWith('test-results/'))

    console.log('')
    console.log('CONTROL — a path the project ALREADY tracks must still be committed')
    console.log(`      committed: ${control.committedFiles.join(', ')}`)
    console.log(`      excluded (reported): ${control.excluded.join(', ') || '(none)'}`)
    const trackedStillCommitted =
        control.committedFiles.includes('coverage/badge.svg')
        && !control.excluded.includes('coverage/badge.svg')

    const checks: Array<[string, boolean]> = [
        ['baseline reproduces the defect (commits test-results/)', defectReproduced],
        ['treatment commits the src/ change', srcCommitted],
        ['treatment commits no test-results/ path', noArtifacts],
        ['treatment leaves no dirty TRACKED change behind', cleanTracked],
        ['treatment reports the 4 excluded paths to its caller', reported],
        ['control: tracked coverage/badge.svg edit still committed', trackedStillCommitted]
    ]
    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)

    fs.rmSync(ROOT, {recursive: true, force: true})
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
