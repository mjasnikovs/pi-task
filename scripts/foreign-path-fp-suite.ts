/**
 * Zero-FP + recall-floor suite for the sandbox-path-leak detector (nexttask
 * PROMPT 4 item 1) — run BEFORE wiring, and any time the patterns change.
 *
 * Method: scan every TRACKED source/config file of a real repo as if every line
 * were an added line (the worst case the verify probe can ever see — the real
 * probe only sees a task's diff, a strict subset). Ground truth is pure file
 * existence in the real trees; no model anywhere.
 *
 * Arms:
 *   • pi-task itself + real local repos (aiz-server, aiz-client, gofer):
 *     expected ZERO findings — any hit is a false positive to fix in the
 *     detector, not to excuse.
 *   • mx5 (run-13 evidence tree, READ-ONLY): expected exactly the two true
 *     positives in playwright-ct.config.ts — '/workspace/src/shared' and
 *     '/workspace/src/client/api' — the aliases that made `bun run test:ct`
 *     collect 63 tests and run 0.
 *
 * Run: PI_BIN=$(command -v pi) bun scripts/foreign-path-fp-suite.ts
 */
import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, statSync} from 'node:fs'
import * as path from 'node:path'
import {
    findForeignPaths,
    foreignPathVerifyFindings,
    relativeRepairFor
} from '../src/task/foreign-path.js'
import type {AddedLine} from '../src/task/probe-gaming.js'

const HUB = '/home/edgars/hub'
const REPO = path.resolve(import.meta.dir, '..')
const MAX_FILE_BYTES = 512 * 1024

let failures = 0

/** Every tracked file of a repo, as lines — the worst case the probe could see. */
function allTrackedLines(dir: string): {lines: AddedLine[]; files: number} {
    const listed = execFileSync('git', ['-C', dir, 'ls-files'], {encoding: 'utf8'})
    const lines: AddedLine[] = []
    let files = 0
    for (const rel of listed.split('\n').map(l => l.trim()).filter(Boolean)) {
        const abs = path.join(dir, rel)
        try {
            if (statSync(abs).size > MAX_FILE_BYTES) continue
            for (const text of readFileSync(abs, 'utf8').split('\n')) lines.push({path: rel, text})
            files++
        } catch {
            // unreadable/binary — nothing to scan
        }
    }
    return {lines, files}
}

function scanRepo(label: string, dir: string, expect: string[]): void {
    if (!existsSync(dir)) {
        console.log(`${label}: SKIP (missing)`)
        return
    }
    const t0 = Date.now()
    const {lines, files} = allTrackedLines(dir)
    const found = findForeignPaths(
        lines,
        abs => existsSync(abs),
        rel => existsSync(path.join(dir, rel))
    )
    const got = found.map(f => f.absolute).sort()
    const ok = JSON.stringify(got) === JSON.stringify([...expect].sort())
    console.log(
        `\n${label} (${Date.now() - t0}ms, ${files} files / ${lines.length} lines): `
            + `${found.length} finding(s) — ${ok ? 'OK' : 'MISMATCH'}`
    )
    for (const f of found) {
        console.log(`  - ${foreignPathVerifyFindings([f])[0]}`)
        console.log(`    repair → ${relativeRepairFor(f)}`)
    }
    if (!ok) {
        console.log(`  expected: ${JSON.stringify(expect)}`)
        failures++
    }
}

// Zero-FP arms — real repos with no sandbox leak.
scanRepo('pi-task (self)', REPO, [])
scanRepo('aiz-server', path.join(HUB, 'aiz-server'), [])
scanRepo('aiz-client', path.join(HUB, 'aiz-client'), [])
scanRepo('gofer', path.join(HUB, 'gofer'), [])

// True-positive arm: the run-13 evidence tree (READ-ONLY — never written to).
scanRepo('mx5 (run-13 evidence)', path.join(HUB, 'mx5'), [
    '/workspace/src/shared',
    '/workspace/src/client/api'
])

console.log(failures === 0 ? '\nALL ARMS OK' : `\n${failures} ARM(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
