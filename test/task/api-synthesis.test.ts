import {describe, expect, test} from 'bun:test'
import {
    extractApiIdentifiers,
    findSynthesizedApis,
    synthesizedApiReaskHint
} from '../../src/task/api-synthesis.js'

/** A research block in the shape the research prompt asks for: FILES carries
 *  paths, APIS carries bare symbol NAMES and never a path, CONTEXT carries prose
 *  (RESEARCH_APIS_PROMPT in task/prompts.ts states that split). The synthesis
 *  check searches all three, so the fixture has to honour it. */
const RESEARCH = [
    'FILES',
    'build.ts  Build script to be created at project root',
    'package.json  Scripts and dependency listing',
    '',
    'APIS',
    'Bun.build  Bundler API — `await Bun.build({entrypoints, outdir})` returns a BuildOutput',
    'Bun.spawn  Subprocess API — `Bun.spawn(["cmd"], {cwd})` for running the build',
    '',
    'CONTEXT',
    '- The project uses `"type": "module"`.'
].join('\n')

describe('extractApiIdentifiers', () => {
    test('extracts Namespace.member identifiers', () => {
        expect(
            extractApiIdentifiers('use Bun.mkdirSync with { recursive: true } then Bun.build')
        ).toEqual(['Bun.mkdirSync', 'Bun.build'])
    })

    test('ignores file names, domains, and prose dots', () => {
        expect(
            extractApiIdentifiers(
                'Node.js reads App.tsx and README.md from Fly.io; see U.S. spec. Also INDEX.HTML.'
            )
        ).toEqual([])
    })

    test('keeps uppercase members (React.StrictMode is API-shaped)', () => {
        expect(extractApiIdentifiers('wrap in React.StrictMode')).toEqual(['React.StrictMode'])
    })

    test('dedupes repeated mentions', () => {
        expect(extractApiIdentifiers('Bun.build then Bun.build again')).toEqual(['Bun.build'])
    })
})

describe('findSynthesizedApis', () => {
    test('fires on the real run-13 hallucination: Bun.mkdirSync absent from a Bun.-covering research', () => {
        const findings = findSynthesizedApis(
            'create dist/ using Bun.mkdirSync with { recursive: true }',
            'should build.ts create dist/ if it does not exist?',
            RESEARCH
        )
        expect(findings).toHaveLength(1)
        expect(findings[0]).toEqual({identifier: 'Bun.mkdirSync', namespace: 'Bun'})
    })

    test('does not fire when the identifier is in the research', () => {
        expect(
            findSynthesizedApis('bundle with Bun.build into dist/', 'how to bundle?', RESEARCH)
        ).toEqual([])
    })

    test('does not fire when the identifier is in the question itself', () => {
        expect(
            findSynthesizedApis(
                'yes, use Bun.write for the output',
                'should we use Bun.write or a stream?',
                RESEARCH
            )
        ).toEqual([])
    })

    test('steps aside when research never covers the namespace (inconclusive)', () => {
        expect(
            findSynthesizedApis(
                'wrap the app in React.StrictMode',
                'should the root be wrapped?',
                RESEARCH
            )
        ).toEqual([])
    })

    test('inert on a stub research (clarify-triage seam)', () => {
        expect(
            findSynthesizedApis(
                'use Bun.mkdirSync',
                'create dist?',
                '(none — clarify runs before decomposition; each task researches itself later)'
            )
        ).toEqual([])
    })
})

describe('synthesizedApiReaskHint', () => {
    test('names the flagged identifier and injects the verified research lines', () => {
        const findings = findSynthesizedApis('use Bun.mkdirSync', 'create dist?', RESEARCH)
        const hint = synthesizedApiReaskHint(findings, RESEARCH)
        expect(hint).toContain('`Bun.mkdirSync`')
        expect(hint).toContain('Bun.build')
        expect(hint).toContain('Bun.spawn')
        expect(hint).toContain('tag UNKNOWN')
    })
})
