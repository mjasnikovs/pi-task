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
import {gitCommitAll} from '../src/task/auto-commit.js'
import {scratchGit as git, scratchRoot} from './scratch-repo.js'

const ROOT = scratchRoot('artifact-commit-replay')

const SCREENSHOTS = [
    'test-results/client-pages-AdminPage-Adm-89eae-nel-with-users-and-listings/admin-panel-default-actual.png',
    'test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png',
    'test-results/client-pages-LoginPage-LoginPage-screenshot-baseline/LoginPage-screenshot-baseline-1-actual.png'
]

/**
 * mx5 at 3e87014^ — the pre-task state — then the task's own work applied on top:
 * a real src/ edit plus the litter the Playwright run left behind.
 * `trackedArtifact` seeds an ALREADY-TRACKED `coverage/badge.svg`, for the control.
 */
function makeFixture(name: string, opts: {trackedArtifact: boolean}): string {
    const repo = ROOT.repo(name, {
        files: {
            'package.json': '{"name":"mx5"}\n',
            'src/client/pages/admin.tsx': 'export const Admin = () => null\n',
            ...(opts.trackedArtifact ? {'coverage/badge.svg': '<svg>old</svg>\n'} : {})
        },
        commit: 'chore: checkpoint before "Polish"'
    })

    // The task's work: a real source edit …
    repo.write('src/client/pages/admin.tsx', 'export const Admin = () => <div>polished</div>\n')
    // … and what the failing Playwright run wrote, untracked.
    for (const s of SCREENSHOTS) repo.write(s, 'PNGDATA')
    repo.write('test-results/.last-run.json', '{"status":"failed"}\n')
    // … and, in the control, an edit to a path the project already tracks.
    if (opts.trackedArtifact) repo.write('coverage/badge.svg', '<svg>new</svg>\n')
    return repo.dir
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

    ROOT.remove()
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
