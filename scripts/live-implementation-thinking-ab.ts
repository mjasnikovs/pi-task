/**
 * LIVE A/B — what thinking level should the IMPLEMENTATION turn run at?
 *
 * This is the largest cell in the table and the only one with no existing
 * method. Measured on a real 57-task mx5 run, the implementation turn is
 * **38.8% of 12 h 44 m** — more than the gates and the research workers put
 * together — and it is the one group `live-reasoning-group-ab.ts` abstains on,
 * because the turn is a `sendUserMessage` into the host session and a script has
 * no host session to send into.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 * ----------------------------------------
 * It drives a real, write-capable `pi` child against a real recorded spec, in
 * the real tree that task started from, and scores the result with that task's
 * OWN recorded VERIFY script.
 *
 * It therefore measures the MODEL's implementation behaviour at two thinking
 * levels — which is the thing the reasoning level changes. It does NOT exercise
 * `superviseImplementation`'s compaction-resume and steer loop, because those
 * live in the host runtime. That machinery is level-independent: it reacts to
 * idle and to interrupts, not to how much the model thought. Stated plainly here
 * so nobody reads this cell as covering more than it does.
 *
 * WHY IT IS THE MOST TRUSTWORTHY CELL ANYWAY
 * ------------------------------------------
 * Every other group is scored by a PARSER — did the output have bullets, a
 * verdict, four headings. This one is scored by RUNNING the task's own
 * acceptance check against the tree the model produced. The corpus makes that
 * possible because mx5's git history brackets every turn:
 *
 *   chore: checkpoint before "<title>"   ← the tree the turn started from
 *   task: <title> (TASK_NNNN)            ← the tree the real turn produced
 *
 * so both arms start from identical bytes, and the scorer is pre-flighted
 * against the known-good post-tree. A VERIFY that cannot pass on the work the
 * real run shipped is a broken scorer, and its task is dropped rather than
 * counted as a failure for both arms.
 *
 * Run:
 *   PI_BIN=$(command -v pi) PI_TASK_CONFIG_PATH=$(mktemp) \
 *     bun run scripts/live-implementation-thinking-ab.ts <modelLabel> [TASKS=12]
 *
 * Exit: 0 a verdict, 2 ABSTAIN — preconditions unmet, the model changed mid-run,
 * no scorer survived pre-flight, or neither arm ever passed.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {getPiInvocation} from '../src/shared/pi-invocation.js'
import {runChildDefault} from '../src/shared/child-process.js'
import {CHILD_BASE_ARGS} from '../src/shared/child-process.js'
import {REASONING_ON_LEVEL} from '../src/config/reasoning.js'
import {implTasks, extractTree, runVerify, type ImplTask} from './impl-ab-corpus.js'
import {requirePreconditions, abstainMidRun, llamaModelIdentity} from './ab-preflight.js'
import {minAttainableP} from './ab-stats.js'
import type {ArmStats} from './reasoning-ab-decide.js'
import {decide as decideShared} from './reasoning-ab-decide.js'
import {EXIT_CODE} from './ab-verdict.js'

const MODEL_IDENTITY_URL = process.env.AB_MODEL_URL ?? 'http://127.0.0.1:8080/props'
const PROBE_TIMEOUT_MS = 20_000
/**
 * How long to wait for a crashed model to come back before giving up.
 *
 * The server on this machine is `--restart unless-stopped` and MEASURED to
 * reload a 27B NVFP4 in well under a minute, answering 503 `{"error":"Loading
 * model"}` while it does. A crash is therefore a pause, not the end of a run —
 * a matrix that takes hours cannot be thrown away by one of them.
 */
const MODEL_WAIT_MS = Number(process.env.AB_MODEL_WAIT_MS ?? 1_800_000)
const MODEL_POLL_MS = 10_000

/** A real turn's measured mean on this corpus was ~313 s; this is the hard wall. */
const TURN_TIMEOUT_MS = Number(process.env.AB_TURN_TIMEOUT_MS ?? 900_000)
const VERIFY_TIMEOUT_MS = Number(process.env.AB_VERIFY_TIMEOUT_MS ?? 180_000)

