/**
 * What `spawnCommand` must guarantee, given it is the ONLY bound on every gate
 * command, repo-health command and ACCEPT-debt VERIFY re-run.
 *
 * `spawnSync` supplied three of these for free, and an async runner has to
 * re-earn each one. Run here to confirm:
 *   - it hands the child a CLOSED stdin — a child reading fd 0 gets 0 bytes;
 *   - it bounds output at a ~1 MB default `maxBuffer` — 2 MB of stdout comes
 *     back truncated with ENOBUFS;
 *   - and it returns at its own `timeout` no matter who else holds the pipe.
 *
 * These cases spawn REAL children, because a runner asserted only against
 * classification literals never exercises any of that. Every one races the run
 * against a deadline of its own: a runner that does not settle must FAIL the
 * test, not hang the suite.
 */
import {describe, expect, test} from 'bun:test'
import {classifyCommandRun, outputTail, spawnCommand} from '../../src/task/command-run.js'

const posix = process.platform !== 'win32'
const cwd = process.cwd()

/** Fail — rather than hang — when the runner does not settle in time. */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error(`spawnCommand did not settle within ${ms}ms`)), ms)
    })
    try {
        return await Promise.race([p, deadline])
    } finally {
        clearTimeout(t)
    }
}

describe.skipIf(!posix)('spawnCommand settles on the CHILD, not on the pipe', () => {
    test('a command that backgrounds a process settles when the command itself exits', async () => {
        // `close` only fires once every stdio pipe is at EOF, and a backgrounded
        // grandchild INHERITS stdout. A seed script that starts a daemon, a build
        // that leaves a watcher, a launch script — all of them hold the pipe open
        // after the command is done, and `runFinalIntegrationGate` waits.
        const r = await within(
            1500,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', 'sleep 3 & echo started'],
                timeoutMs: 30_000
            })
        )
        expect(r.failedToStart).toBe(false)
        expect(r.status).toBe(0)
        // Settling early must not lose what the command already wrote.
        expect(r.stdout).toContain('started')
    })

    test('the deadline settles the run even when the pipe outlives the killed child', async () => {
        // SIGKILL reaches the direct child only. The inherited pipe stays open,
        // so a runner that waits for `close` never reports the timeout it just
        // fired, and the gate's own cap (900_000ms, final-gate.ts:646) becomes
        // no cap at all.
        const r = await within(
            2500,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', 'sleep 5 & sleep 5'],
                timeoutMs: 400
            })
        )
        expect(r.failedToStart).toBe(false)
        expect(r.status).toBe(null)
    })

    test('a cancel settles the run the same way', async () => {
        const ac = new AbortController()
        const run = spawnCommand({
            cwd,
            bin: 'sh',
            args: ['-c', 'sleep 5 & sleep 5'],
            timeoutMs: 30_000,
            signal: ac.signal
        })
        setTimeout(() => ac.abort(), 100)
        const r = await within(2500, run)
        expect(r.status).toBe(null)
    })
})

describe.skipIf(!posix)("the child's stdin is closed, not left live", () => {
    test('a command that reads stdin gets EOF immediately', async () => {
        // `spawnSync` gives the child a closed stdin; `spawn` with the default
        // stdio gives it a live pipe nobody ever ends. So any check that reads
        // stdin — a `cat`-style pipeline, a tool that prompts, a pager — blocks
        // until the kill timer, which is 600_000ms for repo-health
        // (repo-health-check.ts:186) and 900_000ms for a gate command.
        const r = await within(
            2000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', 'cat >/dev/null; echo done'],
                timeoutMs: 4000
            })
        )
        expect(r.status).toBe(0)
        expect(r.stdout.trim()).toBe('done')
    })
})

describe.skipIf(!posix)('output is bounded', () => {
    test('a chatty command cannot grow an unbounded string in the host process', async () => {
        // `spawnSync` bounds this at its default `maxBuffer`. Unbounded, the async
        // runner accumulates two growing strings in the HOST — the TUI process —
        // for as long as the command talks, which under a 900-second cap is a
        // long time.
        const r = await within(
            30_000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', 'head -c 4194304 /dev/zero | tr "\\0" "x"; echo TAIL_MARKER'],
                timeoutMs: 60_000
            })
        )
        expect(r.status).toBe(0)
        expect(r.stdout.length).toBeLessThanOrEqual(2 * 1024 * 1024)
        // The TAIL is what every consumer reads (`outputTail`, `captureHealthOutput`
        // both take the end), so a cap that drops the end drops the diagnosis.
        expect(r.stdout).toContain('TAIL_MARKER')
    })
})

