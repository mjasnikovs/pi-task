/**
 * Zero-FP fixture suite for the dangling-artifact extractor (nexttask PROMPT 2
 * item 4) — run BEFORE wiring, and any time the patterns change.
 *
 * Arms:
 *   • pi-task itself + real local repos (aiz-server, aiz-client, gofer):
 *     expected ZERO findings — any hit is a false positive to fix in the
 *     extractor, not to excuse.
 *   • mx5 (run-13 evidence tree, READ-ONLY): expected exactly the true
 *     positive — src/server/index.ts → dist/index.html — and, on the real
 *     DESIGN/PROJECT.md, the plan-time prose dangle `index.html`.
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

const HUB = '/home/edgars/hub'
const REPO = path.resolve(import.meta.dir, '..')

let failures = 0

function scanRepo(label: string, dir: string, expectPaths: string[]): void {
    if (!existsSync(dir)) {
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

// True-positive arm: the run-13 evidence tree (read-only).
scanRepo('mx5 (run-13 evidence)', path.join(HUB, 'mx5'), ['dist/index.html'])

// Plan-time arm: the real spec text.
const specPath = path.join(HUB, 'mx5/DESIGN/PROJECT.md')
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