/** The two arms, and nothing else. `medium` is REASONING_ON_LEVEL by import. */
type Arm = 'off' | typeof REASONING_ON_LEVEL

/**
 * The tools a real implementation turn has.
 *
 * The host session is fully armed, so a child that could only read would be
 * measuring a different job. `edit` and `write` are what make this destructive,
 * which is why every trial runs in its own extracted tree and `~/hub/mx5` is
 * never a working directory.
 */
const IMPL_TOOLS = 'read,write,edit,ls,grep,find,bash'

interface Trial {
    arm: Arm
    task: string
    /** The task's own VERIFY passed against the tree this turn produced. */
    pass: boolean
    /** The turn never finished: non-zero exit, model error, or the wall clock. */
    dead: boolean
    ms: number
    note: string
}

/**
 * The run's append-only ledger.
 *
 * Written after every single turn, not at the end. A harness that keeps results
 * in memory converts any interruption — a crash, a reboot, a Ctrl-C — into a
 * total loss of GPU hours already spent. Resuming reads this back and skips
 * what is already in it, so re-running the command after any stoppage costs
 * only the turns that never finished.
 */
function ledgerPath(): string {
    return process.env.AB_LEDGER ?? path.join(os.tmpdir(), 'pi-task-implab-ledger.jsonl')
}

function appendTrial(t: Trial, fingerprint: string | null): void {
    fs.appendFileSync(
        ledgerPath(),
        JSON.stringify({...t, fingerprint, at: new Date().toISOString()}) + '\n'
    )
}

/**
 * Trials already recorded UNDER THE SAME MODEL IDENTITY.
 *
 * The fingerprint filter is what makes resuming safe: a ledger written against
 * a different model is a different experiment, and silently continuing into it
 * would mix two models inside one cell.
 */
function loadLedger(fingerprint: string | null): Trial[] {
    const file = ledgerPath()
    if (!fs.existsSync(file)) return []
    const out: Trial[] = []
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
            const row = JSON.parse(line) as Trial & {fingerprint: string | null}
            if (row.fingerprint === fingerprint) out.push(row)
        } catch {
            // A torn last line is what a kill -9 mid-write leaves. Skip it.
        }
    }
    return out
}

/** One implementation turn, at one level, in its own tree. */
async function runTurn(t: ImplTask, arm: Arm, root: string, trial: number): Promise<Trial> {
    const dir = path.join(root, `trial-${trial}-${arm}`)
    // Both arms start from the SAME commit — the checkpoint the real turn began
    // at — so any difference in the result is the level and not the tree.
    extractTree(t.preCommit, dir)

    const args = [...CHILD_BASE_ARGS, '--thinking', arm, '--mode', 'json', '--tools', IMPL_TOOLS]
    const invocation = getPiInvocation(args, t.spec)
    const ctrl = new AbortController()
    const clock = setTimeout(() => ctrl.abort(), TURN_TIMEOUT_MS)
    const t0 = Date.now()
    let dead = false
    let note = ''
    try {
        const r = await runChildDefault(invocation, dir, ctrl.signal, {mode: 'json-events'})
        if (r.aborted) {
            dead = true
            note = `turn hit the ${Math.round(TURN_TIMEOUT_MS / 1000)}s wall`
        } else if (r.exitCode !== 0) {
            dead = true
            note = `turn exit ${r.exitCode}: ${r.stderr.replace(/\s+/g, ' ').slice(-90)}`
        }
    } catch (e) {
        dead = true
        note = e instanceof Error ? e.message.slice(0, 90) : String(e).slice(0, 90)
    } finally {
        clearTimeout(clock)
    }
    const ms = Date.now() - t0

    // The scorer runs even on a dead turn: a turn killed at the wall may still
    // have written correct code before it stalled, and calling that a failure
    // without looking would score the harness's patience, not the model.
    const v = runVerify(t.verify, dir, VERIFY_TIMEOUT_MS)
    if (!dead) note = v.pass ? 'VERIFY pass' : `VERIFY fail exit=${v.exitCode}`
    // Trees are large; keep only the failures, which are the ones worth reading.
    if (v.pass) fs.rmSync(dir, {recursive: true, force: true})
    return {arm, task: t.id, pass: v.pass, dead, ms, note}
}

