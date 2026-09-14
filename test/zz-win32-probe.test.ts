// TEMPORARY measurement probe for the Windows reap review, round 2. Never fails; prints ::probe lines.
import {test} from 'bun:test'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'

const WIN = process.platform === 'win32'
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-probe-'))
const log = (k: string, v: unknown): void =>
    console.log(`::probe ${process.platform} ${k} ${JSON.stringify(v)}`)
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
const fwd = (p: string) => p.replace(/\\/g, '/')

function processTable(): {rows: Array<{pid: number; ppid: number; created: string; cmd: string}>; ms: number} {
    const t0 = Date.now()
    const r = spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="Created";e={$_.CreationDate.ToString("o")}},CommandLine | ConvertTo-Json -Compress'
        ],
        {encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024}
    )
    const rows = (JSON.parse(r.stdout) as Array<Record<string, unknown>>).map(o => ({
        pid: Number(o.ProcessId),
        ppid: Number(o.ParentProcessId),
        created: String(o.Created),
        cmd: String(o.CommandLine ?? '')
    }))
    return {rows, ms: Date.now() - t0}
}

const piBashLeader = (command: string) => `
import {createLocalBashOperations} from '${PI_BASH}'
const ops = createLocalBashOperations()
let out = ''
await ops.exec(${JSON.stringify(command)}, process.cwd(), {onData: d => (out += d)})
process.stdout.write(out)
process.exit(0)
`
const SERVER = `node -e "setInterval(() => {}, 1 << 30)" & echo GC $(cat /proc/$!/winpid 2>/dev/null || echo $!)`

test(
    'probe',
    async () => {
        // W5: BASH_ENV records every bash-tool shell while it lives; reap its descendants after.
        try {
            const reg = path.join(dir, 'shells')
            const bashEnv = path.join(dir, 'bash-env.sh')
            fs.writeFileSync(
                bashEnv,
                `echo "$$ $(cat /proc/$$/winpid 2>/dev/null || echo $$) $(date +%s%N)" >> '${fwd(reg)}'\n`
            )
            const file = path.join(dir, 'leader5.mjs')
            fs.writeFileSync(file, piBashLeader(SERVER))
            const t0 = Date.now()
            const l = spawn('node', [file], {
                ...(WIN ? {windowsHide: true} : {detached: true}),
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {...process.env, BASH_ENV: fwd(bashEnv)}
            })
            let out = ''
            let err = ''
            l.stdout.on('data', d => (out += d))
            l.stderr.on('data', d => (err += d))
            await new Promise(r => l.on('close', r))
            const gc = Number(/GC (\d+)/.exec(out)?.[1])
            if (gc) survivors.push(gc)
            const shells = fs.existsSync(reg) ? fs.readFileSync(reg, 'utf8').trim().split('\n') : []
            log('W5 registry', {ms: Date.now() - t0, shells, server: gc, err: err.slice(0, 300)})
            if (WIN) {
                const table = processTable()
                const byPid = new Map(table.rows.map(r => [r.pid, r]))
                const chain: unknown[] = []
                let cur = byPid.get(gc)
                for (let i = 0; cur && i < 6; i++) {
                    chain.push({pid: cur.pid, ppid: cur.ppid, created: cur.created, cmd: cur.cmd.slice(0, 120)})
                    cur = byPid.get(cur.ppid)
                }
                const winShells = shells.map(s => Number(s.split(' ')[1]))
                const kids = table.rows.filter(r => winShells.includes(r.ppid))
                log('W5 win chain', {tableMs: table.ms, rows: table.rows.length, chain, kidsOfShells: kids.map(k => ({pid: k.pid, cmd: k.cmd.slice(0, 120), created: k.created}))})
                for (const k of kids) {
                    const r = spawnSync(TASKKILL, ['/pid', String(k.pid), '/T', '/F'], {encoding: 'utf8', windowsHide: true})
                    log('W5 taskkill kid', {pid: k.pid, status: r.status, out: `${r.stdout}${r.stderr}`.trim()})
                }
            } else {
                for (const s of shells) {
                    const pgid = Number(s.split(' ')[0])
                    try {
                        process.kill(-pgid, 'SIGTERM')
                        log('W5 group kill', {pgid, ok: true})
                    } catch (e) {
                        log('W5 group kill', {pgid, err: (e as NodeJS.ErrnoException).code})
                    }
                }
            }
            await sleep(700)
            log('W5 server after reap', {server: gc, alive: gc ? alive(gc) : null})
        } catch (e) {
            log('W5 error', String(e))
        }

        // W6: a compiled logger, hard-linked as System32\taskkill.exe, logs beside itself.
        try {
            const src = path.join(dir, 'taskkill.ts')
            fs.writeFileSync(
                src,
                "import * as fs from 'node:fs'\nimport * as path from 'node:path'\nfs.appendFileSync(path.join(path.dirname(process.execPath), 'calls.log'), `taskkill ${process.argv.slice(2).join(' ')}\\n`)\n"
            )
            const out = path.join(dir, 'taskkill.exe')
            const t0 = Date.now()
            const b = spawnSync(process.execPath, ['build', '--compile', src, '--outfile', out], {encoding: 'utf8'})
            const buildMs = Date.now() - t0
            const root = path.join(dir, 'root', 'System32')
            fs.mkdirSync(root, {recursive: true})
            fs.linkSync(out, path.join(root, 'taskkill.exe'))
            const t1 = Date.now()
            const r = spawnSync(path.join(root, 'taskkill.exe'), ['/pid', '4242', '/T', '/F'], {encoding: 'utf8'})
            log('W6 compiled fake', {
                build: b.status,
                buildMs,
                runMs: Date.now() - t1,
                run: r.status,
                err: String(r.stderr).slice(0, 200),
                log: fs.existsSync(path.join(root, 'calls.log')) ? fs.readFileSync(path.join(root, 'calls.log'), 'utf8') : null
            })
        } catch (e) {
            log('W6 error', String(e))
        }

        // W7: who holds a listening port, by pid and command line.
        if (WIN) {
            try {
                const srv = net.createServer().listen(0, '127.0.0.1')
                await new Promise(r => srv.once('listening', r))
                const port = (srv.address() as net.AddressInfo).port
                const t0 = Date.now()
                const ns = spawnSync('netstat', ['-ano', '-p', 'TCP'], {encoding: 'utf8', windowsHide: true})
                const lines = ns.stdout.split('\n').filter(l => l.includes(`:${port} `))
                log('W7 netstat', {ms: Date.now() - t0, self: process.pid, lines})
                srv.close()
            } catch (e) {
                log('W7 error', String(e))
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
    180_000
)
