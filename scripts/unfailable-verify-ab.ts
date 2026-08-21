/**
 * A/B for 19C — `isStorableCommand` refuses a VERIFY command whose exit status is
 * destroyed by its own construction.
 *
 * THE DEFECT. `recheckAcceptDebts` auto-closes an accepted debt on one piece of
 * evidence: the debt named a VERIFY command, that command was re-run, and it
 * exited ZERO. `isStorableCommand` filtered on length and control characters only.
 * Sixteen store-eligible VERIFY lines on this box cannot exit anything but zero —
 * 12 of them in IAR1, a CMake/C++ OBS plugin with no database, no frontend and no
 * HTTP server, whose TASK_0003 is seven consecutive
 * `test -f … && echo "PASS" || echo "FAIL"` lines standing in for a build check.
 *
 * ── PRE-REGISTERED METRIC ──────────────────────────────────────────────────
 * Over EVERY store-eligible VERIFY line in the ~/hub corpus (612 lines, 4
 * projects), run the REAL `classifyVerifyCommand` in both arms and compare what it
 * stores:
 *
 *   (a) every one of the 16 unfailable lines becomes NON-STORABLE in treatment
 *   (b) every OTHER line's storability is byte-identically unchanged
 *   (c) on a synthetic debt ledger, no debt that closed in baseline for a
 *       NON-19C reason (static-class, cross-task-deletion, a real command that
 *       passed) changes state — only the unfailable-command debt goes from
 *       auto-CLOSED to OPEN
 *
 * exit 0 iff (a) and (b) and (c). NEVER POOLED: per-project counts are printed,
 * because IAR1 and mx5 carry different halves of this and pooling hides both.
 *
 * READ-ONLY against ~/hub; every write goes to a scratch dir.
 *
 * Run: bun run scripts/unfailable-verify-ab.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {AcceptDebt} from '../src/task/accept-debt.js'
import {
    classifyVerifyCommand,
    recheckAcceptDebts,
    type VerifyRerunResult
} from '../src/task/accept-debt.js'
import {parseVerifyBlockStrict} from '../src/task/spec-validation.js'
import {classifyExitStatus} from '../src/task/unfailable-command.js'

const HUB = path.join(os.homedir(), 'hub')
const MAX_REASON_LENGTH_GUESS = 2000

// ─── corpus: every store-eligible VERIFY line under ~/hub ───────────────────

interface Line {
    project: string
    task: string
    raw: string
    unfailable: boolean
}

function corpus(): Line[] {
    const out: Line[] = []
    let projects: string[]
    try {
        projects = fs
            .readdirSync(HUB, {withFileTypes: true})
            .filter(e => e.isDirectory() && fs.existsSync(path.join(HUB, e.name, '.pi-tasks')))
            .map(e => e.name)
            .sort()
    } catch {
        return out
    }
    for (const project of projects) {
        const dir = path.join(HUB, project, '.pi-tasks')
        let names: string[]
        try {
            names = fs.readdirSync(dir).filter(n => /^TASK_.*\.md$/.test(n)).sort()
        } catch {
            continue
        }
        for (const name of names) {
            let spec: string
            try {
                spec = fs.readFileSync(path.join(dir, name), 'utf8')
            } catch {
                continue
            }
            const cmds = parseVerifyBlockStrict(spec)
            if (cmds === null) continue
            for (const c of cmds) {
                const raw = c.raw.trim()
                if (raw.length === 0 || raw.length > MAX_REASON_LENGTH_GUESS) continue
                if (/[\t\n\r]/.test(raw)) continue
                out.push({
                    project,
                    task: name,
                    raw,
                    unfailable: classifyExitStatus(raw).cls === 'unfailable'
                })
            }
        }
    }
    return out
}

// ─── arms ────────────────────────────────────────────────────────────────────

interface Arm {
    classify: typeof classifyVerifyCommand
    recheck: typeof recheckAcceptDebts
}

/** The commit that ADDED the lever module; its parent is the last tree without it.
 *  NEVER `HEAD` once it is committed — memory/ab-baseline-ref-must-not-move.md. */
function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H', '--', 'src/task/unfailable-command.ts'],
        {encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    // Before 19C is committed, the working tree's own HEAD is the last tree without
    // the lever, which is exactly the baseline.
    return sha ? `${sha}^` : 'HEAD'
}