/**
 * This experiment's trials in the SHARED {@link ArmStats} shape.
 *
 * A VERIFY pass IS the quality axis and a dead turn IS the termination axis, so
 * the local `pass`/`dead`/`msOfPass` interface was the same type under other
 * names. Keeping it meant the shared ladder could not be handed these stats
 * without a translation layer, and a translation layer is where two harnesses
 * quietly drift apart.
 */
function summarise(trials: Trial[], arm: Arm): ArmStats {
    const mine = trials.filter(t => t.arm === arm)
    return {
        n: mine.length,
        usable: mine.filter(t => t.pass).length,
        nonTerminating: mine.filter(t => t.dead).length,
        msOfUsable: mine.filter(t => t.pass).map(t => t.ms),
        /** One trial per spec per arm, so the clock test pairs. */
        stimuliOfUsable: mine.filter(t => t.pass).map(t => t.task)
    }
}

/**
 * The SHARED ladder, with this experiment's names for the two axes.
 *
 * This file used to carry its own copy of the rule. Two copies meant the table
 * could hold two cells decided by two different rules while looking uniform, so
 * the rule now lives in one place and both harnesses execute it. `pass` is this
 * experiment's quality axis and `dead` its termination axis, which is exactly
 * what {@link ArmStats} already means under other names.
 */
