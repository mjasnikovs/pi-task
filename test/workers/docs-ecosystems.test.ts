import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    ECOSYSTEMS,
    chooseEcosystem,
    detectEcosystems,
    npmProfile,
    type EcosystemIo,
    type EcosystemProfile
} from '../../src/workers/docs-ecosystems.js'
import {DECL_SPLIT_RE} from '../../src/workers/docs-chunk.js'
import type {ResolvedPackage} from '../../src/workers/docs-resolve.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import type {SpawnFn} from '../../src/shared/child-process.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

function io(spawn: SpawnFn): EcosystemIo {
    return {spawn}
}

const NEVER_SPAWN: SpawnFn = (() => {
    throw new Error('spawn must not run')
}) as unknown as SpawnFn

describe('the roster', () => {
    test('every row is keyed by its own id and says why it looks as it does', () => {
        for (const [key, profile] of Object.entries(ECOSYSTEMS) as [string, EcosystemProfile][]) {
            expect(profile.id).toBe(key as EcosystemProfile['id'])
            expect(profile.why.length).toBeGreaterThan(0)
            expect(profile.registryLabel.length).toBeGreaterThan(0)
            expect(profile.manifestLabel.length).toBeGreaterThan(0)
        }
    })

    test('every row implements the whole contract', () => {
        const required = [
            'detect',
            'isValidName',
            'parentPackage',
            'resolve',
            'declaredRange',
            'acquire',
            'latest',
            'isSurfaceFile',
            'surface'
        ] as const
        for (const profile of Object.values(ECOSYSTEMS) as EcosystemProfile[]) {
            for (const hook of required) {
                expect(typeof profile[hook]).toBe('function')
            }
            expect(profile.declSplitRe).toBeInstanceOf(RegExp)
            expect(profile.commentPrefix.length).toBeGreaterThan(0)
        }
    })
})

describe('the npm row', () => {
    const npm = ECOSYSTEMS.npm

    test('detects a package.json project and a bare node_modules directory', () => {
        // The fixture tree has node_modules and no package.json, and nine docs
        // tests use it as a cwd expecting npm behaviour.
        expect(fs.existsSync(path.join(FIXTURES, 'package.json'))).toBe(false)
        expect(npm.detect(FIXTURES)).toBe(true)

        const declaredOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-npm-'))
        fs.writeFileSync(path.join(declaredOnly, 'package.json'), '{}', 'utf8')
        expect(npm.detect(declaredOnly)).toBe(true)

        const neither = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-none-'))
        expect(npm.detect(neither)).toBe(false)

        fs.rmSync(declaredOnly, {recursive: true, force: true})
        fs.rmSync(neither, {recursive: true, force: true})
    })

    test('resolves an installed package and names its own ecosystem', () => {
        const pkg = npm.resolve('tiny-pkg', FIXTURES, io(NEVER_SPAWN))
        expect(pkg.ecosystem).toBe('npm')
        expect(pkg.name).toBe('tiny-pkg')
        expect(pkg.entry).not.toBeNull()
    })

    test('reads subpaths and scoped names as one installable package', () => {
        expect(npm.parentPackage('tiny-pkg/sub')).toBe('tiny-pkg')
        expect(npm.parentPackage('@scope/scoped-pkg/deep')).toBe('@scope/scoped-pkg')
        expect(npm.isValidName('tiny-pkg')).toBe(true)
        expect(npm.isValidName('../escape')).toBe(false)
    })

    test('the surface is the .d.ts files a package already ships, unmodified', () => {
        expect(npm.isSurfaceFile('index.d.ts')).toBe(true)
        expect(npm.isSurfaceFile('index.d.mts')).toBe(true)
        expect(npm.isSurfaceFile('index.ts')).toBe(false)
        const raw = 'export declare function greet(name: string): string\n'
        expect(npm.surface(raw)).toBe(raw)
        expect(npm.declSplitRe).toBe(DECL_SPLIT_RE)
        expect(npm.commentPrefix).toBe('//')
    })

    test('acquire runs npm install at the given range, with scripts off', async () => {
        const argv: string[][] = []
        const spawn = fakeSpawnByPrompt(args => {
            argv.push([...args])
            return {stdout: '', exitCode: 0}
        })
        const result = await npm.acquire('left-pad', '^1.3.0', io(spawn))
        expect(result.success).toBe(true)
        const install = argv.find(a => a.includes('install'))
        expect(install).toContain('left-pad@^1.3.0')
        expect(install).toContain('--ignore-scripts')
    })

    test('acquire with no range installs the bare name', async () => {
        const argv: string[][] = []
        const spawn = fakeSpawnByPrompt(args => {
            argv.push([...args])
            return {stdout: '', exitCode: 0}
        })
        await npm.acquire('left-pad', null, io(spawn))
        const install = argv.find(a => a.includes('install'))
        expect(install).toContain('left-pad')
        expect(install?.some(a => a.includes('@^'))).toBe(false)
    })
})

