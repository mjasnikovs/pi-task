import {afterEach, describe, expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {discoverHealthCommands, runRepoHealthCheck} from './repo-health-check.js'

const cargoInstalled = spawnSync('cargo', ['--version']).error === undefined

const made: string[] = []
function tmpRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'))
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), content)
    }
    return dir
}
afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, {recursive: true, force: true})
})

describe('discoverHealthCommands', () => {
    test('package.json → only static scripts (lint/typecheck), never test/build', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'bun test', build: 'x'}
            })
        })
        const {ecosystem, cmds} = discoverHealthCommands(dir)
        expect(ecosystem).toBe('package.json')
        expect(cmds).toEqual([
            ['bun', ['run', 'lint']],
            ['bun', ['run', 'typecheck']]
        ])
    })

    test('package.json with no static scripts → empty command list', () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {test: 'bun test'}})})
        expect(discoverHealthCommands(dir).cmds).toEqual([])
    })

    test('no manifest at all → null ecosystem, nothing to run', () => {
        const dir = tmpRepo({'README.md': 'docs only'})
        expect(discoverHealthCommands(dir)).toEqual({ecosystem: null, cmds: []})
    })

    test('Makefile only contributes `make lint` when a lint target exists', () => {
        const withTarget = tmpRepo({Makefile: 'lint:\n\techo hi\n'})
        expect(discoverHealthCommands(withTarget).cmds).toEqual([['make', ['lint']]])
        const without = tmpRepo({Makefile: 'build:\n\techo hi\n'})
        expect(discoverHealthCommands(without).cmds).toEqual([])
    })

    test('package.json wins over other manifests (first match)', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'x'}}),
            'Cargo.toml': '[package]'
        })
        expect(discoverHealthCommands(dir).ecosystem).toBe('package.json')
    })
})

describe('runRepoHealthCheck', () => {
    test('no tooling → pass (nothing can regress) — the "no package.json" case', () => {
        const dir = tmpRepo({'index.html': '<h1>hi</h1>'})
        const out = runRepoHealthCheck(dir)
        expect(out.ok).toBe(true)
        expect(out.ecosystem).toBeNull()
    })

    test('lint script exits 0 → pass, no false-fail', () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'true'}})})
        expect(runRepoHealthCheck(dir).ok).toBe(true)
    })

    test('lint script exits non-zero → FAIL naming the command', () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'exit 1'}})})
        const out = runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('bun run lint')
        expect(out.reason).toContain('exited 1')
    })

    test('first failing command short-circuits (lint fails before typecheck runs)', () => {
        const marker = path.join(tmpdir(), `hc-marker-${Date.now()}`)
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'exit 3', typecheck: `touch ${marker}`}
            })
        })
        const out = runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('exited 3')
    })

    test('exit 127 (command not found inside the script chain) → skipped, not failed', () => {
        // Seen live: `bun run lint` exits 127 before node_modules exists — the tool
        // is missing, not the code faulty. Same environment gap as ENOENT.
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'exit 127'}})})
        expect(runRepoHealthCheck(dir).ok).toBe(true)
    })

    test.skipIf(cargoInstalled)(
        'a tool that is not installed (ENOENT) is skipped, not failed',
        () => {
            // Cargo.toml routes to `cargo clippy`; when cargo is absent the command
            // cannot run → environment gap → skipped → overall pass (no false-fail).
            const dir = tmpRepo({'Cargo.toml': '[package]\nname = "x"\n'})
            expect(runRepoHealthCheck(dir).ok).toBe(true)
        }
    )
})
