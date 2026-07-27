/**
 * Unit tests for the STEP 0 rig behind the REFUTED "append an integration command to
 * the VERIFY block" lever (see the header of verify-integration-depth-step0.ts and the
 * record at the wiring site in src/task/phases.ts — the lever was NOT built).
 *
 * Kept because the classifier is the durable asset: it is the published metric for
 * "does this VERIFY block execute the integrated product", and the cases below are the
 * real shapes found on mx5 / IAR1 / godot-engine / runner on 2026-07-27.
 */
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, test} from 'bun:test'

import {
    INTEGRATION_RE,
    RUNTIME_CLAIM_RE,
    bootCommandsWithProvenance,
    classifyProject
} from './verify-integration-depth-step0.js'

const dirs: string[] = []
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true})
})

function project(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'integ-depth-'))
    dirs.push(root)
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel)
        mkdirSync(path.dirname(full), {recursive: true})
        writeFileSync(full, body)
    }
    return root
}

const spec = (accept: string, verify: string): string =>
    `---\nid: TASK_0001\n---\n\n## spec\n\nGOAL\n  do it\n\nCONSTRAINTS\n  - none\n\nACCEPTANCE\n${accept}\n\nVERIFY:\n\`\`\`sh\n${verify}\n\`\`\`\n\n## phase timings\n`

describe('INTEGRATION_RE (the published metric)', () => {
    test.each([
        'curl -sf http://localhost:3000/api/auth/me',
        'export PORT=3911',
        'PORT=3001 DATABASE_URL=postgres://localhost/test bun run dev &',
        'BASE="http://127.0.0.1:41234/api/admin"'
    ])('counts %p as integrated', cmd => expect(INTEGRATION_RE.test(cmd)).toBe(true))

    test.each([
        'tsc --noEmit',
        'bun run lint',
        'AGENT=1 bun test',
        'bun run build',
        'godot --headless --quit',
        'cmake --build build'
    ])('does not count %p', cmd => expect(INTEGRATION_RE.test(cmd)).toBe(false))
})

describe('RUNTIME_CLAIM_RE', () => {
    test('fires on ACCEPTANCE that claims behaviour only a running product has', () => {
        expect(RUNTIME_CLAIM_RE.test('- GET /api/listings returns 200 with a JSON body')).toBe(true)
        expect(RUNTIME_CLAIM_RE.test('- The login page renders and the user can submit')).toBe(true)
    })

    test('does not fire on a pure type/config/doc acceptance', () => {
        expect(RUNTIME_CLAIM_RE.test('- `tsc --noEmit` passes with no type errors')).toBe(false)
        expect(RUNTIME_CLAIM_RE.test('- The directories scenes/ and scripts/ exist')).toBe(false)
    })
})

describe('bootCommandsWithProvenance', () => {
    test('takes a dev/start/serve script from the manifest', () => {
        const root = project({'package.json': JSON.stringify({scripts: {dev: 'x', lint: 'y'}})})
        expect(bootCommandsWithProvenance(root).map(b => b.why)).toEqual(['package.json:scripts.dev'])
    })

    test('ignores non-boot scripts — lint/test/build are not integration', () => {
        const root = project({
            'package.json': JSON.stringify({scripts: {lint: 'x', test: 'y', build: 'z'}})
        })
        expect(bootCommandsWithProvenance(root)).toEqual([])
    })

    test('a marker file alone is not provenance without the binary that runs it', () => {
        // The godot/CMake arms require BOTH halves. `cmake` is absent on this box, so
        // a CMake tree yields nothing — which is exactly why IAR1 classifies as
        // "integration impossible here" rather than "available but unused".
        const root = project({'CMakeLists.txt': 'project(x)'})
        const why = bootCommandsWithProvenance(root).map(b => b.why)
        expect(why.some(w => w.startsWith('CMake'))).toBe(Bun.which('cmake') !== null)
    })

    test('unparseable manifest yields no provenance rather than throwing', () => {
        const root = project({'package.json': '{not json'})
        expect(bootCommandsWithProvenance(root)).toEqual([])
    })
})

describe('classifyProject', () => {
    test('a VERIFY block that curls the running app is integrated', () => {
        const root = project({
            'package.json': JSON.stringify({scripts: {dev: 'x'}}),
            '.pi-tasks/TASK_0001.md': spec(
                '  - GET /api/listings returns 200',
                'curl -sf http://localhost:3000/api/listings'
            )
        })
        expect(classifyProject(root)[0].klass).toBe('integrated')
    })

    test('runtime claim + available boot command + static-only VERIFY is the addressable class', () => {
        const root = project({
            'package.json': JSON.stringify({scripts: {dev: 'x'}}),
            '.pi-tasks/TASK_0001.md': spec('  - GET /api/listings returns 200', 'tsc --noEmit')
        })
        expect(classifyProject(root)[0].klass).toBe('ii-available-unused')
    })

    test('no runtime claim is class (i) — there is nothing to integrate against', () => {
        const root = project({
            'package.json': JSON.stringify({scripts: {dev: 'x'}}),
            '.pi-tasks/TASK_0001.md': spec('  - `tsc --noEmit` passes', 'tsc --noEmit')
        })
        expect(classifyProject(root)[0].klass).toBe('i-nothing-runnable')
    })

    test('no boot command with provenance is class (iii), regardless of the claim', () => {
        const root = project({
            '.pi-tasks/TASK_0001.md': spec('  - GET /api/listings returns 200', 'tsc --noEmit')
        })
        expect(classifyProject(root)[0].klass).toBe('iii-impossible')
    })

    test('a spec with no VERIFY block is skipped, not counted as non-integrated', () => {
        const root = project({'.pi-tasks/TASK_0001.md': '---\nid: TASK_0001\n---\n\nno spec here\n'})
        expect(classifyProject(root)).toEqual([])
    })

    test('reads the composed spec ACCEPTANCE, not an earlier refined-prompt one', () => {
        // The refined prompt carries its own ACCEPTANCE-shaped text; the composed spec
        // at the bottom is the one that governs. Taking the first match would classify
        // off superseded text.
        const root = project({
            'package.json': JSON.stringify({scripts: {dev: 'x'}}),
            '.pi-tasks/TASK_0001.md':
                '## refined prompt\n\nACCEPTANCE\n  - tsc --noEmit passes\n\n' +
                spec('  - POST /api/auth/login returns 200', 'tsc --noEmit')
        })
        expect(classifyProject(root)[0].klass).toBe('ii-available-unused')
    })

    test('missing .pi-tasks directory yields no rows', () => {
        expect(classifyProject(project({'package.json': '{}'}))).toEqual([])
    })
})
