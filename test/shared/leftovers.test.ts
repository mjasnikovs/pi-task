import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    BASH_ENV_SCRIPT,
    linuxPidsWith,
    parseProcessTable,
    parseShells,
    pidsInPsTable,
    startedByShells
} from '../../src/shared/leftovers.js'
import {testPosix} from '../test-utils/platform.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

describe('linux: the token in /proc/<pid>/environ', () => {
    test('only the whole variable matches, first in the environment or later', () => {
        const root = tmpDir('fake-proc-')
        const environ = (pid: string, vars: string[]): void => {
            fs.mkdirSync(path.join(root, pid))
            fs.writeFileSync(path.join(root, pid, 'environ'), vars.map(v => `${v}\0`).join(''))
        }
        environ('10', ['T=abc', 'HOME=/h'])
        environ('11', ['HOME=/h', 'T=abc'])
        environ('12', ['HOME=/h', 'T=abcd'])
        environ('13', ['XT=abc'])
        fs.mkdirSync(path.join(root, 'self'))
        expect(linuxPidsWith('T=abc', root).sort()).toEqual([10, 11])
    })

    test('no process table reads as nothing to reap', () => {
        expect(linuxPidsWith('T=abc', path.join(tmpDir('no-proc-'), 'proc'))).toEqual([])
    })
})

describe('darwin: the token in `ps -E` rows', () => {
    test('the pid of each row that carries it', () => {
        // Row shape as darwin's ps printed it on the macos runner, token appended.
        const table = [
            ' 1200  1199  1200 Mon Sep 14 16:34:16 2026     bash -c sleep 60 & echo $!; wait NODE_ENV=test PI_TASK_LEFTOVER_TOKEN=abc',
            ' 1201  1200  1200 Mon Sep 14 16:34:16 2026     sleep 60 GITHUB_JOB=probe PI_TASK_LEFTOVER_TOKEN=abc HOME=/Users/runner',
            ' 1300     1  1300 Mon Sep 14 16:30:00 2026     /usr/sbin/cfprefsd agent HOME=/Users/runner'
        ].join('\n')
        expect(pidsInPsTable(table, 'PI_TASK_LEFTOVER_TOKEN=abc')).toEqual([1200, 1201])
    })
})

describe('win32: the shells BASH_ENV records', () => {
    test('one shell per run, closed by its exit, in either decimal mark', () => {
        const registry = [
            'ran 6844 1789403248.667522',
            'ran 7000 1789403249,000001',
            'exited 6844 1789403250.000000',
            'ran 5 1789403251.000000',
            'exited 5 1789403252.000000',
            'ran 5 1789403253.000000',
            'ran 7100 ',
            'junk'
        ].join('\n')
        expect(parseShells(registry)).toEqual([
            {pid: 6844, ranAt: 134338768486675220n, exitedAt: 134338768500000000n},
            {pid: 7000, ranAt: 134338768490000010n},
            {pid: 5, ranAt: 134338768510000000n, exitedAt: 134338768520000000n},
            {pid: 5, ranAt: 134338768530000000n}
        ])
    })

    // FILETIMEs from the windows runner: the shell, and the MSYS stub that held the
    // server it backgrounded, created 7ms after the shell ran.
    const shellRan = 'ran 6844 1789403248.667522'
    const stub = '10060 6844 134338768486747190'

    test("a shell's children, not those of a process that held its pid before or after", () => {
        const shells = parseShells(`${shellRan}\nexited 6844 1789403248.700000`)
        const rows = parseProcessTable(
            [stub, '11000 6844 134338768490000000', '9000 6844 134338768400000000'].join('\r\n')
        )
        expect(startedByShells(rows, shells)).toEqual([10060])
    })

    test('a shell with no exit on record counts only while it still holds its pid', () => {
        const shells = parseShells(shellRan)
        const holder = (createdAt: string) => parseProcessTable(`6844 700 ${createdAt}\n${stub}`)
        expect(startedByShells(holder('134338768486000000'), shells)).toEqual([10060])
        expect(startedByShells(holder('134338768486800000'), shells)).toEqual([])
        expect(startedByShells(parseProcessTable(stub), shells)).toEqual([])
    })

    // Git Bash runs the same script on the windows runner, through pi's bash tool, in
    // child-process.test.ts; `bash` on a windows PATH may be WSL's instead.
    testPosix("bash records its run and exit, after the user's own BASH_ENV", () => {
        const dir = tmpDir('bash-env-')
        const script = path.join(dir, 'bash-env.sh')
        const registry = path.join(dir, 'shells')
        const user = path.join(dir, 'user.sh')
        fs.writeFileSync(script, BASH_ENV_SCRIPT)
        fs.writeFileSync(user, `echo user >> '${registry}'\n`)
        const r = spawnSync('bash', ['-c', 'exit 3'], {
            env: {
                ...process.env,
                BASH_ENV: script,
                PI_TASK_SHELL_REGISTRY: registry,
                PI_TASK_USER_BASH_ENV: user
            }
        })
        expect(r.status).toBe(3)
        const [first, ...rows] = fs.readFileSync(registry, 'utf8').trim().split('\n')
        expect(first).toBe('user')
        const shells = parseShells(rows.join('\n'))
        expect(shells).toHaveLength(1)
        expect(shells[0]!.exitedAt! >= shells[0]!.ranAt).toBe(true)
    })
})