describe('a per-call row', () => {
    // docsRaw builds one of these so its `resolvePackage` and `npmVersionLookup`
    // hooks still reach the resolution they were injected for. The static row in
    // ECOSYSTEMS deliberately does not honour them — nothing injects into it.
    test('routes resolve and latest through the hooks it was built with', async () => {
        const seen: string[] = []
        const stub: ResolvedPackage = {
            ecosystem: 'npm',
            name: 'injected',
            version: '9.9.9',
            root: '/nowhere',
            entry: null,
            readme: null
        }
        const profile = npmProfile({
            resolvePackage: (name: string) => {
                seen.push(`resolve:${name}`)
                return stub
            },
            npmVersionLookup: async (name: string) => {
                seen.push(`latest:${name}`)
                return {pkg: name, latest: '9.9.9', recent: []}
            }
        })

        expect(profile.resolve('anything', '/tmp', io(NEVER_SPAWN))).toBe(stub)
        expect(await profile.latest('anything', io(NEVER_SPAWN))).toEqual({
            pkg: 'anything',
            latest: '9.9.9',
            recent: []
        })
        expect(seen).toEqual(['resolve:anything', 'latest:anything'])
    })
})

describe('choosing an ecosystem', () => {
    // A two-row roster the repo does not ship yet, so ambiguity and the local
    // tie-break are exercised rather than described.
    function fakeRow(id: string, manifest: string): EcosystemProfile {
        return {
            ...ECOSYSTEMS.npm,
            id: id as EcosystemProfile['id'],
            manifestLabel: manifest,
            detect: cwd => fs.existsSync(path.join(cwd, manifest))
        }
    }
    const ROSTER = [fakeRow('npm', 'package.json'), fakeRow('cargo', 'Cargo.toml')]

    function dirWith(...manifests: string[]): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-choose-'))
        for (const m of manifests) fs.writeFileSync(path.join(dir, m), '', 'utf8')
        return dir
    }

    test('detects in roster order', () => {
        const dir = dirWith('Cargo.toml', 'package.json')
        expect(detectEcosystems(dir, ROSTER)).toEqual(['npm', 'cargo'] as never)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('a lone manifest decides', () => {
        const dir = dirWith('Cargo.toml')
        const choice = chooseEcosystem({cwd: dir, roster: ROSTER})
        expect(choice.ok).toBe(true)
        if (choice.ok) expect(choice.profile.id).toBe('cargo' as never)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('no manifest refuses and names what it looked for', () => {
        const dir = dirWith()
        const choice = chooseEcosystem({cwd: dir, roster: ROSTER})
        expect(choice.ok).toBe(false)
        if (!choice.ok) {
            expect(choice.reason).toBe('none')
            expect(choice.message).toContain('package.json')
            expect(choice.message).toContain('Cargo.toml')
        }
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('a requested ecosystem the directory does not hold is refused', () => {
        const dir = dirWith('package.json')
        const choice = chooseEcosystem({cwd: dir, requested: 'cargo' as never, roster: ROSTER})
        expect(choice.ok).toBe(false)
        if (!choice.ok) {
            expect(choice.reason).toBe('not_detected')
            expect(choice.message).toContain('Cargo.toml')
        }
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('two manifests fall to whichever already has the package on disk', () => {
        const dir = dirWith('package.json', 'Cargo.toml')
        const choice = chooseEcosystem({
            cwd: dir,
            roster: ROSTER,
            resolvesLocally: p => p.id === ('cargo' as never)
        })
        expect(choice.ok).toBe(true)
        if (choice.ok) expect(choice.profile.id).toBe('cargo' as never)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('two manifests and no local copy is ambiguous, and says how to resolve it', () => {
        const dir = dirWith('package.json', 'Cargo.toml')
        const choice = chooseEcosystem({cwd: dir, roster: ROSTER, resolvesLocally: () => false})
        expect(choice.ok).toBe(false)
        if (!choice.ok) {
            expect(choice.reason).toBe('ambiguous')
            expect(choice.detected).toEqual(['npm', 'cargo'] as never)
            expect(choice.message).toContain('ecosystem:')
        }
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('a requested ecosystem the directory does hold wins over ambiguity', () => {
        const dir = dirWith('package.json', 'Cargo.toml')
        const choice = chooseEcosystem({cwd: dir, requested: 'npm', roster: ROSTER})
        expect(choice.ok).toBe(true)
        if (choice.ok) expect(choice.profile.id).toBe('npm')
        fs.rmSync(dir, {recursive: true, force: true})
    })
})
