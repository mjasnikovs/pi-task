/**
 * STEP 0 of nexttask 19 — the base rate that gates 19C's REFUSAL half, measured
 * BEFORE the lever is wired into `isStorableCommand`. READ-ONLY.
 *
 * THE QUESTION. `recheckAcceptDebts` auto-closes an accepted debt when the debt's
 * stored VERIFY command re-runs to a ZERO exit. How many stored-ELIGIBLE VERIFY
 * lines on this box cannot exit anything but zero — i.e. how many would make that
 * close meaningless?
 *
 * NEVER POOLED. IAR1 is CMake / C++ / an OBS plugin: no database, no frontend, no
 * HTTP server. It is expected to carry the majority of the class, and pooling it
 * with mx5 would hide both that fact and mx5's own.
 *
 * PRE-REGISTERED GATE, written before looking:
 *
 *     19C REFUSAL ships iff unfailable_lines >= 10 across >= 2 distinct projects.
 *     Below that: record the count and STOP.
 *
 * POSITIVE CONTROL, mandatory. `test -f /nonexistent && echo "PASS" || echo
 * "FAIL"` must classify UNFAILABLE *and* must really exit 0 when a shell runs it.
 * A zero from a dead detector is not a zero — if the control does not trip this
 * script refuses to report (exit 2).
 *
 * Run: bun run scripts/unfailable-verify-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseAcceptDebts} from '../src/task/accept-debt.js'
import {findSkipEscapes} from '../src/task/skip-escape.js'
import {parseVerifyBlockStrict} from '../src/task/spec-validation.js'
import {classifyExitStatus} from '../src/task/unfailable-command.js'

const HOME = os.homedir()
const HUB = path.join(HOME, 'hub')
/** The ~/hub corpus: real projects, one tree each. A/B harness copies are excluded
 *  on purpose — they are many runs of ONE shape and would inflate every count. */
const MAX_REASON_LENGTH_GUESS = 2000

// ─── control ─────────────────────────────────────────────────────────────────

