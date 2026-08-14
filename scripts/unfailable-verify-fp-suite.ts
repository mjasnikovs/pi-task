/**
 * Zero-FP fixture suite for the unfailable-VERIFY classifier (nexttask 19C) — run
 * BEFORE wiring it into `isStorableCommand`, and any time the rules change.
 * Modelled on `scripts/dangling-artifact-fp-suite.ts`.
 *
 * Two things are checked, and the second is the one that matters:
 *
 *   1. STATIC — each fixture classifies as the suite says it must.
 *   2. LIVE   — every fixture the classifier calls UNFAILABLE is actually RUN in
 *      a real shell against a tree where the check it names is FALSE, and must
 *      still exit 0. A classifier that says "this cannot fail" is making a claim
 *      about a shell, so the shell is asked. This is the nexttask's 19C positive
 *      control, generalised to every unfailable fixture.
 *
 * Nothing here touches ~/hub, and nothing writes outside a scratch temp dir.
 *
 * Run: bun scripts/unfailable-verify-fp-suite.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {classifyExitStatus, type ExitStatusClass} from '../src/task/unfailable-command.js'

interface Fixture {
    cmd: string
    want: ExitStatusClass
    note: string
    /** Skip the live run (needs a tool this box may not have, or is destructive). */
    noLive?: boolean
}

/**
 * The MUST-BE-UNFAILABLE arm. Every one is a real corpus shape: the seven-line
 * `test -f "$SO_LIB"` block is IAR1 TASK_0003's C++ build "verification", the
 * `tail -5` line is mx5 TASK_0025's typecheck.
 */
const UNFAILABLE: Fixture[] = [
    {
        cmd: 'test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"',
        want: 'unfailable',
        note: 'C — IAR1 TASK_0003, one of seven consecutive lines'
    },
    {
        cmd: 'npx tsc --noEmit 2>&1 | tail -5; test $? -eq 0 && echo "PASS: typecheck clean" || echo "NOTE: typecheck may need dependencies installed"',
        want: 'unfailable',
        note: 'B — mx5 TASK_0025; `$?` is tail’s',
        noLive: true // npx would go to the network
    },
    {
        cmd: 'bun -e "console.assert(typeof api === \'object\', \'shape\')"',
        want: 'unfailable',
        note: 'A — console.assert prints and continues'
    },
    {
        cmd: 'test -d build && echo "PASS: build dir" || printf "%s\\n" "FAIL: missing"',
        want: 'unfailable',
        note: 'C — printf counts as a pure branch too'
    }
]

/** The MUST-NOT arm, verbatim from nexttask 19's STEP 3 list. */
const MUST_NOT: Fixture[] = [
    {
        cmd: 'test -f "$SO_LIB" || { echo "FAIL: not found"; exit 1; }',
        want: 'can-fail',
        note: 'exits non-zero — the branch that can be last is not an echo'
    },
    {
        cmd: 'cmake --build build && ctest --test-dir build',
        want: 'can-fail',
        note: 'plain chain'
    },
    {
        cmd: "grep -q 'hc<AppType>' src/client/api.ts",
        want: 'can-fail',
        note: 'grep sets a real status'
    },
    {
        cmd: 'rm -rf build || true',
        want: 'can-fail',
        note: 'teardown — bare `|| true` is OUT OF SCOPE by design (skip-escape.ts:11-19)'
    },
    {
        cmd: 'AGENT=1 bun test test/listings.test.ts',
        want: 'can-fail',
        note: 'a real test run, with a leading assignment'
    },
    {
        cmd: 'bun -e "console.assert(x); if (!x) process.exit(1)"',
        want: 'can-fail',
        note: 'console.assert alongside a REAL exit path — rule A must not fire'
    },
    {
        cmd: 'echo "checking" && test -f dist/index.html',
        want: 'can-fail',
        note: 'an echo FIRST, but the terminal branch is a real test'
    },
    {
        cmd: 'echo "a; b" && test -f x || exit 1',
        want: 'can-fail',
        note: 'a `;` INSIDE quotes must not split the line'
    },
    {
        cmd: 'printf "%s\\n" "PASS"',
        want: 'can-fail',
        note: 'BOUNDARY — a lone echo/printf is not a chain; rule C needs >= 2 branches'
    }
]

/** The shapes with no answer — `unknown`, never a guess. */
const UNKNOWN: Fixture[] = [
    {
        cmd: '$(cat scripts/verify.sh)',
        want: 'unknown',
        note: 'the whole line is a command substitution',
        noLive: true
    },
    {
        cmd: 'set -e ; test -f "$SO_LIB" && echo ok',
        want: 'unknown',
        note: '`set -e` changes what a non-zero status DOES',
        noLive: true
    }
]

let failures = 0

function check(f: Fixture): void {
    const v = classifyExitStatus(f.cmd)
    const ok = v.cls === f.want
    if (!ok) failures++
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${f.want.padEnd(10)} got ${v.cls.padEnd(10)} ${f.note}`)
    console.log(`          ${f.cmd.slice(0, 130)}`)
    if (!ok && v.reason) console.log(`          reason: ${v.reason}`)
}

console.log('STATIC — must be UNFAILABLE')
for (const f of UNFAILABLE) check(f)
console.log('\nSTATIC — must NOT be')
for (const f of MUST_NOT) check(f)
console.log('\nSTATIC — no answer available')
for (const f of UNKNOWN) check(f)

// ─── live control ────────────────────────────────────────────────────────────
//
// Everything the classifier called UNFAILABLE is RUN, in a tree where the thing
// it checks is FALSE. A non-zero exit here would mean the classifier lied.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfailable-fp-'))
console.log(`\nLIVE — run each UNFAILABLE fixture where its check is FALSE (${dir})`)
let liveRun = 0
for (const f of [...UNFAILABLE, ...MUST_NOT, ...UNKNOWN]) {
    if (f.noLive === true) continue
    const cls = classifyExitStatus(f.cmd).cls
    if (cls !== 'unfailable') continue
    liveRun++
    // SO_LIB deliberately points at a file that does not exist: the check is FALSE.
    const r = spawnSync('bash', ['-c', f.cmd], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        env: {...process.env, SO_LIB: path.join(dir, 'no-such-lib.so')}
    })
    const zero = r.status === 0
    if (!zero) failures++
    console.log(
        `  ${zero ? 'ok  ' : 'FAIL'}  exit ${String(r.status)} (must be 0) — ${f.note}`
    )
    console.log(`          stdout: ${(r.stdout ?? '').trim().slice(0, 100)}`)
}
if (liveRun === 0) {
    failures++
    console.log('  FAIL  the live control ran NOTHING — a zero from a dead control is not a zero')
}

// …and the negative half of the live control: a MUST-NOT fixture that really does
// exit non-zero, proving the shell is being asked a question it can answer.
const neg = spawnSync('bash', ['-c', 'test -f "$SO_LIB" || { echo "FAIL: not found"; exit 1; }'], {
    cwd: dir,
    encoding: 'utf8',
    env: {...process.env, SO_LIB: path.join(dir, 'no-such-lib.so')}
})
const negOk = neg.status !== 0
if (!negOk) failures++
console.log(`  ${negOk ? 'ok  ' : 'FAIL'}  the `
    + `MUST-NOT control really exits non-zero (got ${String(neg.status)})`)

fs.rmSync(dir, {recursive: true, force: true})
console.log(failures === 0 ? '\nFP SUITE: PASS' : `\nFP SUITE: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
