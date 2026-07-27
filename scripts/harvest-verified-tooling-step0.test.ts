/**
 * Unit tests for the STEP 0 rig behind the REFUTED `## verified tooling` harvest lever
 * (see the header of harvest-verified-tooling-step0.ts — the lever was NOT built).
 *
 * These are kept because the parser is the durable asset: if anyone re-attacks the harvest
 * idea, or wants to measure `## verified tooling` for any other purpose, this is the extractor,
 * and the cases below are the real shapes found on IAR1 / mx5 / godot-engine on 2026-07-27.
 */
import {describe, expect, test} from 'bun:test'
import {
    SHELL_META_RE,
    classifyShape,
    parseVerifiedTooling,
    tokenize
} from './harvest-verified-tooling-step0.js'

const spec = (body: string): string =>
    `# TASK_0007\n\n## goal\n\nship it\n\n## verified tooling\n\n${body}\n\n## research\n\nFILES\nx  y\n`

describe('parseVerifiedTooling', () => {
    test('reads one command per line and stops at the next heading', () => {
        expect(parseVerifiedTooling(spec('bun run lint\ntsc --noEmit\nbun run dev'))).toEqual([
            'bun run lint',
            'tsc --noEmit',
            'bun run dev'
        ])
    })

    test('strips list bullets and backtick fencing', () => {
        expect(parseVerifiedTooling(spec('- `ctest --output-on-failure`\n* bun test'))).toEqual([
            'ctest --output-on-failure',
            'bun test'
        ])
    })

    test('the "nothing was verified" placeholders yield no commands', () => {
        // All three observed live: IAR1 4/10 sections, godot-engine 8/20, runner 1/2.
        expect(parseVerifiedTooling(spec('(none verified)'))).toEqual([])
        expect(parseVerifiedTooling(spec('none'))).toEqual([])
        expect(parseVerifiedTooling(spec('(verification inconclusive)'))).toEqual([])
    })

    test('absent section is empty, not a throw', () => {
        expect(parseVerifiedTooling('# TASK_0001\n\n## goal\n\nship it\n')).toEqual([])
    })

    test('reads the section at EOF (no trailing heading)', () => {
        expect(parseVerifiedTooling('## verified tooling\n\ngodot --headless --import\n')).toEqual([
            'godot --headless --import'
        ])
    })
})

describe('tokenize — harvested lines are untrusted model output', () => {
    test('a plain command splits into bin + args', () => {
        expect(tokenize('godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test')).toEqual({
            bin: 'godot',
            args: ['--headless', '-s', 'addons/gut/gut_cmdln.gd', '-gdir=res://test']
        })
    })

    test.each([
        ['cmake --preset default && cmake --build --preset default', 'chained with &&'],
        ['cmake --preset <preset> && cmake --build --preset <preset>', 'unfilled placeholder'],
        ["prettier --write 'src/**/*.ts'", 'quotes and a glob'],
        ['bun test | tee out.log', 'a pipe'],
        ['bun test > out.log', 'a redirect'],
        ['(verification inconclusive)', 'prose in parentheses']
    ])('rejects %p (%s) rather than parsing it', line => {
        expect(SHELL_META_RE.test(line)).toBe(true)
        expect(tokenize(line)).toBeNull()
    })

    test('rejects an env-prefixed command — runGateCommand has no env channel to carry it', () => {
        expect(tokenize('AGENT=1 bun test')).toBeNull()
    })

    test('rejects an empty line', () => {
        expect(tokenize('   ')).toBeNull()
    })
})

describe('classifyShape', () => {
    test.each([
        'godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test -gexit',
        'ctest --output-on-failure',
        'bun test',
        'bun run build'
    ])('%p is execution-shaped', line => {
        expect(classifyShape(line)).toBe('execution')
    })

    test.each([
        'godot --headless --check-only',
        'gdlint scripts/ autoload/ tools/',
        'tsc --noEmit',
        'bunx eslint .'
    ])('%p is static-shaped', line => {
        expect(classifyShape(line)).toBe('static')
    })
})
