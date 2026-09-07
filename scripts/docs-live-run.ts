/**
 * Drive one seeded project through a real `/task-auto` run, headlessly.
 *
 * TWO PATHS DO NOT WORK, and both fail late enough to waste a run:
 *
 *   `pi -p "/task-auto …"` hands the text to the model as an ordinary message.
 *   Print mode dispatches no commands at all.
 *
 *   The remote bridge reaches the handler, but a line arriving before any terminal
 *   command is handed a shimmed ctx whose `newSession` throws "Run /remote in the
 *   terminal once". `/task-auto` needs a session per task, so the run dies — after
 *   planning has completed and written a full plan, which is what makes it costly.
 *
 * So this drives the real terminal: pi in a tmux session, and `send-keys`. That is
 * the path a user takes, and the only one where ctx is the genuine article.
 *
 *   bun scripts/docs-live-run.ts <project-root> <feature-file> [--timeout-min 90]
 *
 * `bun run test` globs `scripts/`, so nothing here runs on import.
 */

import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

function tmux(...args: string[]): string {
    return execFileSync('tmux', args, {encoding: 'utf8'})
}

/**
 * Type the line into pi's prompt and press Enter.
 *
 * Sent as a literal (`-l`) so nothing in the feature text is read as a tmux key
 * name, and Enter goes as its own call — a trailing newline inside a literal
 * send is swallowed by the prompt's own paste handling.
 */
function sendLine(session: string, text: string): void {
    tmux('send-keys', '-t', session, '-l', text)
    tmux('send-keys', '-t', session, 'Enter')
}

/**
 * How far the run has got, read off the artifacts rather than the transcript.
 *
 * A `/task-auto` run writes TASK_NNNN.md files and marks them off as it goes, so
 * the count of unfinished specs is the only progress signal that does not depend
 * on parsing a TUI.
 */
function progress(root: string): {tasks: number; done: number; trailBytes: number} {
    const dir = path.join(root, '.pi-tasks')
    if (!fs.existsSync(dir)) return {tasks: 0, done: 0, trailBytes: 0}
    let tasks = 0
    let done = 0
    let trailBytes = 0
    for (const f of fs.readdirSync(dir)) {
        const full = path.join(dir, f)
        if (/^TASK_\d+\.md$/.test(f)) {
            tasks++
            const body = fs.readFileSync(full, 'utf8')
            if (/^state:\s*completed\b/im.test(body)) done++
        } else if (f.endsWith('.log')) {
            trailBytes += fs.statSync(full).size
        }
    }
    const plan = planProgress(dir)
    return {...(plan ?? {tasks, done}), trailBytes}
}

/**
 * The plan's own checklist, which is what says how many tasks there ARE.
 *
 * Counting `TASK_NNNN.md` counts the specs WRITTEN, and re-run 7's hs planned three
 * and had one written — so spec files read 1 of 1 and the run looked complete on its
 * first task. `## coverage` below the list has bullets of its own, so the section is
 * bounded.
 */
function planProgress(dir: string): {tasks: number; done: number} | null {
    const plan = fs.readdirSync(dir).find(f => /^TASK_AUTO_\d+\.md$/.test(f))
    if (plan === undefined) return null
    const section = /^## tasks\s*$([\s\S]*?)^## /m.exec(
        fs.readFileSync(path.join(dir, plan), 'utf8')
    )
    if (section === null) return null
    const lines = section[1].split('\n').filter(l => /^- \[[ x]\]/.test(l))
    if (lines.length === 0) return null
    return {tasks: lines.length, done: lines.filter(l => /^- \[x\]/.test(l)).length}
}

/**
 * Wait for the run to settle.
 *
 * Never a fixed wall clock. A clock on a model-driven run is a hardware test: the
 * same run on a busier box is a different number, and the bound goes stale the
 * moment the model changes.
 *
 * DONE is every planned task ticked. That is the only positive signal; everything
 * else here is a stall detector.
 *
 * The trail alone is not a stall detector, and re-run 7's hs is why. `.pi-tasks/`
 * logs are written at PHASE boundaries, so a task that spends eleven minutes inside
 * one implementation phase writes nothing — the trail reads quiet, this returned
 * "settled" while the TUI said `TASK_0001 · implementing · 8:02`, and the harness
 * then built a half-written tree and called it RED. Two of seven runs have no hs
 * verdict and this produced one of them.
 *
 * So quiet means BOTH quiet: the trail has not grown and the terminal has not
 * repainted. The pane carries an elapsed timer that ticks every second, so a live
 * run cannot look still even when it writes no file.
 */
