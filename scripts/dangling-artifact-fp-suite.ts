/**
 * Zero-FP fixture suite for the dangling-artifact extractor (nexttask PROMPT 2
 * item 4) — run BEFORE wiring, and any time the patterns change.
 *
 * Arms:
 *   • pi-task itself + real local repos (aiz-server, aiz-client, gofer):
 *     expected ZERO findings — any hit is a false positive to fix in the
 *     extractor, not to excuse.
 *   • mx5 (evidence tree, READ-ONLY), at two PINNED commits: the run-13 true
 *     positive src/server/index.ts → dist/index.html at 4880e79, and the run-18
 *     generated-HTML true positive build.ts → dist/app.css at a9c6145 — plus,
 *     on the real DESIGN/PROJECT.md, the plan-time prose dangle `index.html`.
 *
 * WHY THE mx5 ARMS ARE PINNED (2026-07-30). They used to scan `~/hub/mx5` at
 * whatever it happened to be. That tree kept running: by run 18 its HEAD carried
 * the final-gate autofix, the run-13 dangle had been closed, and this suite —
 * the regression net for artifact-closure.ts — had been silently RED for reasons
 * that had nothing to do with the extractor. A net that goes red on its own is a
 * net nobody reads. Each arm now scans a `git archive` export of a named commit
 * (scripts/html-asset-closure-corpus.ts); the evidence repo is never checked out
 * or written to.
 *
 * Ground truth is file existence + parsed build outputs of real trees — no
 * model anywhere.
 *
 * Run: bun scripts/dangling-artifact-fp-suite.ts
 */
import {existsSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {
    findDanglingArtifacts,
    findSpecDanglingArtifacts,
    danglingGateFailureText
} from '../src/task/artifact-closure.js'
import {HUB, MX5_COMMITS, REPO, mx5Snapshot} from './html-asset-closure-corpus.js'

let failures = 0

function scanRepo(label: string, dir: string | null, expectPaths: string[]): void {
    if (dir === null || !existsSync(dir)) {
        console.log(`${label}: SKIP (missing)`)
        return
    }
    const t0 = Date.now()
    const found = findDanglingArtifacts(dir)
    const paths = found.map(f => f.path).sort()
    const ok = JSON.stringify(paths) === JSON.stringify([...expectPaths].sort())
    console.log(`\n${label} (${Date.now() - t0}ms): ${found.length} finding(s) — ${ok ? 'OK' : 'MISMATCH'}`)
    for (const f of found) console.log(`  - ${danglingGateFailureText(f)}`)
    if (!ok) {
        console.log(`  expected: ${JSON.stringify(expectPaths)}`)
        failures++
    }
}

// Zero-FP arms.
scanRepo('pi-task (self)', REPO, [])
scanRepo('aiz-server', path.join(HUB, 'aiz-server'), [])
scanRepo('aiz-client', path.join(HUB, 'aiz-client'), [])
scanRepo('gofer', path.join(HUB, 'gofer'), [])

// True-positive arms: the evidence tree at two pinned commits (read-only exports).
const preAutofix = mx5Snapshot(MX5_COMMITS.preAutofix)
scanRepo(`mx5 @ ${MX5_COMMITS.preAutofix} (run-13 evidence)`, preAutofix, ['dist/index.html'])
// Run 18: the autofix closed that one by generating an index.html pointing at
// /app.css, which only the watch-mode `dev:css` script produces (nexttask 3).
scanRepo(`mx5 @ ${MX5_COMMITS.postAutofix} (run-18 autofix)`, mx5Snapshot(MX5_COMMITS.postAutofix), [
    'dist/app.css'
])

// Plan-time arm: the real spec text, from the same pinned export.
const specPath = path.join(preAutofix ?? path.join(HUB, 'mx5'), 'DESIGN/PROJECT.md')
if (existsSync(specPath)) {
    const spec = readFileSync(specPath, 'utf8')
    const out = findSpecDanglingArtifacts(spec, rel =>
        existsSync(path.join(HUB, 'mx5-greenfield-does-not-exist', rel))
    )
    const paths = out.map(o => o.path).sort()
    const ok = JSON.stringify(paths) === JSON.stringify(['index.html'])
    console.log(`\nmx5 spec (plan-time, greenfield): ${out.length} finding(s) — ${ok ? 'OK' : 'MISMATCH'}`)
    for (const o of out) console.log(`  - ${o.path} (${o.construct}): ${o.reason}`)
    if (!ok) failures++
}

console.log(failures === 0 ? '\nFP SUITE: PASS' : `\nFP SUITE: FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
