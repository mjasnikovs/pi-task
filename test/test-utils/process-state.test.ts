import {expect, test} from 'bun:test'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {dead} from './process-state.js'
import {tmpDir} from './tmp-dir.js'

// linux names a process after the file it ran, so the name can read like a state.
test.skipIf(process.platform !== 'linux')("a running process named 'a) Zed' is alive", async () => {
    const link = path.join(tmpDir('odd-comm-'), 'a) Zed')
    fs.symlinkSync(process.execPath, link)
    const child = spawn(link, ['-e', 'console.log(1); setInterval(() => {}, 1 << 30)'], {
        stdio: ['ignore', 'pipe', 'ignore']
    })
    try {
        await new Promise(resolve => child.stdout.once('data', resolve))
        expect(dead(child.pid!)).toBe(false)
    } finally {
        child.kill('SIGKILL')
    }
})
