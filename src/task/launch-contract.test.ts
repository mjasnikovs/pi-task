/**
 * launch-contract tests — the declared-script extraction (parse + grounding) and the
 * deterministic manifest diff the final gate FAILs on (mx5 run 10 item 4). Parse and
 * grounding are pure; record/read run against a real throwaway .pi-tasks dir.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    appendDeclaredScripts,
    keepGroundedScripts,
    launchContractFile,
    missingDeclaredScripts,
    parseScriptLines,
    readDeclaredScripts
} from './launch-contract.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-launch-contract-'))
}

// The verbatim mx5 DESIGN §9 line that declares the required scripts.
const MX5_SCRIPTS_LINE = '- **Scripts:** `dev`, `build`, `migrate`, `seed`, `test`.'

describe('parseScriptLines', () => {
    test('extracts bare names, stripping backticks and trailing tokens', () => {
        expect(
            parseScriptLines('SCRIPT: dev\nSCRIPT: `migrate`\nSCRIPT: seed  # admin seeding\nnoise')
        ).toEqual(['dev', 'migrate', 'seed'])
    })

    test('rejects a non-script-shaped token (a sentence/path)', () => {
        expect(parseScriptLines('SCRIPT: run the migrations\nSCRIPT: src/server/seed.ts')).toEqual([
            // "run" is the first token of the sentence (script-shaped) — kept;
            // "src/server/seed.ts" has slashes/dots → rejected.
            'run'
        ])
    })
})

describe('keepGroundedScripts (the anti-fabrication guard)', () => {
    test('keeps only names the design backticks', () => {
        // `deploy` is NOT backticked in the design → dropped (a hallucinated script).
        expect(keepGroundedScripts(['dev', 'migrate', 'seed', 'deploy'], MX5_SCRIPTS_LINE)).toEqual(
            ['dev', 'migrate', 'seed']
        )
    })

    test('a design that never backticks a script name grounds nothing', () => {
        expect(keepGroundedScripts(['dev', 'build'], 'Scripts: dev, build, test.')).toEqual([])
    })

    test('dedups case-insensitively', () => {
        expect(keepGroundedScripts(['seed', 'SEED'], MX5_SCRIPTS_LINE)).toEqual(['seed'])
    })
})

describe('missingDeclaredScripts (the deterministic diff lever)', () => {
    test('flags declared scripts the manifest is missing — the real mx5 case', () => {
        const declared = ['dev', 'build', 'migrate', 'seed', 'test']
        const shipped = ['dev', 'build', 'lint', 'test', 'test:ct'] // the run-10 package.json
        expect(missingDeclaredScripts(declared, shipped)).toEqual(['migrate', 'seed'])
    })

    test('a healthy manifest that has every declared script → no flags', () => {
        const declared = ['dev', 'build', 'migrate', 'seed', 'test']
        const shipped = ['dev', 'build', 'migrate', 'seed', 'test', 'lint']
        expect(missingDeclaredScripts(declared, shipped)).toEqual([])
    })

    test('nothing declared → nothing flagged (no check)', () => {
        expect(missingDeclaredScripts([], ['dev'])).toEqual([])
    })
})

describe('appendDeclaredScripts / readDeclaredScripts', () => {
    test('round-trips a durable list under .pi-tasks/', async () => {
        const cwd = makeCwd()
        await appendDeclaredScripts(cwd, ['dev', 'build', 'migrate', 'seed', 'test'])
        expect(fs.existsSync(launchContractFile(cwd))).toBe(true)
        expect(await readDeclaredScripts(cwd)).toEqual(['dev', 'build', 'migrate', 'seed', 'test'])
    })

    test('appends without duplicating', async () => {
        const cwd = makeCwd()
        await appendDeclaredScripts(cwd, ['dev', 'build'])
        await appendDeclaredScripts(cwd, ['build', 'migrate'])
        expect(await readDeclaredScripts(cwd)).toEqual(['dev', 'build', 'migrate'])
    })

    test('reading a cwd with no artifact → empty list', async () => {
        expect(await readDeclaredScripts(makeCwd())).toEqual([])
    })
})
