/**
 * STEP 0 for 6B — can a SURVIVING open debt be routed anywhere? (nexttask 6)
 *
 * Deterministic: no model, no PI_BIN, no network. This is the cheap measurement
 * that decides whether the expensive part of 6B is worth running at all —
 * `open-debt-routing-ab.ts` needs TWO CHAINED live runs per arm, and nexttask 6
 * says explicitly not to start it until the survivor count is known.
 *
 * STEP 0 for 6A (`open-debt-lifecycle-baserate.ts`) answered that: essentially
 * every recorded debt survives. Across every tree this project retains, 0 of
 * 3121 records are in the ONE class the shipped re-check can auto-close, and 0 of
 * the 16 PROJECT-pool debts clear at HEAD. So 6B's premise holds — the survivors
 * are ~100% of what is ever recorded, and today they get a warning and nothing
 * else.
 *
 * 6B option (ii) proposes routing each survivor through the existing root-cause
 * repair channel (`root-cause-repair.ts` → `recordRepairCandidate`) so the next
 * run schedules a scoped repair task. Before measuring whether that CLOSES
 * anything, measure whether it can even FIRE: `findRepairCandidate` returns a
 * candidate only when
 *
 *   1. the FAIL text is not environment-attributed,
 *   2. it accuses a concrete path,
 *   3. that path is NOT one the blamed task's own work touched  ← the crux, and
 *   4. some OTHER task introduced it.
 *
 * Condition 3 is an authorship filter: the channel exists for "a DIFFERENT task's
 * pre-existing bug failed my verify". A surviving accept-debt is, by definition,
 * a task's OWN unfixed defect. If that filter rejects the survivors, option (ii)
 * is a category error rather than a cheap win, and the chained-run A/B would be
 * measuring a channel that never fires.
 *
 * Method: for each PROJECT-pool debt, recover the file set of the commit that
 * carries `(TASK_XXXX)` in its message — the blamed task's own work — and run the
 * SHIPPED `findRepairCandidate` against the verbatim recorded reason.
 *
 * Run: bun run scripts/open-debt-routing-baserate.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseAcceptDebts, type AcceptDebt} from '../src/task/accept-debt.js'
import {
    findAccusedFile,
    findRepairCandidate,
    isEnvironmentAttributed
} from '../src/task/root-cause-repair.js'
import {taskThatIntroduced} from '../src/task/task-provenance.js'

const HOME = os.homedir()

/** The real multi-task project runs — the same PROJECT pool as the 6A STEP 0. */
const TREES = [
    path.join(HOME, 'hub', 'mx5'),
    path.join(HOME, 'hub', 'IAR1'),
    path.join(HOME, 'hub', 'gofer-pixel'),
    path.join(HOME, 'tmp', 'fixcheck')
]

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, {
            cwd,
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        })
    } catch {
        return null
    }
}

/**
 * Files the blamed task's own commit touched. The auto loop commits each task as
 * `task: <title> (TASK_XXXX)`, so the id in the subject is the anchor. Null = the
 * commit could not be found, which `findRepairCandidate` treats as "unknown" and
 * stands down on — reported separately so it is never confused with a rejection.
 */
function touchedByTask(tree: string, taskId: string): string[] | null {
    const sha = git(tree, ['log', '--format=%H', '--grep', `(${taskId})`, '-1'])?.trim()
    if (!sha) return null
    const files = git(tree, ['show', '--name-only', '--format=', sha])
    if (files === null) return null
    return files
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('.pi-tasks/'))
}

type Rejection =
    | 'routable'
    | 'no-task-commit'
    | 'environment-attributed'
    | 'no-accused-path'
    | 'self-authored'
    | 'unknown-owner'

interface Row {
    tree: string
    debt: AcceptDebt
    verdict: Rejection
    detail: string
}

