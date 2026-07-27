/**
 * STEP 0 rig for "integration depth of authored VERIFY blocks" (nexttask TASK 3).
 *
 * Answers two questions over already-completed .pi-tasks runs, with no model
 * time, re-runnably:
 *
 *   (a) What fraction of authored VERIFY blocks BOOT or HIT the real integrated
 *       product, per the published regex below?
 *   (b) For every block that does NOT, WHY not — split into the three classes
 *       the task defines, only one of which is addressable by a lever:
 *         (i)   nothing runnable to integrate against (no runtime-behaviour
 *               claim in the task's own ACCEPTANCE),
 *         (ii)  an integration command existed and was available, but the
 *               VERIFY block did not use it,          <-- addressable
 *         (iii) integration was impossible in that sandbox (the project has no
 *               boot/serve command with provenance at all).
 *
 * Usage:  bun run scripts/verify-integration-depth-step0.ts <projectDir> [...]
 *         bun run scripts/verify-integration-depth-step0.ts --json <projectDir>
 */

import {execFileSync} from 'node:child_process'
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import path from 'node:path'

import {parseVerifyBlock} from '../src/task/spec-validation.js'

/**
 * PUBLISHED METRIC REGEX. A VERIFY block is "integrated" when at least one of
 * its commands boots the product or talks to it over the wire. Kept mechanical
 * and deliberately generous — a false positive costs us the case, and we would
 * rather understate the gap than overstate it.
 */
export const INTEGRATION_RE =
    /\bcurl\b|\blocalhost\b|\b127\.0\.0\.1\b|\bPORT=|\brun +dev\b|\brun +start\b|\brun +serve\b|\brun +preview\b|https?:\/\//

/**
 * Does the task's own ACCEPTANCE claim RUNTIME behaviour — something that only
 * exists when the product actually executes? Type-level, config and doc tasks
 * do not, and no integration command can be appended to them honestly.
 */
export const RUNTIME_CLAIM_RE =
    /\b(?:returns?|responds?|response|request|endpoint|route|renders?|displays?|navigat\w*|redirects?|serves?|boots?|starts? (?:up|the (?:server|app))|listens?|logs? in|login|logout|session|cookie|status (?:code )?[1-5]\d\d|\b[1-5]\d\d\b(?= (?:response|status|OK))|GET|POST|PUT|PATCH|DELETE|user can|clicking|submits?|uploads?|persists?|round-?trips?)\b/i

export interface TaskRow {
    project: string
    file: string
    verifyCmds: string[]
    integrated: boolean
    runtimeClaim: boolean
    klass: 'integrated' | 'i-nothing-runnable' | 'ii-available-unused' | 'iii-impossible'
}

/**
 * Boot/run commands with PROVENANCE. Provenance means BOTH halves are facts on
 * disk / on PATH, never model-authored prose: a manifest entry (or a marker
 * file the runner requires) AND the binary that executes it. This is the
 * distinction N5 turned on — `## verified tooling` is prose, `project.godot`
 * plus `which godot` is not.
 *
 * Deliberately NOT npm-only: an npm-only detector would classify every non-npm
 * task as "integration impossible" and manufacture the kill condition.
 */
export function bootCommandsWithProvenance(projectDir: string): {cmd: string; why: string}[] {
    const out: {cmd: string; why: string}[] = []
    const has = (f: string) => existsSync(path.join(projectDir, f))
    const onPath = (bin: string) => {
        try {
            execFileSync('sh', ['-c', `command -v ${bin}`], {stdio: 'pipe'})
            return true
        } catch {
            return false
        }
    }

    const pkgPath = path.join(projectDir, 'package.json')
    if (existsSync(pkgPath)) {
        try {
            const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
                scripts?: Record<string, unknown>
            }
            for (const name of Object.keys(parsed.scripts ?? {})) {
                if (/^(dev|start|serve|preview)$/.test(name)) {
                    out.push({cmd: `bun run ${name}`, why: `package.json:scripts.${name}`})
                }
            }
        } catch {
            /* unparseable manifest — no provenance */
        }
    }
    if (has('.pi-tasks/launch-contract.md')) {
        out.push({cmd: '<launch contract>', why: 'launch-contract.md on disk'})
    }
    if (has('project.godot') && onPath('godot')) {
        out.push({cmd: 'godot --headless --quit', why: 'project.godot + godot on PATH'})
    }
    if ((has('CMakePresets.json') || has('CMakeLists.txt')) && onPath('cmake')) {
        out.push({cmd: 'cmake --build build', why: 'CMake manifest + cmake on PATH'})
    }
    if (has('Makefile') && onPath('make')) out.push({cmd: 'make', why: 'Makefile + make on PATH'})
    if (has('Cargo.toml') && onPath('cargo')) {
        out.push({cmd: 'cargo run', why: 'Cargo.toml + cargo on PATH'})
    }
    if (has('go.mod') && onPath('go')) out.push({cmd: 'go run ./...', why: 'go.mod + go on PATH'})
    return out
}

