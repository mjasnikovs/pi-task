/**
 * REGRESSION — what `spawnCommand` must guarantee now that it is the ONLY bound
 * on every gate command, repo-health command and ACCEPT-debt VERIFY re-run.
 *
 * These four cases were all covered, silently, by the `spawnSync` this replaced:
 * `spawnSync` closed the child's stdin, bounded its output at a 1 MB `maxBuffer`,
 * and returned at its own `timeout` regardless of who else held the pipe. The
 * async runner kept none of those and its tests are all pure classification
 * literals, so nothing in the suite spawns a real child any more.
 *
 * Every case races the run against a deadline of its own: a runner that never
 * settles must FAIL the test, not hang the suite.
 */
import {describe, expect, test} from 'bun:test'
import {classifyCommandRun, outputTail, spawnCommand} from './command-run.js'

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
        // SIGKILL reaches the direct child only. The inherited pipe stays open, so
        // a runner that waits for `close` never reports the timeout it just fired —
        // the 900s gate cap becomes no cap at all.
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
        // `spawnSync` gave the child a closed stdin. `spawn` with the default stdio
        // gives it a live pipe nobody ever ends, so any check that reads stdin — a
        // `cat`-style pipeline, a tool that prompts, a pager — now blocks until the
        // kill timer: 600s for repo-health, 900s for a gate command.
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
        // `spawnSync` bounded this at its 1 MB default `maxBuffer`. Under the 900s
        // cap the async runner accumulates two unbounded strings in the HOST — the
        // TUI process — for as long as the command talks.
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
    // MEASURED before choosing the drain: across 160 trials at 1 KiB / 64 KiB /
    // 1 MiB / 8 MiB, idle and under eight spinning cores, ZERO bytes arrived after
    // `exit` fired — the last chunk lands ~0.3ms BEFORE it. The runtime drains a
    // pipe nobody else holds before it emits `exit`, so the drain window is
    // headroom, not the thing correctness rests on.
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
        // Both ends are load-bearing and they are read by different code.
        // `isCommandNotFound` and the two gap regexes match wording a runner prints
        // FIRST; `outputTail` and every failure reason take the LAST 400 characters.
        // A cap that keeps one end silently reclassifies the other's command.
        const r = await within(
            30_000,
            spawnCommand({
                cwd,
                bin: 'sh',
                args: [
                    '-c',
                    'echo "sh: 1: nosuchtool: not found"; ' +
                        'head -c 4194304 /dev/zero | tr "\\0" "x"; ' +
                        'echo; echo TAIL_MARKER; exit 127'
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
        // MEASURED 72ms for 32 MiB. A tail kept by repeated `slice` of a growing
        // string would be ~700 MB of copying; the ceiling here is deliberately
        // loose, it only has to catch a real blow-up.
        expect(performance.now() - started).toBeLessThan(5000)
    })
})

// NOT skipped on Windows — this is the one case whose whole subject IS Windows,
// and it spawns the runtime itself rather than a POSIX shell so CI (which runs
// ubuntu-latest AND windows-latest) actually exercises it there.
describe('the deadline timer stays armed', () => {
    test('the deadline FIRES and bounds a long command — on every platform', async () => {
        // The behavioural half. The unref'd timer was MEASURED in this repo never to
        // fire on Windows (0/20s), and with `spawnSync`'s own `timeout` gone this
        // timer is the only bound on every gate command. `sh` is not portable, so
        // this spawns the runtime itself.
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
        // MEASURED in this repo: an unref'd timer does not fire on Windows (0/20s)
        // while a ref'd one does. With `spawnSync`'s own `timeout` gone, this timer
        // is the ONLY bound left on every gate command, so disarming it there means
        // those commands run unbounded.
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
