/**
 * STEP 0 part 2 for nexttask TASK 3 — establish a KNOWN-RUNNABLE integration
 * command source with provenance.
 *
 * N5 refuted the previous source (`## verified tooling` is model-authored prose,
 * 6 of 12 godot entries fabricated) and named the replacement bar: "make the run
 * actually execute what it records and store the cwd and exit code alongside
 * each entry". This rig is that bar, applied offline:
 *
 *   candidate = (manifest/marker file on disk) x (binary on PATH)   <- provenance
 *   proven    = candidate EXECUTED in the project cwd, TERMINATED inside the
 *               timeout, and exited 0                                <- runnable
 *
 * A command that does not terminate (a watch-mode dev server) is NOT proven and
 * must never be appended to a VERIFY block: the verify child would hang until the
 * 15-minute command watchdog killed it and then FAIL. That is the N5 failure mode
 * (a lever that converts PASS into FAIL) reached by a different road.
 *
 * Usage: bun run scripts/integration-command-provenance.ts <projectDir> [...]
 *        (clone first — this EXECUTES commands in the directory you name)
 */

import {spawn} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import path from 'node:path'

import {INTEGRATION_RE} from './verify-integration-depth-step0.js'

export interface Candidate {
    cmd: string
    provenance: string
    /** Boot-shaped commands are expected not to terminate; probed anyway. */
    shape: 'boot' | 'build' | 'test'
}

export interface Probed extends Candidate {
    exitCode: number | null
    terminated: boolean
    ms: number
    matchesMetric: boolean
}

const TIMEOUT_MS = 60_000

function onPath(bin: string): boolean {
    const dirs = (process.env.PATH ?? '').split(path.delimiter)
    return dirs.some(d => d && existsSync(path.join(d, bin)))
}

export function candidates(projectDir: string): Candidate[] {
    const out: Candidate[] = []
    const has = (f: string) => existsSync(path.join(projectDir, f))
    const pkgPath = path.join(projectDir, 'package.json')
    if (existsSync(pkgPath) && onPath('bun')) {
        let scripts: Record<string, unknown> = {}
        try {
            const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
                scripts?: Record<string, unknown>
            }
            scripts = parsed.scripts ?? {}
        } catch {
            /* unparseable manifest — no provenance */
        }
        for (const name of Object.keys(scripts)) {
            const shape: Candidate['shape'] | null =
                /^(dev|start|serve|preview)$/.test(name) ? 'boot'
                : /^build$/.test(name) ? 'build'
                : name === 'test' || /^test[:_-]/.test(name) ? 'test'
                : null
            if (shape) out.push({cmd: `bun run ${name}`, provenance: `package.json:scripts.${name}`, shape})
        }
    }
    if (has('project.godot') && onPath('godot')) {
        out.push({
            cmd: 'godot --headless --quit',
            provenance: 'project.godot on disk + godot on PATH',
            shape: 'boot'
        })
    }
    if (has('addons/gut/gut_cmdln.gd') && onPath('godot')) {
        out.push({
            cmd: 'godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test -gexit',
            provenance: 'addons/gut/gut_cmdln.gd on disk + godot on PATH',
            shape: 'test'
        })
    }
    if ((has('CMakePresets.json') || has('CMakeLists.txt')) && onPath('cmake')) {
        out.push({cmd: 'cmake --build build', provenance: 'CMake manifest + cmake on PATH', shape: 'build'})
    }
    if (has('Makefile') && onPath('make')) {
        out.push({cmd: 'make', provenance: 'Makefile + make on PATH', shape: 'build'})
    }
    return out
}

export async function probe(
    projectDir: string,
    c: Candidate,
    timeoutMs: number = TIMEOUT_MS
): Promise<Probed> {
    const t0 = Date.now()
    return await new Promise<Probed>(resolve => {
        const child = spawn('sh', ['-c', c.cmd], {cwd: projectDir, stdio: 'ignore', detached: true})
        let done = false
        const timer = setTimeout(() => {
            if (done) return
            done = true
            try {
                process.kill(-child.pid!, 'SIGKILL')
            } catch {
                /* already gone */
            }
            resolve({
                ...c,
                exitCode: null,
                terminated: false,
                ms: Date.now() - t0,
                matchesMetric: INTEGRATION_RE.test(c.cmd)
            })
        }, timeoutMs)
        child.on('exit', code => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve({
                ...c,
                exitCode: code,
                terminated: true,
                ms: Date.now() - t0,
                matchesMetric: INTEGRATION_RE.test(c.cmd)
            })
        })
        child.on('error', () => {
            if (done) return
            done = true
            clearTimeout(timer)
            resolve({
                ...c,
                exitCode: 127,
                terminated: true,
                ms: Date.now() - t0,
                matchesMetric: INTEGRATION_RE.test(c.cmd)
            })
        })
    })
}

/** A command is APPENDABLE only if it is proven runnable AND terminates fast. */
export function isAppendable(p: Probed): boolean {
    return p.terminated && p.exitCode === 0
}

async function main() {
    const dirs = process.argv.slice(2)
    if (dirs.length === 0) {
        console.error('usage: integration-command-provenance.ts <projectDir> [...]')
        process.exit(64)
    }
    for (const d of dirs) {
        console.log(`\n=== ${d}`)
        const cs = candidates(d)
        if (cs.length === 0) {
            console.log('  no candidate with provenance')
            continue
        }
        for (const c of cs) {
            const p = await probe(d, c)
            console.log(
                `  ${c.cmd.padEnd(58)} ${c.shape.padEnd(5)} ` +
                    `exit=${p.terminated ? p.exitCode : 'TIMEOUT'} ${(p.ms / 1000).toFixed(1)}s ` +
                    `appendable=${isAppendable(p)} matchesMetric=${p.matchesMetric}  [${c.provenance}]`
            )
        }
    }
}

if (import.meta.main) await main()
