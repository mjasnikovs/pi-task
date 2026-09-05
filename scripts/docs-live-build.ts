/**
 * Record each project's build/test verdict, in the container the runs happened in.
 *
 * Separate from the audit on purpose. The toolchains — bun, cargo, ghc — live
 * here; a build run anywhere else is another machine's answer. This writes the
 * verdict next to the run and the audit scores what it finds, the same discipline
 * the answer log follows.
 *
 *   bun scripts/docs-live-build.ts <run-root>
 *
 * `bun run test` globs `scripts/`, so nothing here runs on import.
 */

import {execSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {PROJECTS} from './docs-live-truth.js'

function record(runRoot: string): void {
    for (const spec of PROJECTS) {
        const dir = path.join(runRoot, spec.id)
        if (!fs.existsSync(dir)) continue
        let ok = true
        let output = ''
        try {
            output = execSync(spec.testCommand, {
                cwd: dir,
                encoding: 'utf8',
                stdio: 'pipe',
                timeout: 900_000
            })
        } catch (err) {
            const e = err as {stdout?: string; stderr?: string; message: string}
            ok = false
            output = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message}`
        }
        const out = {ok, cmd: spec.testCommand, output: output.slice(-4000)}
        fs.writeFileSync(
            path.join(runRoot, `${spec.id}.build.json`),
            `${JSON.stringify(out, null, 2)}\n`,
            'utf8'
        )
        console.log(`${spec.id}: ${ok ? 'green' : 'RED'}  (${spec.testCommand})`)
    }
}

if (import.meta.main) {
    const runRoot = process.argv[2]
    if (!runRoot) {
        console.error('usage: bun scripts/docs-live-build.ts <run-root>')
        process.exit(1)
    }
    record(runRoot)
}