function acceptanceOf(spec: string): string {
    // Take the LAST ACCEPTANCE section (the composed `## spec`, not the refined
    // prompt), up to the VERIFY header that follows it.
    const lines = spec.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) if (/^\s*ACCEPTANCE\b/.test(lines[i])) start = i
    if (start < 0) return ''
    const rest = lines.slice(start + 1)
    const end = rest.findIndex(l => /^\s*(VERIFY|##\s)/.test(l))
    return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

export function classifyProject(projectDir: string): TaskRow[] {
    const project = path.basename(projectDir)
    const tasksDir = path.join(projectDir, '.pi-tasks')
    if (!existsSync(tasksDir)) return []
    const boot = bootCommandsWithProvenance(projectDir)
    const files = readdirSync(tasksDir)
        .filter(f => /^TASK_.*\.md$/.test(f))
        .sort()
    const rows: TaskRow[] = []
    for (const file of files) {
        const spec = readFileSync(path.join(tasksDir, file), 'utf8')
        const cmds = parseVerifyBlock(spec)
        if (cmds === null) continue // no authored VERIFY block at all
        const verifyCmds = cmds.map(c => c.raw)
        const integrated = verifyCmds.some(c => INTEGRATION_RE.test(c))
        const runtimeClaim = RUNTIME_CLAIM_RE.test(acceptanceOf(spec))
        const klass: TaskRow['klass'] =
            integrated ? 'integrated'
            : boot.length === 0 ? 'iii-impossible'
            : !runtimeClaim ? 'i-nothing-runnable'
            : 'ii-available-unused'
        rows.push({project, file, verifyCmds, integrated, runtimeClaim, klass})
    }
    return rows
}

function main() {
    const args = process.argv.slice(2)
    const asJson = args.includes('--json')
    const dirs = args.filter(a => a !== '--json')
    if (dirs.length === 0) {
        console.error('usage: verify-integration-depth-step0.ts [--json] <projectDir> [...]')
        process.exit(64)
    }
    const all: TaskRow[] = []
    for (const d of dirs) all.push(...classifyProject(d))
    if (asJson) {
        console.log(JSON.stringify(all, null, 2))
        return
    }

    console.log(`METRIC REGEX: ${INTEGRATION_RE}`)
    console.log(`RUNTIME-CLAIM REGEX: ${RUNTIME_CLAIM_RE}\n`)
    for (const d of dirs) {
        const rows = all.filter(r => r.project === path.basename(d))
        if (rows.length === 0) {
            console.log(`${path.basename(d)}: no .pi-tasks specs with a VERIFY block`)
            continue
        }
        const n = rows.length
        const integ = rows.filter(r => r.integrated).length
        const boot = bootCommandsWithProvenance(d)
        console.log(
            `${path.basename(d).padEnd(14)} integrated ${integ}/${n} ` +
                `(${Math.round((integ / n) * 100)}%)  boot-provenance: ${boot.map(b => b.why).join(', ') || 'NONE'}`
        )
        for (const k of ['i-nothing-runnable', 'ii-available-unused', 'iii-impossible'] as const) {
            const c = rows.filter(r => r.klass === k).length
            if (c > 0) console.log(`               ${k}: ${c}`)
        }
    }
    const n = all.length
    const integ = all.filter(r => r.integrated).length
    const ii = all.filter(r => r.klass === 'ii-available-unused').length
    console.log(`\nTOTAL integrated ${integ}/${n} (${((integ / n) * 100).toFixed(1)}%)`)
    for (const k of ['i-nothing-runnable', 'ii-available-unused', 'iii-impossible'] as const) {
        const c = all.filter(r => r.klass === k).length
        console.log(`TOTAL ${k}: ${c}/${n} (${((c / n) * 100).toFixed(1)}%)`)
    }
    console.log(
        `\nKILL CONDITION: class (ii) < 25% of tasks => ` +
            `${((ii / n) * 100).toFixed(1)}% ${ii / n < 0.25 ? 'FIRES (stop)' : 'does not fire'}`
    )
}

if (import.meta.main) main()
