/**
 * Drive one seeded project through a real `/task-auto` run, headlessly.
 *
 * `pi -p "/task-auto …"` does NOT work: print mode hands the text to the model as
 * an ordinary message and never dispatches the command. The command only reaches
 * its handler through the remote bridge, which `registerBridgeCommand` populates
 * alongside `pi.registerCommand`. So this starts pi under a pty, waits for the
 * remote server, and sends the line over its WebSocket exactly as a browser would.
 *
 *   bun scripts/docs-live-run.ts <project-root> <feature-file> [--timeout-min 90]
 *
 * `bun run test` globs `scripts/`, so nothing here runs on import.
 */

import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** First port the remote server tries; it retries upward from here. */
const REMOTE_BASE_PORT = 8800
const REMOTE_PORT_SPAN = 20
const WS_PATH = '/ws'

async function portOpen(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/push-key`, {
            signal: AbortSignal.timeout(1000)
        })
        return res.status < 500
    } catch {
        return false
    }
}

/**
 * The port pi actually bound. Scanned rather than assumed: a stale pi, or a
 * sibling run, takes 8800 and the next one lands on 8801 with no warning.
 */
async function findRemotePort(deadline: number): Promise<number> {
    while (Date.now() < deadline) {
        for (let p = REMOTE_BASE_PORT; p < REMOTE_BASE_PORT + REMOTE_PORT_SPAN; p++) {
            if (await portOpen(p)) return p
        }
        await new Promise(r => setTimeout(r, 2000))
    }
    throw new Error('remote server never bound')
}

function sendLine(port: number, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`)
        const fail = setTimeout(() => reject(new Error('ws send timed out')), 20_000)
        ws.onopen = () => {
            // The server sends one authoritative snapshot on connect; the line is
            // sent after a beat so it is never racing that write.
            setTimeout(() => {
                ws.send(JSON.stringify({type: 'message', text}))
                setTimeout(() => {
                    clearTimeout(fail)
                    ws.close()
                    resolve()
                }, 2000)
            }, 800)
        }
        ws.onerror = e => {
            clearTimeout(fail)
            reject(new Error(`ws error: ${String(e)}`))
        }
    })
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
    const ttyLog = path.join(root, '.pi-tty.log')

    console.log(`=== ${root}`)
    // A pty, because pi's TUI exits immediately on a plain pipe. `script` is the
    // portable one; the log is kept for post-mortems.
    const child = spawn('script', ['-qec', 'pi', '/dev/null'], {
        cwd: root,
        stdio: ['ignore', fs.openSync(ttyLog, 'w'), fs.openSync(ttyLog, 'a')],
        detached: true
    })
    child.unref()

    const hardDeadline = Date.now() + timeoutMin * 60_000
    const port = await findRemotePort(Date.now() + 120_000)
    console.log(`    pi up on ${port}, dispatching /task-auto`)
    await sendLine(port, `/task-auto ${feature}`)

    const verdict = await waitForSettle(root, quietMin * 60_000, hardDeadline)
    console.log(`    ${verdict}`)

    try {
        process.kill(-child.pid!, 'SIGTERM')
    } catch {
        // already gone
    }
}

if (import.meta.main) await main()
