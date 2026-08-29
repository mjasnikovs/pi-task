/**
 * launch-manifest tests — which manifest a launch contract may be diffed against.
 * The end-to-end proof (baseline reports 3 phantom misses, treatment goes inert,
 * real miss is byte-identical) is scripts/launch-contract-inert-ab.ts; these
 * pin the resolution rules the gate depends on.
 */
import {expect, test, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    readLaunchManifest,
    makeTargets,
    inertLaunchContractNote
} from '../../src/task/launch-manifest.js'

function tree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-manifest-'))
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
        fs.writeFileSync(path.join(dir, rel), body)
    }
    return dir
}

describe('readLaunchManifest', () => {
    test('npm: the scripts keys, unchanged', () => {
        const m = readLaunchManifest(
            tree({'package.json': JSON.stringify({scripts: {build: 'tsc', test: 'bun test'}})})
        )
        expect(m.kind).toBe('npm')
        expect(m.file).toBe('package.json')
        expect(m.names.sort()).toEqual(['build', 'test'])
    })

    test('npm with no scripts block is still npm — an empty manifest is checkable', () => {
        const m = readLaunchManifest(tree({'package.json': JSON.stringify({name: 'x'})}))
        expect(m.kind).toBe('npm')
        expect(m.names).toEqual([])
    })

    test('no manifest at all is INERT, not an empty npm manifest', () => {
        const m = readLaunchManifest(tree({'CMakeLists.txt': 'project(iar1)\n'}))
        expect(m.kind).toBe('none')
        expect(m.names).toEqual([])
        expect(m.why).toContain('no npm manifest')
    })

    test('an unparseable package.json is INERT — you cannot diff what you cannot read', () => {
        const m = readLaunchManifest(tree({'package.json': '{ "scripts": '}))
        expect(m.kind).toBe('none')
        expect(m.why).toContain('could not be parsed')
    })

    test('Makefile targets when there is no package.json', () => {
        const m = readLaunchManifest(tree({Makefile: 'build:\n\tcc -o a a.c\ntest:\n\t./a\n'}))
        expect(m.kind).toBe('make')
        expect(m.file).toBe('Makefile')
        expect(m.names).toEqual(['build', 'test'])
    })

    test('the named file is the one the DIRECTORY has, on any filesystem', () => {
        for (const spelling of ['Makefile', 'makefile', 'GNUmakefile']) {
            const dir = tree({[spelling]: 'build:\n\ttrue\n'})
            const m = readLaunchManifest(dir)
            expect(m.kind).toBe('make')
            expect(fs.readdirSync(dir)).toContain(m.file)
        }
    })

    test('package.json WINS over a Makefile — the npm diff is unchanged where it applied', () => {
        const m = readLaunchManifest(
            tree({
                'package.json': JSON.stringify({scripts: {build: 'tsc'}}),
                Makefile: 'migrate:\n\t./m\n'
            })
        )
        expect(m.kind).toBe('npm')
        expect(m.names).toEqual(['build'])
    })
})

describe('makeTargets', () => {
    test('several targets on one line', () => {
        expect(makeTargets('build test:\n\techo hi\n')).toEqual(['build', 'test'])
    })

    test('recipe lines are shell, never targets', () => {
        expect(makeTargets('build:\n\tssh host:/tmp/x .\n')).toEqual(['build'])
    })

    test('assignments are not targets', () => {
        expect(
            makeTargets('CC := gcc\nFLAGS ::= -O2\nOUT ?= a.out\nbuild:\n\t$(CC) x.c\n')
        ).toEqual(['build'])
    })

    test('pattern rules and dot-targets are skipped, prerequisites are not harvested', () => {
        // `.PHONY: publish` names a prerequisite, not a rule: `publish` is NOT a target
        // here, and claiming it were would turn a real miss into a false pass.
        expect(
            makeTargets('.PHONY: publish\n%.o: %.c\n\t$(CC) -c $<\nbuild: %.o\n\techo\n')
        ).toEqual(['build'])
    })

    test('comments and blank lines are inert', () => {
        expect(makeTargets('# build: not a target\n\nrun:\n\t./a\n')).toEqual(['run'])
    })
})

test('the inert note names the contract, the count and the reason', () => {
    const note = inertLaunchContractNote(['build', 'test', 'migrate'], {
        kind: 'none',
        file: '',
        names: [],
        why: 'it has no npm manifest and no Makefile'
    })
    expect(note).toContain('build, test, migrate')
    expect(note).toContain('no npm manifest and no Makefile')
    expect(note).toContain('NOT checked')
})