async function waitForSettle(
    root: string,
    quietMs: number,
    hardDeadline: number,
    session: string
): Promise<string> {
    let lastBytes = -1
    let lastPane = ''
    let lastChange = Date.now()
    let seenTasks = false
    // Progress-gated, not a retry count. `/task-auto` halts on a loop detector and
    // ASKS to be resumed, which an unattended run never gives it — that is why
    // hackage produced no verdict in seven runs. Resuming is running the product the
    // way it is meant to be run; resuming a run that has not finished another task
    // since the last resume would be a loop of my own, so the gate is `done` moving.
    let resumes = 0
    let doneAtResume = -1
    while (Date.now() < hardDeadline) {
        await new Promise(r => setTimeout(r, 15_000))
        const p = progress(root)
        if (p.tasks > 0) seenTasks = true
        if (seenTasks && p.done === p.tasks) {
            return `settled (all ${p.tasks} planned tasks done)`
        }
        const pane = paneText(session)
        if (p.trailBytes !== lastBytes || pane !== lastPane) {
            lastBytes = p.trailBytes
            lastPane = pane
            lastChange = Date.now()
            console.log(`    tasks=${p.tasks} done=${p.done} trail=${(p.trailBytes / 1024) | 0}KB`)
        } else if (seenTasks && Date.now() - lastChange > quietMs) {
            if (RESUME_ASKED.test(pane) && p.done > doneAtResume) {
                doneAtResume = p.done
                resumes++
                console.log(`    halted asking for a resume — resuming (${resumes})`)
                sendLine(session, '/task-auto-resume --unattended')
                lastChange = Date.now()
                lastPane = ''
                continue
            }
            return (
                `STALLED (quiet ${(quietMs / 60000) | 0}m) tasks=${p.tasks} done=${p.done}`
                + (resumes > 0 ? ` after ${resumes} resume(s)` : '')
            )
        }
    }
    const p = progress(root)
    return (
        `HARD DEADLINE tasks=${p.tasks} done=${p.done}`
        + (resumes > 0 ? ` after ${resumes} resume(s)` : '')
    )
}

/** `/task-auto` halting with an actionable resume, as it prints it. */
const RESUME_ASKED = /run \/task-auto-resume|Resume to retry/

/** The visible pane. Empty on failure, which reads as "unchanged" and cannot itself
 *  keep a dead run alive — the trail check still has to be quiet too. */
function paneText(session: string): string {
    try {
        return execFileSync('tmux', ['capture-pane', '-p', '-t', session], {encoding: 'utf8'})
    } catch {
        return ''
    }
}

async function main(): Promise<void> {
    const [root, featureFile] = process.argv.slice(2)
    if (!root || !featureFile) {
        console.error('usage: bun scripts/docs-live-run.ts <project-root> <feature-file>')
        process.exit(1)
    }
    const tIdx = process.argv.indexOf('--timeout-min')
    const timeoutMin = tIdx === -1 ? 120 : Number(process.argv[tIdx + 1])
    const qIdx = process.argv.indexOf('--quiet-min')
    const quietMin = qIdx === -1 ? 8 : Number(process.argv[qIdx + 1])

    const feature = fs.readFileSync(featureFile, 'utf8').trim()
    const session = `docslive-${path.basename(root)}`

    console.log(`=== ${root}`)
    try {
        tmux('kill-session', '-t', session)
    } catch {
        // no such session, which is the normal case
    }
    // A wide window: pi's TUI wraps to the terminal, and a narrow one turns the
    // trail into unreadable reflowed fragments.
    tmux('new-session', '-d', '-s', session, '-c', root, '-x', '200', '-y', '50', 'pi')

    // pi has to finish booting before the prompt will accept a line — a send into
    // a starting TUI is simply lost, with no error anywhere.
    await new Promise(r => setTimeout(r, 25_000))
    console.log('    pi up in tmux, typing /task-auto')
    sendLine(session, `/task-auto ${feature}`)

    const hardDeadline = Date.now() + timeoutMin * 60_000
    const verdict = await waitForSettle(root, quietMin * 60_000, hardDeadline, session)
    console.log(`    ${verdict}`)

    // Written OUTSIDE the project, and this is not tidiness. A capture left in the
    // tree is a file the run's own research worker reads as project source — the
    // first run's `worker:files` read `.pi-tty.log` alongside config.json — so the
    // harness ends up in the context it is trying to measure.
    fs.writeFileSync(
        path.join(path.dirname(root), `${path.basename(root)}.tty.log`),
        tmux('capture-pane', '-p', '-S', '-20000', '-t', session),
        'utf8'
    )
    if (!verdict.startsWith('HARD')) tmux('kill-session', '-t', session)
}

if (import.meta.main) await main()