function decide(off: ArmStats, on: ArmStats, alpha = 0.05) {
    return decideShared(off, on, alpha, {quality: 'VERIFY pass', termination: 'turn died'})
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** What the gate before a turn decided. */
type Ready = 'ok' | 'swapped' | 'gone'

/**
 * Wait until the model is answering as the SAME model, or say why not.
 *
 * The old gate poked twice, three seconds apart, and abstained on the second
 * miss. A container restart takes longer than that, so a crash the machine
 * recovers from by itself ended the run anyway. This is the same rule with a
 * budget: a restart is a pause, a SWAP is still fatal.
 *
 * Returns `swapped` only when the endpoint is up and reporting a different
 * model — never for a timeout, which is the distinction the earlier version
 * could not draw.
 */
async function waitReady(watch: {stillAlive(): Promise<boolean>; unchanged(): Promise<boolean>}): Promise<Ready> {
    const deadline = Date.now() + MODEL_WAIT_MS
    let announced = false
    for (;;) {
        if (await watch.stillAlive()) {
            if (await watch.unchanged()) {
                if (announced) console.log('  … model is back, same identity — resuming')
                return 'ok'
            }
            return 'swapped'
        }
        if (Date.now() >= deadline) return 'gone'
        if (!announced) {
            console.log(
                `  … model endpoint is down — waiting up to `
                    + `${Math.round(MODEL_WAIT_MS / 60_000)} min for it to come back`
            )
            announced = true
        }
        await sleep(MODEL_POLL_MS)
    }
}

function summariseServer(fingerprint: string | null): string {
    if (fingerprint === null) return 'unpublished'
    try {
        const j = JSON.parse(fingerprint) as {model_path?: unknown; build_info?: unknown}
        const model = typeof j.model_path === 'string' ? j.model_path : '?'
        const build = typeof j.build_info === 'string' ? j.build_info : '?'
        return `${model}  (${build})`
    } catch {
        return fingerprint.slice(0, 120)
    }
}

async function main(): Promise<void> {
    const [modelLabel, countArg] = process.argv.slice(2)
    const want = Number(countArg ?? 12)
    if (!modelLabel) {
        console.error(
            'usage: live-implementation-thinking-ab.ts <modelLabel> [TASKS=12]\n'
                + '  env: AB_CORPUS, AB_MODEL_URL, AB_TURN_TIMEOUT_MS, AB_VERIFY_TIMEOUT_MS,\n'
                + '       AB_PRESCREENED (comma-separated task ids to skip pre-flight)'
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }
    if (!process.env.PI_TASK_CONFIG_PATH) {
        console.error(
            'ABSTAIN — PI_TASK_CONFIG_PATH is unset, so this run would read the'
                + " developer's saved /task-config. bunfig's ambient-isolation preload covers"
                + ' `bun test` only. Re-run with PI_TASK_CONFIG_PATH=$(mktemp).'
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }

    const {watch, fingerprint} = await requirePreconditions('live-implementation-thinking-ab', {
        model: {url: MODEL_IDENTITY_URL, timeoutMs: PROBE_TIMEOUT_MS, identity: llamaModelIdentity},
        piBin: true,
        cacheOff: true
    })

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-implab-'))
    const all = implTasks()
    console.log(`\n=== implementation-turn A/B ===`)
    console.log(`label:   ${modelLabel}`)
    console.log(`server:  ${summariseServer(fingerprint)}`)
    console.log(`corpus:  ${all.length} recorded tasks with a spec, a VERIFY and both trees`)

    // PRE-FLIGHT — TWO SCREENS, and the second one is the one that was missing.
    //
    //  1. the VERIFY must PASS on the tree the real run SHIPPED. A scorer that
    //     cannot pass on known-good work is broken, usually environmentally (the
    //     mx5 Postgres is not up), and would fail both arms for reasons no model
    //     can affect.
    //  2. the VERIFY must FAIL on the tree the turn STARTS from. MEASURED on the
    //     first twelve tasks screened: three of them — TASK_0004, TASK_0018,
    //     TASK_0039 — already passed before the model wrote anything. Those score
    //     PASS for both arms no matter what happens in between, so they cannot
    //     show a difference and can only dilute one. A task that scores itself is
    //     not a measurement.
    //
    // No model is involved in either screen.
    const prescreened = process.env.AB_PRESCREENED?.split(',')
        .map(s => s.trim())
        .filter(Boolean)
    let usable: ImplTask[]
    if (prescreened && prescreened.length > 0) {
        usable = all.filter(t => prescreened.includes(t.id))
        console.log(`pre-flight: skipped, ${usable.length} task(s) supplied via AB_PRESCREENED`)
    } else {
        console.log('pre-flight: VERIFY must fail on the before-tree and pass on the after-tree…')
        usable = []
        for (const t of all) {
            if (usable.length >= want) break
            const post = path.join(root, `preflight-post-${t.id}`)
            const pre = path.join(root, `preflight-pre-${t.id}`)
            try {
                extractTree(t.postCommit, post)
                const after = runVerify(t.verify, post, VERIFY_TIMEOUT_MS)
                if (!after.pass) {
                    console.log(`  ${t.id} scorer unusable (fails on shipped work, exit ${after.exitCode})`)
                    continue
                }
                extractTree(t.preCommit, pre)
                const before = runVerify(t.verify, pre, VERIFY_TIMEOUT_MS)
                if (before.pass) {
                    console.log(`  ${t.id} does not discriminate (already passes before the turn)`)
                    continue
                }
                usable.push(t)
                console.log(`  ${t.id} usable (before fail exit=${before.exitCode}, after pass)`)
            } catch (e) {
                console.log(`  ${t.id} unusable (${String(e).slice(0, 50)})`)
            } finally {
                fs.rmSync(post, {recursive: true, force: true})
                fs.rmSync(pre, {recursive: true, force: true})
            }
        }
    }

    if (usable.length === 0) {
        console.error(
            '\n*** ABSTAIN — NO USABLE SCORER ***\n'
                + 'Not one recorded VERIFY passed against the tree the real run shipped, so'
                + ' there is nothing to score either arm with. This is almost always the'
                + ' environment (the mx5 Postgres is not up), not the corpus.'
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }
    const tasks = usable.slice(0, want)
    console.log(`\ntasks:   ${tasks.length} (${tasks.map(t => t.id).join(', ')})`)
    console.log(`arms:    off  vs  ${REASONING_ON_LEVEL}`)
    console.log(`tools:   ${IMPL_TOOLS}`)
    console.log(
        `floor:   best attainable p at ${tasks.length}v${tasks.length} = `
            + minAttainableP(tasks.length, tasks.length).toFixed(5)
    )
    console.log(
        'NOTE: this drives a real write-capable pi child against a real spec in the\n'
            + '      real starting tree. It does NOT exercise the host supervision loop\n'
            + '      (compaction resume, steer), which is level-independent.\n'
    )

    const done = loadLedger(fingerprint)
    const key = (task: string, arm: string): string => `${task}/${arm}`
    const already = new Set(done.map(d => key(d.task, d.arm)))
    if (done.length > 0) {
        console.log(
            `resume:  ${done.length} turn(s) already in the ledger for this exact model — skipping them`
        )
    }
    console.log(`ledger:  ${ledgerPath()}`)

    const trials: Trial[] = [...done.filter(d => tasks.some(t => t.id === d.task))]
    const total = tasks.length * 2
    let n = 0
    for (const t of tasks) {
        // Both arms of a task run back to back, so a drift between tasks cannot
        // be mistaken for a difference between arms. Order alternates per task.
        const order: Arm[] =
            n % 2 === 0 ? ['off', REASONING_ON_LEVEL as Arm] : [REASONING_ON_LEVEL as Arm, 'off']
        for (const arm of order) {
            n++
            const at = `[${String(n).padStart(2)}/${total}]`
            if (already.has(key(t.id, arm))) {
                console.log(`  ${at} ${t.id} ${arm.padEnd(6)} SKIP  already in ledger`)
                continue
            }
            const ready = await waitReady(watch)
            if (ready === 'swapped') {
                abstainMidRun(
                    'live-implementation-thinking-ab',
                    'the endpoint is answering as a DIFFERENT model than the one this run started'
                        + ' against. That is a swap, not a restart, so the two arms would no longer'
                        + ` be comparable. Completed turns are kept in ${ledgerPath()}.`
                )
            }
            if (ready === 'gone') {
                abstainMidRun(
                    'live-implementation-thinking-ab',
                    `the model did not come back within ${Math.round(MODEL_WAIT_MS / 60_000)} min.`
                        + ` Completed turns are kept in ${ledgerPath()} — bring the server up and`
                        + ' re-run the same command to continue from there.'
                )
            }
            const r = await runTurn(t, arm, root, n)
            trials.push(r)
            appendTrial(r, fingerprint)
            console.log(
                `  ${at} ${t.id} ${arm.padEnd(6)} ${
                    r.pass ? 'PASS'
                    : r.dead ? 'DEAD'
                    : 'FAIL'
                } ` + `${String(Math.round(r.ms / 1000)).padStart(4)}s  ${r.note}`
            )
        }
    }

    const off = summarise(trials, 'off')
    const on = summarise(trials, REASONING_ON_LEVEL as Arm)
    console.log('')
    if (off.usable === 0 && on.usable === 0) {
        console.log('*** ABSTAIN — NEITHER ARM EVER PASSED ***')
        console.log('The specs were never implemented well enough to score, so the levels')
        console.log('were never compared. Do NOT record this as a tie.')
        console.log(`Failed trees kept under ${root} for inspection.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }

    const {winner, rung, saturated, lines} = decide(off, on)
    for (const l of lines) console.log(l)
    const cell = winner
    console.log('')
    console.log(`VERDICT (${modelLabel}, group implementation): ${cell}  [rung ${rung}]`)
    if (saturated) {
        console.log(
            'NOT WRITABLE — the quality axis was saturated, so this run compared'
                + ' nothing. A cell written from it would record a prior as a'
                + ' measurement. Build an axis with headroom and re-measure; the'
                + ' ledger keeps the trials.'
        )
    } else {
        console.log(
            `Record it as: implementation: '${cell}',  // A/B ${modelLabel}`
                + ` n=${tasks.length}/arm — off ${off.usable}/${off.n} VERIFY-pass,`
                + ` ${REASONING_ON_LEVEL} ${on.usable}/${on.n}`
                + `, rung ${rung}${rung === 3 ? ' (PRIOR, not evidence)' : ''}`
        )
    }
    console.log(`Failed trees kept under ${root}`)
    process.exit(EXIT_CODE.PASS)
}

await main()