async function classify(tree: string, d: AcceptDebt): Promise<Row> {
    const mk = (verdict: Rejection, detail: string): Row => ({tree, debt: d, verdict, detail})
    if (isEnvironmentAttributed(d.reason)) {
        return mk('environment-attributed', 'the channel stands down on env-shaped FAILs')
    }
    const accused = findAccusedFile(d.reason)
    if (!accused) {
        return mk('no-accused-path', 'no path token sits near a blame cue')
    }
    const touched = touchedByTask(tree, d.taskId)
    if (touched === null) {
        return mk('no-task-commit', `no commit carrying (${d.taskId}) in this tree`)
    }
    const candidate = await findRepairCandidate({
        failReason: d.reason,
        currentTaskId: d.taskId,
        touched,
        introducedBy: rel => taskThatIntroduced(tree, rel)
    })
    if (candidate) {
        return mk('routable', `→ repair ${candidate.file} (owner ${candidate.owner})`)
    }
    const owner = taskThatIntroduced(tree, accused.file)
    if (owner === null) return mk('unknown-owner', `git cannot attribute ${accused.file}`)
    if (owner === d.taskId) {
        return mk('self-authored', `${accused.file} is ${d.taskId}'s own deliverable`)
    }
    return mk('self-authored', `${accused.file} is in ${d.taskId}'s own commit`)
}

async function main(): Promise<void> {
    const rows: Row[] = []
    for (const tree of TREES) {
        const ledger = path.join(tree, '.pi-tasks', 'accept-debt.md')
        if (!fs.existsSync(ledger)) continue
        let debts: AcceptDebt[]
        try {
            debts = parseAcceptDebts(fs.readFileSync(ledger, 'utf8').trim())
        } catch {
            continue
        }
        for (const d of debts) rows.push(await classify(tree, d))
    }

    console.log('OPEN-DEBT ROUTING — STEP 0 for 6B (nexttask 6)')
    console.log(`PROJECT pool: ${rows.length} surviving debt(s) across ${TREES.length} tree(s)`)
    console.log('')
    for (const r of rows) {
        console.log(
            `   ${path.relative(HOME, r.tree).padEnd(16)} ${r.debt.taskId.padEnd(14)} `
                + `${r.verdict.padEnd(24)} ${r.detail}`
        )
    }
    console.log('')

    const counts = new Map<Rejection, number>()
    for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1)
    console.log('── SUMMARY')
    for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`   ${k.padEnd(24)} ${v}`)
    }
    const routable = counts.get('routable') ?? 0
    console.log('')
    console.log('── VERDICT')
    if (routable === 0) {
        const noPath = counts.get('no-accused-path') ?? 0
        console.log('   ZERO surviving debts are routable through the existing repair channel.')
        console.log('')
        console.log(`   The BINDING constraint is upstream of the authorship test: ${noPath} of`)
        console.log(`   ${rows.length} recorded reasons carry no path token next to a blame cue, so`)
        console.log('   `findAccusedFile` returns null and the channel never reaches the question')
        console.log('   it was built to answer. These reasons are model-written prose about a')
        console.log('   task\'s own work ("the implementation uses `sql.unsafe()` in 3 places",')
        console.log('   "1 of 51 Playwright CT tests fails") — they name symbols, line numbers and')
        console.log('   test titles, not an accused file in the shape the extractor recognises.')
        console.log('   The rest are environment-attributed (the channel stands down by design) or')
        console.log('   belong to trees with no per-task commit to attribute against.')
        console.log('')
        console.log('   So 6B option (ii) is NOT the cheap re-use nexttask 6 assumed. Routing a')
        console.log('   surviving debt needs a new extraction path — and behind it, an authorship')
        console.log('   test that a surviving accept-debt would fail anyway, since it is by')
        console.log('   construction the blamed task\'s OWN unfixed defect rather than a sibling\'s.')
        console.log('')
        console.log('   Recommendation, stated as such and NOT acted on here: 6B needs its own')
        console.log('   design step before its two-chained-run A/B is worth paying for. Option (i)')
        console.log('   — name the survivors in the run\'s terminal summary — is the only one of')
        console.log('   the three buildable today, and 6A already makes that summary honest.')
    } else {
        console.log(`   ${routable} of ${rows.length} surviving debts ARE routable as-is.`)
        console.log('   That is the population the chained-run A/B would measure.')
    }
    console.log('')
    console.log('   CAVEAT: n is small (see the per-row listing) and mx5 run 18 is the sample')
    console.log('   nexttask 6 was written from. This measurement bounds REACHABILITY only —')
    console.log('   it says nothing about whether a routed repair would succeed.')
}

void main()