async function baselineArm(dir: string): Promise<Arm> {
    const ref = baselineRef()
    const tar = spawnSync('git', ['archive', ref, 'src'], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024
    })
    if (tar.status !== 0) throw new Error(`git archive ${ref} src failed`)
    fs.writeFileSync(path.join(dir, 'b.tar'), tar.stdout)
    if (spawnSync('tar', ['-xf', path.join(dir, 'b.tar'), '-C', dir]).status !== 0) {
        throw new Error('tar extract failed')
    }
    const m = (await import(path.join(dir, 'src/task/accept-debt.js'))) as {
        classifyVerifyCommand: Arm['classify']
        recheckAcceptDebts: Arm['recheck']
    }
    return {classify: m.classifyVerifyCommand, recheck: m.recheckAcceptDebts}
}

// ─── the storability half ────────────────────────────────────────────────────

/**
 * The reason shape `verifyCommandFromReason` matches, verbatim from mx5 run 19:
 * the command quoted in backticks inside a `work did not verify:` claim.
 */
const reasonFor = (cmd: string): string =>
    `work did not verify: The VERIFY block command \`${cmd}\` fails unaided`

/** One scratch task file per corpus line, so the REAL parser reads a REAL spec. */
function seedSpecs(dir: string, lines: Line[]): string[] {
    const tasks = path.join(dir, '.pi-tasks')
    fs.mkdirSync(tasks, {recursive: true})
    const ids: string[] = []
    for (const [i, l] of lines.entries()) {
        const id = `TASK_${String(i + 1).padStart(4, '0')}`
        ids.push(id)
        fs.writeFileSync(
            path.join(tasks, `${id}.md`),
            `---\nid: ${id}\nstate: done\n---\n\n# ${l.project} ${l.task}\n\nVERIFY:\n\n\`\`\`sh\n${l.raw}\n\`\`\`\n`
        )
    }
    return ids
}

// ─── the ledger half ─────────────────────────────────────────────────────────

/** Every debt class `recheckAcceptDebts` can settle, plus the 19C one. */
const LEDGER: AcceptDebt[] = [
    {taskId: 'D_STATIC', reason: 'repo health: `bun run lint` exited 1', origin: 'accepted'},
    {
        taskId: 'D_DELETION',
        reason: 'deleted `src/client/pages/admin.tsx` — a sibling task’s committed deliverable',
        origin: 'cross-task-deletion'
    },
    {
        taskId: 'D_REALCMD',
        reason: reasonFor('cmake --build build && ctest --test-dir build'),
        origin: 'yolo-accepted',
        verifyCommand: 'cmake --build build && ctest --test-dir build'
    },
    {
        taskId: 'D_UNFAILABLE',
        reason: reasonFor('test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"'),
        origin: 'yolo-accepted',
        verifyCommand: 'test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"'
    },
    {
        taskId: 'D_PROSE',
        reason: 'work did not verify: the shipped project contains extra dependencies beyond the spec',
        origin: 'yolo-accepted'
    }
]

/**
 * The re-run seam, honest about the shell: it RUNS the command and reports the
 * exit status. The unfailable one really does exit 0 with the library missing —
 * which is exactly how baseline auto-closes a debt that is still true.
 */
function rerun(dir: string): (cmd: string) => VerifyRerunResult {
    return cmd => {
        const r = spawnSync('bash', ['-c', cmd], {
            cwd: dir,
            encoding: 'utf8',
            timeout: 20_000,
            env: {...process.env, SO_LIB: path.join(dir, 'no-such-lib.so')}
        })
        if (r.error) return {outcome: 'gap', detail: r.error.message}
        return r.status === 0 ?
                {outcome: 'pass'}
            :   {outcome: 'fail', detail: `exited ${String(r.status)}`}
    }
}