describe.skipIf(!posix)('nothing is lost on the way out', () => {
    // The runtime drains a pipe nobody else holds BEFORE it emits `exit`. Spawn a
    // child that writes 1 KiB, 64 KiB, 1 MiB and 8 MiB and count bytes arriving
    // after the `exit` event: zero at every size. So the drain window is headroom
    // for the case where something else holds the pipe, not the thing correctness
    // rests on.
    test('a large command that exits immediately keeps every character', async () => {
        const size = 512 * 1024 // under the cap: nothing may be elided
        const r = await within(
            15_000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', `head -c ${size} /dev/zero | tr "\\0" "x"`],
                timeoutMs: 60_000
            })
        )
        expect(r.status).toBe(0)
        expect(r.stdout.length).toBe(size)
        expect(r.stdout).not.toContain('elided')
    })

    test('the cap keeps the HEAD the gap ladder reads and the TAIL the reason reads', async () => {
        // Both ends are load-bearing and different code reads each.
        // `isCommandNotFound` and the two gap regexes match wording a runner
        // prints FIRST; `outputTail` slices `-limit` with limit defaulting to 400
        // (command-run.ts:310), so every failure reason reads the LAST 400
        // characters. A cap that keeps one end reclassifies the other's command.
        const r = await within(
            30_000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: [
                    '-c',
                    'echo "sh: 1: nosuchtool: not found"; '
                        + 'head -c 4194304 /dev/zero | tr "\\0" "x"; '
                        + 'echo; echo TAIL_MARKER; exit 127'
                ],
                timeoutMs: 60_000
            })
        )
        expect(r.status).toBe(127)
        expect(r.stdout).toContain('nosuchtool: not found')
        expect(r.stdout).toContain('TAIL_MARKER')
        expect(r.stdout).toContain('elided')
        // The verdict must be unchanged by the elision — this is the whole point.
        expect(classifyCommandRun(r)).toEqual({
            outcome: 'gap',
            gap: 'command-not-found',
            detail: 'command not found (127)'
        })
        expect(outputTail(r.stdout, r.stderr)).toContain('TAIL_MARKER')
    })

    test('capping stays cheap — 32 MiB of output is not quadratic', async () => {
        const started = performance.now()
        const r = await within(
            60_000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: ['-c', 'head -c 33554432 /dev/zero | tr "\\0" "x"'],
                timeoutMs: 120_000
            })
        )
        expect(r.status).toBe(0)
        // A tail kept by repeatedly `slice`-ing a growing string copies the whole
        // buffer on every chunk, which is quadratic and shows up at this size.
        // The ceiling here is deliberately loose: it only has to catch a real
        // blow-up, not pin a number that moves with the machine.
        expect(performance.now() - started).toBeLessThan(5000)
    })
})

// NOT skipped anywhere, and it spawns the runtime itself rather than a POSIX
// shell so it runs on every platform CI covers.
describe('the deadline timer stays armed', () => {
    test('the deadline FIRES and bounds a long command — on every platform', async () => {
        // The behavioural half. An unref'd timer does not hold the event loop
        // open, so once nothing else is pending it never fires — and with
        // `spawnSync`'s own `timeout` gone, this timer is the only bound left on
        // every gate command. `sh` is not portable, so this spawns the runtime.
        const started = performance.now()
        const r = await within(
            5000,
            spawnCommand({
                cwd,
                bin: process.execPath,
                args: ['-e', 'setTimeout(() => {}, 30000)'],
                timeoutMs: 700
            })
        )
        expect(r.failedToStart).toBe(false)
        expect(r.status).toBe(null)
        expect(performance.now() - started).toBeLessThan(4000)
    })

    test("it is not unref'd — an unref'd timer never fires at all on Windows", async () => {
        // An unref'd timer does not keep the event loop alive, so it can be
        // skipped entirely. With `spawnSync`'s own `timeout` gone this timer is
        // the ONLY bound left on every gate command, so unref-ing it means those
        // commands run unbounded.
        const realSetTimeout = globalThis.setTimeout
        let unrefCalls = 0
        globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
            const handle = realSetTimeout(fn, ms, ...rest) as unknown as {unref?: () => unknown}
            const realUnref = handle.unref?.bind(handle)
            if (realUnref) {
                handle.unref = () => {
                    unrefCalls++
                    return realUnref()
                }
            }
            return handle
        }) as unknown as typeof globalThis.setTimeout
        try {
            const r = await spawnCommand({
                cwd,
                bin: process.execPath,
                args: ['--version'],
                timeoutMs: 30_000
            })
            expect(r.status).toBe(0)
        } finally {
            globalThis.setTimeout = realSetTimeout
        }
        expect(unrefCalls).toBe(0)
    })
})
