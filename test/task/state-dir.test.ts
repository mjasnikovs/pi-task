/**
 * The run state directory — where the trail lives now that it is out of the tree.
 *
 * Two properties are load-bearing and neither is visible from a unit assertion on
 * a path string alone, so both are proved against a real run below: a run's logs
 * land under the state dir, and `.pi-tasks/` gains NOTHING as they grow. The
 * second is what lets `snapshotTrail` keep copying `.pi-tasks/` whole.
 */
import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    currentRunId,
    pruneRunLogs,
    repoHash,
    repoStateDir,
    runLogPath,
    stateDir,
    stateHome
} from '../../src/task/state-dir.js'
import {makeDebugAppender} from '../../src/task/debug-log.js'
import {closeRunContext, openRunContext} from '../../src/task/run-context.js'
import {TaskRunner} from '../../src/task/orchestrator.js'
import {happy} from '../test-utils/happy-phases.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

const savedXdg = process.env.XDG_STATE_HOME

afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedXdg
})

/**
 * Wait until `check` answers. Each pass waits as long as the one before it took, so
 * the wait costs no core and no interval invented here. What never arrives is caught
 * by the suite's own per-test timeout.
 */
async function settles(check: () => Promise<boolean>): Promise<void> {
    for (;;) {
        const started = performance.now()
        if (await check()) return
        await new Promise(resolve => setTimeout(resolve, performance.now() - started))
    }
}

/**
 * Wait for `file` to hold `needle`. The appender is fire-and-forget by design — a run
 * must never wait on its own trail — so there is nothing to await. This is the wait,
 * not an assertion: the content is the real signal, since an append opens the file
 * before it writes and a read that races the open returns "" from a file that exists.
 */
async function waitForLine(file: string, needle: string): Promise<void> {
    await settles(async () => {
        try {
            return (await fsp.readFile(file, 'utf8')).includes(needle)
        } catch {
            return false
        }
    })
}

/** List what `dir` holds once the appender has created it and put a match in it. */
async function listWhenFilled(
    dir: string,
    keep: (name: string) => boolean = () => true
): Promise<string[]> {
    let names: string[] = []
    await settles(async () => {
        try {
            names = (await fsp.readdir(dir)).filter(keep)
        } catch {
            return false
        }
        return names.length > 0
    })
    return names
}

describe('path layout', () => {
    test('a run directory is <state home>/pi-task/<repo hash>/<run id>', () => {
        process.env.XDG_STATE_HOME = '/state'
        expect(stateDir('/work/repo', 'r1')).toBe(
            path.join('/state', 'pi-task', repoHash('/work/repo'), 'r1')
        )
        expect(repoStateDir('/work/repo')).toBe(path.dirname(stateDir('/work/repo', 'r1')))
    })

    test('the hash is stable per repository and separates two of them', () => {
        expect(repoHash('/work/repo')).toBe(repoHash('/work/repo/'))
        expect(repoHash('/work/repo')).not.toBe(repoHash('/work/other'))
        // A directory name, so it must survive being one: no slashes, no dots.
        expect(repoHash('/work/repo')).toMatch(/^[0-9a-f]+$/)
    })

    /** XDG says a relative value is to be IGNORED. Resolving one would scatter log
     *  directories through whatever repository happened to be the cwd. */
    test('a relative XDG_STATE_HOME falls back to the home directory', () => {
        process.env.XDG_STATE_HOME = 'relative/state'
        expect(stateHome()).toBe(path.join(os.homedir(), '.local', 'state'))
        process.env.XDG_STATE_HOME = '   '
        expect(stateHome()).toBe(path.join(os.homedir(), '.local', 'state'))
    })
})

describe('run id', () => {
    test("inside a run the id is the run context's, so every task shares one directory", () => {
        const rc = openRunContext('/work/repo')
        try {
            expect(currentRunId('/work/repo')).toBe(rc.runId)
        } finally {
            closeRunContext(rc)
        }
    })

    test('a line written outside any run still gets one stable directory', () => {
        const id = currentRunId('/work/repo')
        expect(id.length).toBeGreaterThan(0)
        expect(currentRunId('/work/repo')).toBe(id)
        const rc = openRunContext('/work/repo')
        try {
            expect(currentRunId('/work/repo')).not.toBe(id)
        } finally {
            closeRunContext(rc)
        }
    })

    test('runLogPath puts the file in this run id directory', () => {
        process.env.XDG_STATE_HOME = '/state'
        const rc = openRunContext('/work/repo')
        try {
            expect(runLogPath('/work/repo', 'verify-debug.log')).toBe(
                path.join(stateDir('/work/repo', rc.runId), 'verify-debug.log')
            )
        } finally {
            closeRunContext(rc)
        }
    })
})