// ─── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfailable-verify-ab-'))
    const baseDir = path.join(root, '_baseline')
    fs.mkdirSync(baseDir, {recursive: true})
    const specDir = path.join(root, 'tree')
    fs.mkdirSync(specDir, {recursive: true})

    const lines = corpus()
    console.log('A/B — 19C: refuse to store a VERIFY command that cannot fail')
    console.log(`baseline src/ @ ${baselineRef()}`)
    console.log(`corpus: ${lines.length} store-eligible VERIFY lines from ~/hub`)
    if (lines.length === 0) {
        console.log('\nABSTAIN — no ~/hub corpus on this box; nothing to compare.')
        process.exit(2)
    }

    const ids = seedSpecs(specDir, lines)
    const base = await baselineArm(baseDir)
    const treat: Arm = {classify: classifyVerifyCommand, recheck: recheckAcceptDebts}

    interface Row {
        project: string
        total: number
        unfailable: number
        flipped: number
        drifted: number
    }
    const rows = new Map<string, Row>()
    const drift: Line[] = []
    const missed: Line[] = []

    for (const [i, l] of lines.entries()) {
        const id = ids[i]!
        const reason = reasonFor(l.raw)
        const b = await base.classify(specDir, id, reason)
        const t = await treat.classify(specDir, id, reason)
        let row = rows.get(l.project)
        if (!row) {
            row = {project: l.project, total: 0, unfailable: 0, flipped: 0, drifted: 0}
            rows.set(l.project, row)
        }
        row.total += 1
        if (l.unfailable) {
            row.unfailable += 1
            // (a) the class must flip storable → not stored.
            if (b !== null && t === null) row.flipped += 1
            else missed.push(l)
        } else if (b !== t) {
            // (b) everything else must be byte-identically unchanged.
            row.drifted += 1
            drift.push(l)
        }
    }

    console.log('\nSTORABILITY — per project, NEVER pooled')
    console.log(`  ${'project'.padEnd(14)} lines  unfailable  flipped-to-not-stored  drifted`)
    for (const r of [...rows.values()].sort((a, b) => a.project.localeCompare(b.project))) {
        console.log(
            `  ${r.project.padEnd(14)}`
                + `${String(r.total).padStart(5)}`
                + `${String(r.unfailable).padStart(12)}`
                + `${String(r.flipped).padStart(23)}`
                + `${String(r.drifted).padStart(9)}`
        )
    }
    for (const m of missed) console.log(`  MISSED  ${m.project} ${m.task}: ${m.raw.slice(0, 110)}`)
    for (const d of drift) console.log(`  DRIFT   ${d.project} ${d.task}: ${d.raw.slice(0, 110)}`)

    // ── the ledger half ──
    console.log('\nLEDGER — the same 5-debt ledger through both arms')
    const rr = rerun(specDir)
    const opts = {
        staticOk: true,
        fileExists: () => false,
        rerunVerify: (cmd: string) => Promise.resolve(rr(cmd))
    }
    const bl = await base.recheck(structuredClone(LEDGER), opts)
    const tl = await treat.recheck(structuredClone(LEDGER), opts)
    const ids2 = (r: {open: AcceptDebt[]; resolved: AcceptDebt[]}): {open: string[]; resolved: string[]} => ({
        open: r.open.map(d => d.taskId).sort(),
        resolved: r.resolved.map(d => d.taskId).sort()
    })
    const B = ids2(bl)
    const T = ids2(tl)
    console.log(`  baseline  resolved=[${B.resolved.join(', ')}]  open=[${B.open.join(', ')}]`)
    console.log(`  treatment resolved=[${T.resolved.join(', ')}]  open=[${T.open.join(', ')}]`)

    const unfailableCount = lines.filter(l => l.unfailable).length
    const projectsHit = new Set(lines.filter(l => l.unfailable).map(l => l.project))

    const checks: Array<[string, boolean]> = [
        [
            `(a) every unfailable line (${unfailableCount}, ${projectsHit.size} projects) is refused in treatment`,
            missed.length === 0 && unfailableCount > 0
        ],
        [`(b) every other line's storability is unchanged (${lines.length - unfailableCount} lines)`, drift.length === 0],
        [
            '(c) baseline auto-CLOSES the unfailable-command debt — the defect reproduces',
            B.resolved.includes('D_UNFAILABLE')
        ],
        ['(c) treatment leaves it OPEN', T.open.includes('D_UNFAILABLE')],
        [
            '(c) no debt that closed for a NON-19C reason changes state',
            B.resolved.filter(id => id !== 'D_UNFAILABLE').join('|')
                === T.resolved.filter(id => id !== 'D_UNFAILABLE').join('|')
        ],
        [
            '(c) the still-true prose debt stays OPEN in both arms (inv-no-false-clear)',
            B.open.includes('D_PROSE') && T.open.includes('D_PROSE')
        ],
        [
            'the arms really differ: baseline and treatment do not agree on everything',
            B.resolved.join('|') !== T.resolved.join('|')
        ]
    ]

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    fs.rmSync(root, {recursive: true, force: true})
    const verdict = checks.every(([, ok]) => ok)
    console.log(`\nA/B 19C: ${verdict ? 'PASS' : 'FAIL'}`)
    console.log(
        '\nZERO false auto-closes have been OBSERVED in the wild — no debt on this box carries a '
            + 'stored verifyCommand at all. 19C ships as a REFUSAL on construction: it only ever '
            + 'declines to store a command it would otherwise have stored, which leaves the debt '
            + 'OPEN and surfaced. The AUTHORING half — teaching compose/critique not to EMIT the '
            + 'shape — is deferred to VALIDATION-DEBT.md, exactly as 16B closed.'
    )
    process.exit(verdict ? 0 : 1)
}

void main()
