import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    parsePlanJson,
    parseFreeze,
    parseStackLock,
    resolvedVersions,
    hackageVersion,
    hackageTarballUrl,
    findCabalTarball,
    cachedVersions,
    resolveHackage,
    hackageLatest,
    hackageProjectName,
    looksLikeModuleName,
    haskellSurface
} from '../../src/workers/eco-hackage.js'
import {ECOSYSTEMS, defaultEcosystemIo} from '../../src/workers/docs-ecosystems.js'
import {docsRaw} from '../../src/workers/docs-core.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {ResolveError} from '../../src/workers/docs-resolve.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')
const HS_PROJECT = path.join(FIXTURES, 'hs-project')
const HS_MODULES = path.join(FIXTURES, 'hs-modules')
const HS_PACKAGES = path.join(FIXTURES, 'hs-cabal-packages')
const TINY_ROOT = path.join(HS_MODULES, 'hackage', 'tiny-hs-0.1.0')

describe('what the build resolved', () => {
    test('plan.json, the freeze file and the stack lock each parse', () => {
        expect(
            parsePlanJson(
                fs.readFileSync(
                    path.join(HS_PROJECT, 'dist-newstyle', 'cache', 'plan.json'),
                    'utf8'
                )
            )
        ).toEqual({base: '4.20.0.0', 'tiny-hs': '0.1.0', 'hs-project': '0.1.0.0'})
        expect(
            parseFreeze(fs.readFileSync(path.join(HS_PROJECT, 'cabal.project.freeze'), 'utf8'))
        ).toEqual({base: '4.20.0.0', 'tiny-hs': '0.0.9', text: '2.1.3'})
        expect(
            parseStackLock(fs.readFileSync(path.join(HS_PROJECT, 'stack.yaml.lock'), 'utf8'))
        ).toEqual({'tiny-hs': '0.0.1'})
    })

    test('plan.json outranks the freeze file, which outranks the stack lock', () => {
        // All three name tiny-hs at a different version, so which one answered is
        // visible rather than inferred.
        expect(hackageVersion('tiny-hs', HS_PROJECT)).toBe('0.1.0')
        expect(resolvedVersions(os.tmpdir())).toBeUndefined()
    })

    test('reads the project name out of its .cabal file', () => {
        expect(hackageProjectName(HS_PROJECT)).toBe('hs-project')
        expect(hackageProjectName(os.tmpdir())).toBeNull()
    })
})

describe('a module name is not a package name', () => {
    test('a dotted name is refused with the correction in the message', () => {
        expect(looksLikeModuleName('Data.Aeson')).toBe(true)
        expect(looksLikeModuleName('aeson')).toBe(false)
        try {
            resolveHackage('Data.Aeson', HS_PROJECT, {modulesDir: HS_MODULES})
            expect.unreachable()
        } catch (err) {
            expect(err).toBeInstanceOf(ResolveError)
            expect((err as ResolveError).kind).toBe('invalid_name')
            expect((err as ResolveError).message).toContain('aeson')
        }
    })
})

describe('finding an unpacked package', () => {
    test('resolves the version the build resolved', () => {
        const pkg = resolveHackage('tiny-hs', HS_PROJECT, {modulesDir: HS_MODULES})
        expect(pkg.ecosystem).toBe('hackage')
        expect(pkg.name).toBe('tiny-hs')
        expect(pkg.version).toBe('0.1.0')
        expect(pkg.root).toBe(TINY_ROOT)
        expect(pkg.entry).toBe(path.join(TINY_ROOT, 'src', 'Tiny', 'Hs.hs'))
        expect(pkg.readme).toBe(path.join(TINY_ROOT, 'README.md'))
    })

    test('a package nothing has unpacked is not_installed', () => {
        try {
            resolveHackage('aeson', HS_PROJECT, {modulesDir: HS_MODULES})
            expect.unreachable()
        } catch (err) {
            expect((err as ResolveError).kind).toBe('not_installed')
        }
    })
})

