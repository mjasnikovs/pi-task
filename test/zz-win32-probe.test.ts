// TEMPORARY measurement probe for the Windows reap review. Never fails; prints ::probe lines.
import {test} from 'bun:test'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

const WIN = process.platform === 'win32'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-probe-'))
const log = (k: string, v: unknown): void => console.log(`::probe ${process.platform} ${k} ${JSON.stringify(v)}`)
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const PI_BASH = pathToFileURL(
    path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js')
).href
const TASKKILL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
const survivors: number[] = []

function reapTree(pid: number) {
    if (WIN) {
        const r = spawnSync(TASKKILL, ['/pid', String(pid), '/T', '/F'], {encoding: 'utf8'})
        return {status: r.status, out: `${r.stdout}${r.stderr}`.trim()}
    }
    try {
        process.kill(-pid, 'SIGKILL')
        return {status: 0}
    } catch (e) {
        return {status: (e as NodeJS.ErrnoException).code}
    }
}

/** Spawn a model-child stand-in under node, shaped like ownGroupSpawnOptions. */
function leader(script: string, args: string[] = []) {
    const file = path.join(dir, `leader-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(file, script)
    const t0 = Date.now()
    const p = spawn('node', [file, ...args], {
        ...(WIN ? {windowsHide: true} : {detached: true}),
        stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    const ev: Record<string, number> = {}
    p.stdout.on('data', d => (out += d))
    p.stderr.on('data', d => (err += d))
    p.on('exit', () => (ev.exit = Date.now() - t0))
    p.on('close', () => (ev.close = Date.now() - t0))
    return {p, ev, out: () => out, err: () => err}
}

async function until(cond: () => boolean, ms: number) {
    const end = Date.now() + ms
    while (!cond() && Date.now() < end) await sleep(20)
    return cond()
}

const piBashLeader = (command: string) => `
import {createLocalBashOperations} from '${PI_BASH}'
const ops = createLocalBashOperations()
let out = ''
await ops.exec(${JSON.stringify(command)}, process.cwd(), {onData: d => (out += d)})
process.stdout.write(out)
if (process.argv[2] === 'stay') { process.stdout.write('\\nREADY\\n'); setInterval(() => {}, 1 << 30) }
else process.exit(0)
`
// Git Bash's $! is an MSYS pid; /proc/<pid>/winpid is the Windows one.
const SERVER = `node -e "setInterval(() => {}, 1 << 30)" & echo GC $(cat /proc/$!/winpid 2>/dev/null || echo $!)`

test(
    'probe',
    async () => {
        // W1 + W2: a server backgrounded through pi's real bash tool, then the child exits.
        try {
            const l = leader(piBashLeader(SERVER))
            await until(() => l.ev.exit !== undefined, 20_000)
            await until(() => l.ev.close !== undefined, 3_000)
            const gc = Number(/GC (\d+)/.exec(l.out())?.[1])
            if (gc) survivors.push(gc)
            log('W1 pi-bash server, child exits', {
                exit: l.ev.exit,
                close: l.ev.close ?? 'NO CLOSE within 3s of exit',
                server: gc,
                serverAlive: gc ? alive(gc) : null,
                err: l.err().slice(0, 300)
            })
            const r = reapTree(l.p.pid!)
            await sleep(700)
            log('W2 reap tree of the EXITED leader', {
                reap: r,
                serverAliveAfter: gc ? alive(gc) : null,
                closeAfter: l.ev.close ?? 'NO CLOSE'
            })
        } catch (e) {
            log('W1 error', String(e))
        }

        // W3: same server, but the leader is still alive when its tree is reaped.
        try {
            const l = leader(piBashLeader(SERVER), ['stay'])
            await until(() => l.out().includes('READY'), 20_000)
            const gc = Number(/GC (\d+)/.exec(l.out())?.[1])
            if (gc) survivors.push(gc)
            const r = reapTree(l.p.pid!)
            await until(() => l.ev.close !== undefined, 3_000)
            await sleep(300)
            log('W3 reap tree of a LIVE leader', {
                reap: r,
                server: gc,
                serverAliveAfter: gc ? alive(gc) : null,
                leaderExit: l.ev.exit ?? 'NO EXIT',
                leaderClose: l.ev.close ?? 'NO CLOSE within 3s'
            })
        } catch (e) {
            log('W3 error', String(e))
        }

        // W1c: a grandchild spawned with stdio 'inherit' holds the leader's own pipes.
        try {
            const l = leader(`
import {spawn} from 'node:child_process'
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {stdio: 'inherit'})
console.log('GC ' + g.pid)
setTimeout(() => process.exit(0), 200)
`)
            await until(() => l.ev.exit !== undefined, 10_000)
            await until(() => l.ev.close !== undefined, 3_000)
            const gc = Number(/GC (\d+)/.exec(l.out())?.[1])
            if (gc) survivors.push(gc)
            log('W1c inherit-stdio grandchild, child exits', {
                exit: l.ev.exit,
                close: l.ev.close ?? 'NO CLOSE within 3s of exit',
                serverAlive: gc ? alive(gc) : null
            })
        } catch (e) {
            log('W1c error', String(e))
        }

        // W4: does a console child get its own window when the host has no console?
        if (WIN) {
            try {
                const probe = path.join(dir, 'console-probe.ts')
                fs.writeFileSync(
                    probe,
                    `import {dlopen, FFIType} from 'bun:ffi'
import * as fs from 'node:fs'
const k = dlopen('kernel32.dll', {GetConsoleWindow: {returns: FFIType.ptr, args: []}})
const u = dlopen('user32.dll', {IsWindowVisible: {returns: FFIType.i32, args: [FFIType.ptr]}})
const h = k.symbols.GetConsoleWindow()
fs.writeFileSync(process.argv[2], JSON.stringify({hwnd: h ? String(h) : null, visible: h ? u.symbols.IsWindowVisible(h) : 0}))
`
                )
                const host = path.join(dir, 'console-host.mjs')
                fs.writeFileSync(
                    host,
                    `import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
const [bun, probe, outDir] = process.argv.slice(2)
const res = {}
for (const [name, opts] of [['plain-1', {}], ['plain-2', {}], ['windowsHide', {windowsHide: true}]]) {
  const out = outDir + '/' + name + '.json'
  const r = spawnSync(bun, [probe, out], {...opts, stdio: 'pipe'})
  res[name] = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {status: r.status, err: String(r.stderr).slice(0, 200)}
}
fs.writeFileSync(outDir + '/result.json', JSON.stringify(res))
`
                )
                for (const [name, opts] of [
                    ['host detached (no console)', {detached: true}],
                    ['host windowsHide', {windowsHide: true}],
                    ['host default', {}]
                ] as const) {
                    const outDir = fs.mkdtempSync(path.join(dir, 'c-'))
                    await new Promise<void>(resolve => {
                        const h = spawn('node', [host, process.execPath, probe, outDir], {
                            ...opts,
                            stdio: 'ignore'
                        })
                        h.on('exit', () => resolve())
                        h.on('error', () => resolve())
                    })
                    const f = path.join(outDir, 'result.json')
                    log(`W4 ${name}`, fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : 'no result')
                }
            } catch (e) {
                log('W4 error', String(e))
            }
        }

        for (const pid of survivors) {
            try {
                process.kill(pid, 'SIGKILL')
            } catch {
                // gone
            }
        }
    },
    120_000
)
