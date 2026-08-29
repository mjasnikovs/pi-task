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
    enumerateScriptCandidates,
    keepGroundedScripts,
    LAUNCH_EXTRACT_PROMPT,
    launchContractFile,
    missingDeclaredScripts,
    parseScriptLines,
    readDeclaredScripts,
    runnableDeclaredScripts
} from './launch-contract.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-launch-contract-'))
}

// The verbatim mx5 DESIGN §9 line that declares the required scripts.
const SCRIPTS_LINE = '- **Scripts:** `dev`, `build`, `migrate`, `seed`, `test`.'

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
        expect(keepGroundedScripts(['dev', 'migrate', 'seed', 'deploy'], SCRIPTS_LINE)).toEqual([
            'dev',
            'migrate',
            'seed'
        ])
    })

    test('a design that never backticks a script name grounds nothing', () => {
        expect(keepGroundedScripts(['dev', 'build'], 'Scripts: dev, build, test.')).toEqual([])
    })

    test('dedups case-insensitively', () => {
        expect(keepGroundedScripts(['seed', 'SEED'], SCRIPTS_LINE)).toEqual(['seed'])
    })
})

describe('enumerateScriptCandidates (the mechanical recall floor — mx5 run 11)', () => {
    const projectSpec = fs.readFileSync(
        path.join(import.meta.dir, '__fixtures__', 'project-spec.md'),
        'utf8'
    )

    test('the real run-11 doc yields every declared script, including the §2-only test:ct', () => {
        const candidates = enumerateScriptCandidates(projectSpec)
        for (const name of ['dev', 'build', 'migrate', 'seed', 'test', 'lint', 'test:ct']) {
            expect(candidates).toContain(name)
        }
    })

    test('package names never enter the checklist (their paragraphs do not say "script")', () => {
        const candidates = enumerateScriptCandidates(projectSpec)
        for (const pkg of ['hono', 'zod', 'sharp', 'react', 'wouter']) {
            expect(candidates).not.toContain(pkg)
        }
    })

    test('"TypeScript"/"JavaScript" do not satisfy the word-bounded paragraph gate', () => {
        expect(enumerateScriptCandidates('TypeScript `6.0.3` uses `strict` mode.')).toEqual([])
    })

    test('a paragraph that declares scripts yields its backticked simple tokens only', () => {
        const doc =
            'Scripts: `dev`, `build`, and `run the app` (see `src/index.ts`).\n\n'
            + 'Dependencies: `express`, `pino`.'
        // multi-word + path tokens rejected; the dependency paragraph is gated out
        expect(enumerateScriptCandidates(doc)).toEqual(['dev', 'build'])
    })

    test('dedups case-insensitively across paragraphs', () => {
        const doc = 'The `seed` script.\n\nRun the `SEED` script again.'
        expect(enumerateScriptCandidates(doc)).toEqual(['seed'])
    })

    test('no doc / no backticks / no "script" word ⇒ no candidates', () => {
        expect(enumerateScriptCandidates('')).toEqual([])
        expect(enumerateScriptCandidates('Add rate limiting to the login endpoint.')).toEqual([])
        expect(enumerateScriptCandidates('The `migrate` step runs first.')).toEqual([])
    })

    test('CRLF line endings parse identically to LF (windows-latest checkout)', () => {
        // A Windows-authored design has \r\n between paragraphs; the paragraph
        // gate must still split it (regression: windows CI collapsed the whole
        // doc into one paragraph and capped out on early package backticks).
        const lf = 'Scripts: `dev`, `build`.\n\nDependencies: `hono`, `zod`.'
        const crlf = lf.replace(/\n/g, '\r\n')
        expect(enumerateScriptCandidates(crlf)).toEqual(enumerateScriptCandidates(lf))
        expect(enumerateScriptCandidates(crlf)).toEqual(['dev', 'build'])
    })
})

describe('LAUNCH_EXTRACT_PROMPT candidates block', () => {
    test('candidates render as an explicit floor-not-ceiling checklist', () => {
        const p = LAUNCH_EXTRACT_PROMPT('design text', ['dev', 'test:ct'])
        expect(p).toContain('CANDIDATE TOKENS')
        expect(p).toContain('  - dev')
        expect(p).toContain('  - test:ct')
        expect(p).toContain('a floor, not a ceiling')
    })

    test('no candidates ⇒ byte-identical to the pre-checklist prompt', () => {
        const p = LAUNCH_EXTRACT_PROMPT('design text')
        expect(p).not.toContain('CANDIDATE TOKENS')
        expect(p).toBe(LAUNCH_EXTRACT_PROMPT('design text', []))
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

describe('runnableDeclaredScripts (mx5 run 11 — existence is not launchability)', () => {
    test('run-11 contract: boot-class and covered scripts drop, migrate/seed remain', () => {
        expect(
            runnableDeclaredScripts(['dev', 'build', 'migrate', 'seed', 'test'], ['test', 'build'])
        ).toEqual(['migrate', 'seed'])
    })

    test('boot-class shapes with suffixes are excluded; declared order is kept', () => {
        expect(
            runnableDeclaredScripts(
                ['seed', 'dev:client', 'start-prod', 'watch:css', 'preview', 'migrate'],
                []
            )
        ).toEqual(['seed', 'migrate'])
    })

    test('coverage match is case-insensitive; empty declared → nothing to run', () => {
        expect(runnableDeclaredScripts(['Migrate'], ['migrate'])).toEqual([])
        expect(runnableDeclaredScripts([], ['test'])).toEqual([])
    })
})
