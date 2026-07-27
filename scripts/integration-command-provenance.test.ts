/**
 * Unit tests for the provenance/runnability probe (see the header of
 * integration-command-provenance.ts). The lever it was built to feed is REFUTED —
 * the probe is kept because it is the command source N5 asked anyone re-attacking
 * this to build: candidates come from files on disk crossed with binaries on PATH,
 * and each one is EXECUTED before it counts as known-runnable.
 */
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, test} from 'bun:test'

import {candidates, isAppendable, probe} from './integration-command-provenance.js'

const dirs: string[] = []
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true})
})

function project(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'integ-prov-'))
    dirs.push(root)
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel)
        mkdirSync(path.dirname(full), {recursive: true})
        writeFileSync(full, body)
    }
    return root
}

describe('candidates', () => {
    test('classifies manifest scripts by shape and carries provenance', () => {
        const root = project({
            'package.json': JSON.stringify({
                scripts: {dev: 'x', build: 'y', test: 'z', 'test:ct': 'w', lint: 'q', seed: 'r'}
            })
        })
        expect(candidates(root).map(c => [c.cmd, c.shape])).toEqual([
            ['bun run dev', 'boot'],
            ['bun run build', 'build'],
            ['bun run test', 'test'],
            ['bun run test:ct', 'test']
        ])
        expect(candidates(root)[0].provenance).toBe('package.json:scripts.dev')
    })

    test('lint and seed are not integration candidates', () => {
        const root = project({'package.json': JSON.stringify({scripts: {lint: 'x', seed: 'y'}})})
        expect(candidates(root)).toEqual([])
    })

    test('a marker file without its binary yields nothing (both halves required)', () => {
        const root = project({'project.godot': '[configuration]\nconfig_version=4\n'})
        const godot = Bun.which('godot')
        expect(candidates(root).length > 0).toBe(godot !== null)
    })

    test('no manifest and no marker yields no candidate at all', () => {
        expect(candidates(project({'README.md': 'hi'}))).toEqual([])
    })
})

describe('probe', () => {
    test('a terminating command that exits 0 is appendable', async () => {
        const root = project({'README.md': 'x'})
        const p = await probe(root, {cmd: 'true', provenance: 'test', shape: 'build'}, 5_000)
        expect(p.terminated).toBe(true)
        expect(p.exitCode).toBe(0)
        expect(isAppendable(p)).toBe(true)
    })

    test('a non-zero exit is NOT appendable — appending it would convert PASS into FAIL', async () => {
        const root = project({'README.md': 'x'})
        const p = await probe(root, {cmd: 'exit 3', provenance: 'test', shape: 'test'}, 5_000)
        expect(p.exitCode).toBe(3)
        expect(isAppendable(p)).toBe(false)
    })

    test('a command that does not terminate is NOT appendable', async () => {
        // This is the mx5 case: `bun run dev` is a watch-mode server, so it is the only
        // command on that stack matching the integration metric and it can never be
        // appended — a VERIFY block containing it hangs until the 15-minute watchdog.
        const root = project({'README.md': 'x'})
        const p = await probe(root, {cmd: 'sleep 30', provenance: 'test', shape: 'boot'}, 400)
        expect(p.terminated).toBe(false)
        expect(p.exitCode).toBe(null)
        expect(isAppendable(p)).toBe(false)
    })

    test('runs in the project directory it is given', async () => {
        const root = project({'marker.txt': 'x'})
        const p = await probe(root, {cmd: 'test -f marker.txt', provenance: 'test', shape: 'build'}, 5_000)
        expect(p.exitCode).toBe(0)
    })

    test('reports whether the command would move the published metric', async () => {
        const root = project({'README.md': 'x'})
        const yes = await probe(root, {cmd: 'true # localhost', provenance: 't', shape: 'boot'}, 5_000)
        const no = await probe(root, {cmd: 'true', provenance: 't', shape: 'boot'}, 5_000)
        expect(yes.matchesMetric).toBe(true)
        expect(no.matchesMetric).toBe(false)
    })
})
