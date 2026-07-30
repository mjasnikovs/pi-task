/**
 * Zero-FP suite for the boot-skip → UNOBSERVED lever (nexttask 1) — run BEFORE
 * wiring, and any time the predicate changes. Modelled on
 * scripts/dangling-artifact-fp-suite.ts: real trees, an expected count of zero,
 * and any hit is a bug in the predicate rather than something to excuse.
 *
 * The two invariants that carry the FP burden are decidable from PURE inputs, with
 * no command execution at all:
 *
 *   inv-nothing-to-boot   discoverBootCommand(tree) === null  ⇒ the lever cannot fire
 *   inv-cli-unaffected    detectsServedApp(tree) === false    ⇒ the lever cannot fire
 *
 * So the suite asks each real tree the WORST-CASE question — "if your boot had
 * skipped, would the lever speak?" — by calling bootSkipVerdict with `skipped:
 * true` forced. A tree in either invariant class must answer null even under that
 * assumption. That is strictly stronger than observing it stay quiet on a run where
 * its boot happened to succeed.
 *
 * Trees where the lever WOULD speak are printed as the blast radius, not as
 * failures: a served app with a discoverable boot command is exactly the population
 * the lever is for, and seeing which local repos are in it is the point.
 *
 * Everything here is read-only — no clone, no spawn, no writes.
 *
 * Run: bun run scripts/boot-skip-fp-suite.ts
 */
import {existsSync, readdirSync} from 'node:fs'
import * as path from 'node:path'
import {bootSkipVerdict, detectsServedApp, discoverBootCommand} from '../src/task/final-gate.js'
import {HUB, REPO} from './boot-skip-corpus.js'

interface Row {
    label: string
    dir: string
    bootLabel: string | null
    expectServer: boolean
    /** What the lever says if we ASSUME the boot skipped — the worst case. */
    note: string | null
}

function inspect(label: string, dir: string): Row | null {
    if (!existsSync(path.join(dir, 'package.json')) && !existsSync(path.join(dir, 'Makefile'))) {
        // Still worth a row: "no manifest at all" is the strongest nothing-to-boot case.
        if (!existsSync(dir)) return null
    }
    const boot = discoverBootCommand(dir)
    const bootLabel = boot ? `${boot[0]} ${boot[1].join(' ')}` : null
    const expectServer = detectsServedApp(dir)
    return {
        label,
        dir,
        bootLabel,
        expectServer,
        note: bootSkipVerdict({label: bootLabel, skipped: true, expectServer})
    }
}

const rows: Row[] = []
const self = inspect('pi-task (self)', REPO)
if (self) rows.push(self)
// Every sibling checkout under ~/hub, so the suite widens as the box does rather
// than being pinned to the four repos that happened to exist when it was written.
if (existsSync(HUB)) {
    for (const name of readdirSync(HUB).sort()) {
        const dir = path.join(HUB, name)
        const r = inspect(name, dir)
        if (r) rows.push(r)
    }
}

const nothingToBoot = rows.filter(r => r.bootLabel === null)
const cli = rows.filter(r => r.bootLabel !== null && !r.expectServer)
const wouldFire = rows.filter(r => r.note !== null)

let failures = 0

function arm(name: string, list: Row[]): void {
    const bad = list.filter(r => r.note !== null)
    console.log(`\n${name}: ${list.length} tree(s), ${bad.length} finding(s) — ${bad.length === 0 ? 'OK' : 'FALSE POSITIVE'}`)
    for (const r of list) {
        console.log(`  - ${r.label.padEnd(18)} boot ${(r.bootLabel ?? 'none').padEnd(16)} served ${String(r.expectServer).padEnd(5)}${r.note ? `  <<< FP: ${r.note}` : ''}`)
    }
    if (bad.length > 0) failures += bad.length
}

console.log('worst case assumed for every tree: skipped = true')
arm('inv-nothing-to-boot (expect ZERO)', nothingToBoot)
arm('inv-cli-unaffected (expect ZERO)', cli)

console.log(`\nblast radius — served apps with a discoverable boot command (${wouldFire.length}):`)
for (const r of wouldFire) console.log(`  - ${r.label.padEnd(18)} ${r.bootLabel}`)

// The task's floor: pi-task itself plus at least two non-mx5 local repos must be
// covered by the zero arms, or the suite has not actually been exercised.
const zeroArm = [...nothingToBoot, ...cli]
const hasSelf = zeroArm.some(r => r.dir === REPO)
const nonMx5 = zeroArm.filter(r => r.dir !== REPO && !r.dir.endsWith('/mx5')).length
console.log(`\ncoverage floor: pi-task in a zero arm: ${hasSelf}; non-mx5 repos in a zero arm: ${nonMx5}`)
if (!hasSelf || nonMx5 < 2) {
    console.log('  INSUFFICIENT — nexttask 1 requires pi-task + >=2 non-mx5 repos in the zero arms')
    failures += 1
}

console.log(failures === 0 ? '\nFP SUITE: PASS' : `\nFP SUITE: FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
