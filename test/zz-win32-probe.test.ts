// TEMPORARY measurement probe for the reap review, round 3. Never fails; prints ::probe lines.
import {test} from 'bun:test'
import {spawn, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const log = (k: string, v: unknown): void =>
    console.log(`::probe ${process.platform} ${k} ${JSON.stringify(v)}`)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-probe-'))

function timed(cmd: string, args: string[]) {
    const t0 = Date.now()
    const r = spawnSync(cmd, args, {encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024})
    return {ms: Date.now() - t0, status: r.status, bytes: (r.stdout ?? '').length, err: String(r.stderr ?? r.error ?? '').slice(0, 200), out: r.stdout ?? ''}
}

test(
    'probe',
    async () => {
        // W8: can a process's environment be read back, for a backgrounded grandchild too?
        if (process.platform === 'darwin' || process.platform === 'linux') {
            try {
                const token = `PI_TASK_PROBE=${Date.now()}`
                const p = spawn('bash', ['-c', 'sleep 60 & echo $!; wait'], {
                    detached: true,
                    stdio: ['ignore', 'pipe', 'ignore'],
                    env: {...process.env, PI_TASK_PROBE: token.split('=')[1]}
                })
                const gc = await new Promise<number>(r => p.stdout.once('data', d => r(Number(String(d).trim()))))
                const ps = timed('ps', ['-Ewwo', 'pid=,command='])
                const lines = ps.out.split('\n').filter(l => l.includes(token))
                log('W8 ps -E', {ms: ps.ms, status: ps.status, bytes: ps.bytes, bash: p.pid, sleep: gc, matches: lines.map(l => l.slice(0, 160) + ' … ' + l.slice(l.indexOf(token) - 20, l.indexOf(token) + token.length + 5))})
                const fields = timed('ps', ['-Aww', '-o', 'pid=,ppid=,pgid=,lstart=,command=', '-E'])
                log('W8 ps -E with fields', {ms: fields.ms, sample: fields.out.split('\n').filter(l => l.includes(token)).map(l => l.slice(0, 120))})
                process.kill(-p.pid!, 'SIGKILL')
            } catch (e) {
                log('W8 error', String(e))
            }
        }

        // W9: how fast can Windows list pid, parent and creation time?
        if (process.platform === 'win32') {
            const ps = 'powershell.exe'
            const common = ['-NoProfile', '-NonInteractive', '-Command']
            for (const [name, script] of [
                ['cim-all', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
                ['cim-props', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'],
                ['cim-props-again', 'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'],
                ['echo-only', '"x"']
            ] as const) {
                const r = timed(ps, [...common, script])
                log(`W9 ${name}`, {ms: r.ms, status: r.status, bytes: r.bytes, err: r.err, head: r.out.slice(0, 120)})
            }
            const w = timed('wmic', ['process', 'get', 'ProcessId,ParentProcessId,CreationDate', '/format:csv'])
            log('W9 wmic', {ms: w.ms, status: w.status, bytes: w.bytes, err: w.err, head: w.out.slice(0, 160)})
            const pwsh = timed('pwsh.exe', [...common, '"x"'])
            log('W9 pwsh echo', {ms: pwsh.ms, status: pwsh.status, err: pwsh.err})
            try {
                const src = path.join(dir, 'snap.ts')
                fs.writeFileSync(
                    src,
                    `import {dlopen, FFIType, ptr} from 'bun:ffi'
const k = dlopen('kernel32.dll', {CreateToolhelp32Snapshot: {args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr}})
console.log(k.symbols.CreateToolhelp32Snapshot(2, 0) ? 'snapshot ok' : 'snapshot null')
`
                )
                const b = timed(process.execPath, [src])
                log('W9 bun ffi toolhelp', {ms: b.ms, status: b.status, out: b.out.trim(), err: b.err})
            } catch (e) {
                log('W9 ffi error', String(e))
            }
        }
    },
    180_000
)
