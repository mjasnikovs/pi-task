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
    return {tasks, done, trailBytes}
}

/**
 * Wait for the run to settle.
 *
 * Settled means the trail has stopped growing AND at least one task exists —
 * never a fixed wall clock. A clock on a model-driven run is a hardware test:
 * the same run on a busier box is a different number, and the bound goes stale
 * the moment the model changes.
 */
async function waitForSettle(root: string, quietMs: number, hardDeadline: number): Promise<string> {
    let lastBytes = -1
    let lastChange = Date.now()
    let seenTasks = false
    while (Date.now() < hardDeadline) {
        await new Promise(r => setTimeout(r, 15_000))
        const p = progress(root)
        if (p.tasks > 0) seenTasks = true
        if (p.trailBytes !== lastBytes) {
            lastBytes = p.trailBytes
            lastChange = Date.now()
            console.log(
                `    tasks=${p.tasks} done=${p.done} trail=${(p.trailBytes / 1024) | 0}KB`
            )
        } else if (seenTasks && Date.now() - lastChange > quietMs) {
            return `settled (quiet ${(quietMs / 60000) | 0}m) tasks=${p.tasks} done=${p.done}`
        }
    }
    const p = progress(root)
    return `HARD DEADLINE tasks=${p.tasks} done=${p.done}`
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
    const verdict = await waitForSettle(root, quietMin * 60_000, hardDeadline)
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