describe("cabal's own tarball cache", () => {
    test('finds a downloaded tarball and lists what versions are held', () => {
        expect(findCabalTarball('tiny-hs', '0.1.0', [HS_PACKAGES])).toBe(
            path.join(
                HS_PACKAGES,
                'hackage.haskell.org',
                'tiny-hs',
                '0.1.0',
                'tiny-hs-0.1.0.tar.gz'
            )
        )
        expect(findCabalTarball('tiny-hs', '9.9.9', [HS_PACKAGES])).toBeNull()
        expect(cachedVersions('tiny-hs', [HS_PACKAGES])).toEqual(['0.1.0'])
        expect(cachedVersions('aeson', [HS_PACKAGES])).toEqual([])
    })

    test('acquire unpacks the cached tarball instead of asking Hackage', async () => {
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-hs-'))
        const argv: string[][] = []
        const io = defaultEcosystemIo({
            modulesDir,
            cabalPackageDirs: [HS_PACKAGES],
            fetch: (() => {
                throw new Error('Hackage must not be asked for a tarball cabal already holds')
            }) as unknown as typeof fetch,
            spawn: fakeSpawnByPrompt(args => {
                argv.push([...args])
                // Stands in for the extraction, so no real tar has to run.
                fs.cpSync(TINY_ROOT, path.join(modulesDir, 'hackage', 'tiny-hs-0.1.0'), {
                    recursive: true
                })
                return {stdout: '', exitCode: 0}
            })
        })

        const result = await ECOSYSTEMS.hackage.acquire('tiny-hs', '0.1.0', io)
        expect(result.success).toBe(true)
        const tar = argv.find(a => a.includes('-xzf'))
        expect(tar!.some(a => a.endsWith('tiny-hs-0.1.0.tar.gz'))).toBe(true)
        expect(tar!.some(a => a.startsWith(HS_PACKAGES))).toBe(true)

        expect(resolveHackage('tiny-hs', modulesDir, {modulesDir}).version).toBe('0.1.0')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('a package cabal has never fetched is downloaded from Hackage', async () => {
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-hs-dl-'))
        let requested = ''
        const io = defaultEcosystemIo({
            modulesDir,
            cabalPackageDirs: [path.join(os.tmpdir(), 'no-cabal-here')],
            fetch: (async (url: string) => {
                requested = url
                return {ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer}
            }) as unknown as typeof fetch,
            spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0}))
        })

        const result = await ECOSYSTEMS.hackage.acquire('tiny-hs', '0.1.0', io)
        expect(result.success).toBe(true)
        expect(requested).toBe(hackageTarballUrl('tiny-hs', '0.1.0'))
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })
})

describe('the surface', () => {
    const src = fs.readFileSync(path.join(TINY_ROOT, 'src', 'Tiny', 'Hs.hs'), 'utf8')
    const out = haskellSurface(src)

    test('keeps the export list, every signature and every type declaration', () => {
        expect(out).toContain('module Tiny.Hs')
        expect(out).toContain(', Greeting(..)')
        expect(out).toContain(') where')
        expect(out).toContain('greet :: String -> Volume -> String')
        expect(out).toContain('data Volume')
        expect(out).toContain('| Loud')
        expect(out).toContain('{ greetingName   :: String')
        expect(out).toContain('-- | Build a greeting for a name.')
    })

    test('a signature whose :: wrapped onto the next line survives, haddock and all', () => {
        // How most multi-constraint signatures are written. Matching only the head
        // line drops the whole declaration and its docs with it.
        const wrapped = haskellSurface(
            'module M (decode) where\n\n-- | Decode a value.\ndecode\n'
                + '  :: FromJSON a\n  => ByteString\n  -> Maybe a\ndecode = undefined\n'
        )
        expect(wrapped).toContain('-- | Decode a value.')
        expect(wrapped).toContain('decode')
        expect(wrapped).toContain(':: FromJSON a')
        expect(wrapped).toContain('-> Maybe a')
        expect(wrapped).not.toContain('undefined')
    })

    test('a bare name followed by an equation is still dropped', () => {
        const equation = haskellSurface('module M (x) where\n\nfoo\n  = 1 + 2\n')
        expect(equation).not.toContain('1 + 2')
    })

    test('code inside a block comment is NOT resurrected as API', () => {
        // The worst answer this tool can give: a plausible signature for a
        // function that does not exist. `vector` ships `thawMany` commented out,
        // and it surfaced between two real functions, indistinguishable.
        const out2 = haskellSurface(
            'module M where\n\n{-\nfoo :: Int -> Int\nfoo = id\n-}\n\nbar :: Int\nbar = 1\n'
        )
        expect(out2).toContain('bar :: Int')
        expect(out2).not.toContain('foo')

        // Nested blocks close in the right order.
        const nested = haskellSurface(
            'module M where\n{- outer {- inner -} still comment\nghost :: Int\n-}\nreal :: Int\nreal = 1\n'
        )
        expect(nested).toContain('real :: Int')
        expect(nested).not.toContain('ghost')
    })

    test('block haddock is kept — it is how a module documents itself', () => {
        const out2 = haskellSurface(
            'module M where\n\n{-| Decode a value.\n\n  More docs.\n-}\n'
                + 'decode :: ByteString -> Maybe a\ndecode = undefined\n'
        )
        expect(out2).toContain('Decode a value.')
        expect(out2).toContain('More docs.')
        expect(out2).toContain('decode :: ByteString -> Maybe a')
    })

    test('a LANGUAGE pragma is not mistaken for a comment open', () => {
        const out2 = haskellSurface('{-# LANGUAGE GADTs #-}\nmodule M where\nx :: Int\nx = 1\n')
        expect(out2).toContain('x :: Int')
    })

    test('drops equations, instance bodies, imports and pragmas', () => {
        expect(out).not.toContain('let body')
        expect(out).not.toContain('Quiet -> body')
        expect(out).not.toContain('intercalate ", "')
        expect(out).not.toContain('import Data.List')
        expect(out).not.toContain('LANGUAGE')
        // The instance HEAD stays — it is part of the API — its body does not.
        expect(out).toContain('instance Show Greeting where')
        expect(out).not.toContain('show g =')
        expect(out.length).toBeLessThan(src.length)
    })
})