const CONTROL = 'test -f /nonexistent && echo "PASS" || echo "FAIL"'
const controlCls = classifyExitStatus(CONTROL).cls
const controlRun = spawnSync('bash', ['-c', CONTROL], {encoding: 'utf8', timeout: 15_000})
const controls: Array<[string, boolean]> = [
    ['19C: the control line classifies UNFAILABLE', controlCls === 'unfailable'],
    ['19C: …and really exits 0 in a shell', controlRun.status === 0],
    [
        '19C: a REAL check is NOT classified unfailable (the detector is not a constant)',
        classifyExitStatus('cmake --build build && ctest --test-dir build').cls === 'can-fail'
    ],
    ['19C: the VERIFY parser reads a fenced block', (parseVerifyBlockStrict(
        'VERIFY:\n\n```sh\ntest -f x && echo "PASS" || echo "FAIL"\n```\n'
    ) ?? []).length === 1]
]
console.log('CONTROLS')
for (const [l, ok] of controls) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${l}`)
if (!controls.every(([, ok]) => ok)) {
    console.log('\nA CONTROL DID NOT TRIP — no counts reported.')
    process.exit(2)
}

// ─── corpus ──────────────────────────────────────────────────────────────────

interface Row {
    project: string
    taskFiles: number
    withVerify: number
    verifyLines: number
    unfailable: number
    unknown: number
    tasksWithUnfailable: Set<string>
    byRule: Map<string, number>
    debts: number
    debtsWithCommand: number
    debtsWithUnfailableCommand: number
}

const rows: Row[] = []
const samples: Array<{project: string; task: string; rule: string; line: string}> = []
let alreadyCaughtBySkipEscape = 0

let projects: string[]
try {
    projects = fs
        .readdirSync(HUB, {withFileTypes: true})
        .filter(e => e.isDirectory() && fs.existsSync(path.join(HUB, e.name, '.pi-tasks')))
        .map(e => e.name)
        .sort()
} catch {
    projects = []
}

for (const project of projects) {
    const taskDir = path.join(HUB, project, '.pi-tasks')
    const row: Row = {
        project,
        taskFiles: 0,
        withVerify: 0,
        verifyLines: 0,
        unfailable: 0,
        unknown: 0,
        tasksWithUnfailable: new Set(),
        byRule: new Map(),
        debts: 0,
        debtsWithCommand: 0,
        debtsWithUnfailableCommand: 0
    }
    let names: string[]
    try {
        names = fs.readdirSync(taskDir).filter(n => /^TASK_.*\.md$/.test(n)).sort()
    } catch {
        names = []
    }
    for (const name of names) {
        row.taskFiles += 1
        let spec: string
        try {
            spec = fs.readFileSync(path.join(taskDir, name), 'utf8')
        } catch {
            continue
        }
        const cmds = parseVerifyBlockStrict(spec)
        if (cmds === null || cmds.length === 0) continue
        row.withVerify += 1
        // Only STORE-ELIGIBLE lines are in scope: 19C is a condition ADDED to
        // `isStorableCommand`, so a line that filter already rejects is not part of
        // the class this closes.
        const storeEligible = cmds
            .map(c => c.raw.trim())
            .filter(c => c.length > 0 && c.length <= MAX_REASON_LENGTH_GUESS && !/[\t\n\r]/.test(c))
        row.verifyLines += storeEligible.length
        const escapes = new Set(findSkipEscapes(spec).map(f => f.line.trim()))
        for (const line of storeEligible) {
            const v = classifyExitStatus(line)
            if (v.cls === 'unknown') row.unknown += 1
            if (v.cls !== 'unfailable') continue
            row.unfailable += 1
            row.tasksWithUnfailable.add(name)
            const rule = v.reason.slice(0, 1)
            row.byRule.set(rule, (row.byRule.get(rule) ?? 0) + 1)
            if (escapes.has(line)) alreadyCaughtBySkipEscape += 1
            samples.push({project, task: name, rule, line})
        }
    }
    // The ledger half: are any debts on this box already carrying a stored command,
    // and is any of those commands unfailable?
    try {
        const ledger = fs.readFileSync(path.join(taskDir, 'accept-debt.md'), 'utf8')
        const debts = parseAcceptDebts(ledger)
        row.debts = debts.length
        for (const d of debts) {
            if (d.verifyCommand === undefined) continue
            row.debtsWithCommand += 1
            if (classifyExitStatus(d.verifyCommand).cls === 'unfailable') {
                row.debtsWithUnfailableCommand += 1
            }
        }
    } catch {
        // no ledger in this tree
    }
    rows.push(row)
}

// ─── report ──────────────────────────────────────────────────────────────────

console.log('\nCORPUS — ~/hub, per project, NEVER pooled')
console.log(
    `  ${'project'.padEnd(14)} tasks  w/VERIFY  lines  UNFAILABLE  unknown  tasks-hit  rules`
)
for (const r of rows) {
    const rules = [...r.byRule.entries()].sort().map(([k, n]) => `${k}:${n}`).join(' ')
    console.log(
        `  ${r.project.padEnd(14)}`
            + `${String(r.taskFiles).padStart(5)}`
            + `${String(r.withVerify).padStart(10)}`
            + `${String(r.verifyLines).padStart(7)}`
            + `${String(r.unfailable).padStart(12)}`
            + `${String(r.unknown).padStart(9)}`
            + `${String(r.tasksWithUnfailable.size).padStart(11)}`
            + `  ${rules}`
    )
}

const total = (f: (r: Row) => number): number => rows.reduce((a, r) => a + f(r), 0)
const hitProjects = rows.filter(r => r.unfailable > 0)

console.log('\nCOUNTS')
console.log(`  verify_lines_total                              ${total(r => r.verifyLines)}`)
console.log(`  unfailable_lines                                ${total(r => r.unfailable)}`)
console.log(
    `  …in ${rows.reduce((a, r) => a + r.tasksWithUnfailable.size, 0)} task(s), `
        + `${hitProjects.length} project(s): ${hitProjects.map(r => `${r.project} ${r.unfailable}`).join(', ')}`
)
console.log(`  unfailable_lines_already_caught_by_skip_escape   ${alreadyCaughtBySkipEscape}`)
console.log(`  undecidable_lines (never acted on)              ${total(r => r.unknown)}`)
console.log(`  debts_total                                     ${total(r => r.debts)}`)
console.log(`  debts_carrying_a_stored_verifyCommand           ${total(r => r.debtsWithCommand)}`)
console.log(`  debts_whose_stored_command_is_unfailable        ${total(r => r.debtsWithUnfailableCommand)}`)

console.log('\nSAMPLES (rule, project, task)')
for (const s of samples) {
    console.log(`  ${s.rule}  ${s.project.padEnd(11)} ${s.task.padEnd(18)} ${s.line.slice(0, 100)}`)
}

console.log('\nPRE-REGISTERED GATE')
const n = total(r => r.unfailable)
const ships = n >= 10 && hitProjects.length >= 2
console.log(
    `  19C REFUSAL ships iff unfailable_lines >= 10 across >= 2 projects → `
        + `${n} across ${hitProjects.length} → ${ships ? 'SHIPS' : 'STOP — record the count and stop'}`
)
console.log(
    '  19C AUTHORING (teaching compose/critique not to emit the shape) needs >= 1 observed '
        + `false auto-close or a live A/B. Observed here: ${total(r => r.debtsWithUnfailableCommand)}. `
        + 'Expect to DEFER it to VALIDATION-DEBT.md.'
)
console.log(
    '\n  ZERO false auto-closes have been observed, and this measures why: '
        + `${total(r => r.debtsWithCommand)} debt(s) on this box carry a stored verifyCommand at all. `
        + '19C ships as a REFUSAL on construction — it only ever declines to store a command it '
        + 'would otherwise have stored, which makes the claim strictly smaller.'
)
process.exit(0)