describe('pruneRunLogs', () => {
    /** Runs with mtimes a second apart, so "most recent" is unambiguous. */
    function seedRuns(cwd: string, names: string[]): void {
        const base = Date.now() / 1000
        names.forEach((name, i) => {
            const dir = path.join(repoStateDir(cwd), name)
            fs.mkdirSync(dir, {recursive: true})
            fs.writeFileSync(path.join(dir, 'verify-debug.log'), 'x\n')
            fs.utimesSync(dir, base + i, base + i)
        })
    }

    test('keeps the most recent runs and removes the rest', async () => {
        process.env.XDG_STATE_HOME = tmpDir('state-prune-')
        const cwd = '/work/repo'
        seedRuns(cwd, ['oldest', 'middle', 'newest'])
        expect(await pruneRunLogs(cwd, 2)).toEqual(['oldest'])
        expect(fs.readdirSync(repoStateDir(cwd)).sort()).toEqual(['middle', 'newest'])
    })

    test('a repository under the limit loses nothing', async () => {
        process.env.XDG_STATE_HOME = tmpDir('state-prune-')
        const cwd = '/work/repo'
        seedRuns(cwd, ['a', 'b'])
        expect(await pruneRunLogs(cwd, 2)).toEqual([])
        expect(fs.readdirSync(repoStateDir(cwd)).sort()).toEqual(['a', 'b'])
    })

    test('a repository that has never run is not an error', async () => {
        process.env.XDG_STATE_HOME = tmpDir('state-prune-')
        expect(await pruneRunLogs('/work/never-run', 2)).toEqual([])
    })

    /** A nonsense budget must not read as "keep the last one": `slice(-1)`. */
    test('a negative budget removes every run rather than all but one', async () => {
        process.env.XDG_STATE_HOME = tmpDir('state-prune-')
        const cwd = '/work/repo'
        seedRuns(cwd, ['a', 'b'])
        expect((await pruneRunLogs(cwd, -1)).sort()).toEqual(['a', 'b'])
        expect(fs.readdirSync(repoStateDir(cwd))).toEqual([])
    })
})

describe('the trail leaves the repository', () => {
    test('the appender creates the run directory it writes into', async () => {
        await withTmpTaskDir(async cwd => {
            const file = runLogPath(cwd, 'verify-debug.log')
            expect(fs.existsSync(path.dirname(file))).toBe(false)
            makeDebugAppender(file)('=== verify start ===')
            await waitForLine(file, '=== verify start ===')
            expect(fs.existsSync(path.dirname(file))).toBe(true)
        })
    })

    /**
     * The defect this workstream exists for: a 1.7 MB trail under `.pi-tasks/` is
     * committed with every task, rewound by every gate, and copied whole by
     * `snapshotTrail`. A run's logs must add nothing there at all.
     */
    test('a whole task run writes its log to the state dir and none to .pi-tasks', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await new TaskRunner({
                ctx,
                cwd,
                rawPrompt: 'run lint',
                sendSpec: () => Promise.resolve(),
                seams: happy()
            }).run()

            const runs = await listWhenFilled(repoStateDir(cwd))
            expect(runs).toHaveLength(1)
            const runDir = stateDir(cwd, runs[0])
            // Waited for, not listed once: the appender creates the file after the
            // run it describes has ended, so a listing read now may still be empty.
            const logs = await listWhenFilled(runDir, f => f.endsWith('-debug.log'))
            expect(logs).toEqual(['TASK_0001-debug.log'])
            await waitForLine(path.join(runDir, logs[0]!), 'run: start')

            const trail = fs.readdirSync(path.join(cwd, '.pi-tasks'))
            expect(trail.filter(f => f.endsWith('.log'))).toEqual([])
        })
    })
})