describe('the Hackage version lookup', () => {
    const BODY = {
        'normal-version': ['2.3.1.0', '2.3.0.0', '2.2.5.1'],
        'deprecated-version': ['0.10.0.0']
    }

    test('reports the newest version Hackage does NOT deprecate', async () => {
        let seen = ''
        const fakeFetch = (async (url: string) => {
            seen = url
            return {ok: true, status: 200, json: async () => BODY}
        }) as unknown as typeof fetch
        expect(await hackageLatest('aeson', fakeFetch)).toEqual({
            pkg: 'aeson',
            latest: '2.3.1.0',
            recent: ['2.3.1.0', '2.3.0.0', '2.2.5.1']
        })
        expect(seen).toBe('https://hackage.haskell.org/package/aeson/preferred')
    })

    test('a module name is never sent to the registry', async () => {
        const explode = (() => {
            throw new Error('must not fetch')
        }) as unknown as typeof fetch
        expect(await hackageLatest('Data.Aeson', explode)).toBeNull()
    })
})

describe('end to end', () => {
    test('a cabal project answers from unpacked Haskell source', async () => {
        const cache = openCache(':memory:')
        try {
            const result = await docsRaw({
                pkg: 'tiny-hs',
                query: 'greet a name',
                cwd: HS_PROJECT,
                openCache: () => cache,
                io: {modulesDir: HS_MODULES, cabalPackageDirs: [HS_PACKAGES]},
                npmVersionLookup: async () => {
                    throw new Error('npm must not be asked about a Hackage package')
                }
            })
            expect(result.kind).toBe('ok')
            if (result.kind !== 'ok') return
            expect(result.pkg.ecosystem).toBe('hackage')
            expect(result.pkg.version).toBe('0.1.0')
            expect(result.registryLabel).toBe('hackage')
            expect(result.chunks.some(c => c.content.includes('greet ::'))).toBe(true)
        } finally {
            cache.close()
        }
    })

    test('a dotted module name is refused before any registry or spawn', async () => {
        // The fixture sits inside this npm repo, so detection legitimately finds
        // package.json above it too; `ecosystem` is what settles a polyglot tree.
        let spawns = 0
        const result = await docsRaw({
            pkg: 'Data.Aeson',
            query: 'decode',
            cwd: HS_PROJECT,
            ecosystem: 'hackage',
            io: {modulesDir: HS_MODULES, cabalPackageDirs: [HS_PACKAGES]},
            spawn: fakeSpawnByPrompt(() => {
                spawns++
                return {stdout: '', exitCode: 0}
            }),
            npmVersionLookup: async () => null
        })
        expect(result.kind).toBe('error')
        if (result.kind === 'error') {
            expect(result.resolveError).toBe('invalid_name')
            expect(result.message).toContain('MODULE name')
        }
        expect(spawns).toBe(0)
    })

    test('an unnamed dotted module name is still refused, and installs nothing', async () => {
        // Without `ecosystem` the tree is npm + hackage and the name is in neither,
        // so this comes back ambiguous rather than as the module-name correction.
        // What must not happen either way is an npm install of "Data.Aeson" — npm
        // would take that name, which is the whole class of bug being closed.
        let spawns = 0
        const result = await docsRaw({
            pkg: 'Data.Aeson',
            query: 'decode',
            cwd: HS_PROJECT,
            io: {modulesDir: HS_MODULES, cabalPackageDirs: [HS_PACKAGES]},
            spawn: fakeSpawnByPrompt(() => {
                spawns++
                return {stdout: '', exitCode: 0}
            }),
            npmVersionLookup: async () => null
        })
        expect(result.kind).toBe('error')
        if (result.kind === 'error') expect(result.resolveError).toBe('ambiguous_ecosystem')
        expect(spawns).toBe(0)
    })
})
