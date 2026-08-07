import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    docsRaw,
    docsFocused,
    findDeclaredRange,
    findDeclaration,
    declarationChain,
    buildVersionBanner
} from './docs-core.js'
import {resolvePackage as realResolvePackage, ResolveError} from './docs-resolve.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {openCache} from './docs-cache.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

/** Make a throwaway project dir whose package.json has the given dep maps. */
function makeProjectDir(pkgJson: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-pin-'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkgJson), 'utf8')
    return dir
}

describe('docsRaw', () => {
    test('returns kind: ok with chunks on a known-good package', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('ok')
        cache.close()
    })

    test('returns kind: error with resolveError invalid_name on bad name', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: '../etc/passwd',
            query: 'x',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('error')
        if (r.kind === 'error') expect(r.resolveError).toBe('invalid_name')
        cache.close()
    })

    test('normalizes a bun: runtime namespace to resolve the runtime, not the colon-name', async () => {
        const cache = openCache(':memory:')
        const seen: string[] = []
        const r = await docsRaw({
            pkg: 'bun:sql',
            query: 'sql',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            // tiny-pkg ships its own types, so resolveTypeSource follows no redirect
            // and the only resolve target recorded is the normalized runtime name.
            resolvePackage: (name, cwd) => {
                seen.push(name)
                return realResolvePackage('tiny-pkg', cwd)
            }
        })
        expect(r.kind).toBe('ok')
        expect(seen).toContain('bun')
        expect(seen).not.toContain('bun:sql')
        cache.close()
    })

    test('returns kind: no_chunks for empty-pkg', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: 'empty-pkg',
            query: 'x',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('no_chunks')
        cache.close()
    })
})

describe('findDeclaredRange', () => {
    test('returns the range declared in dependencies', () => {
        const dir = makeProjectDir({dependencies: {'left-pad': '^1.0.0'}})
        expect(findDeclaredRange('left-pad', dir)).toBe('^1.0.0')
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('finds devDependencies / peerDependencies / optionalDependencies', () => {
        const dev = makeProjectDir({devDependencies: {'a-pkg': '~2.3.0'}})
        const peer = makeProjectDir({peerDependencies: {'a-pkg': '3.x'}})
        const opt = makeProjectDir({optionalDependencies: {'a-pkg': '>=4 <5'}})
        expect(findDeclaredRange('a-pkg', dev)).toBe('~2.3.0')
        expect(findDeclaredRange('a-pkg', peer)).toBe('3.x')
        expect(findDeclaredRange('a-pkg', opt)).toBe('>=4 <5')
        for (const d of [dev, peer, opt]) fs.rmSync(d, {recursive: true, force: true})
    })

    test('returns null for undeclared dep, wildcard, and non-registry protocol', () => {
        const none = makeProjectDir({dependencies: {other: '^1'}})
        const star = makeProjectDir({dependencies: {'a-pkg': '*'}})
        const workspace = makeProjectDir({dependencies: {'a-pkg': 'workspace:*'}})
        const file = makeProjectDir({dependencies: {'a-pkg': 'file:../a-pkg'}})
        expect(findDeclaredRange('a-pkg', none)).toBeNull()
        expect(findDeclaredRange('a-pkg', star)).toBeNull()
        expect(findDeclaredRange('a-pkg', workspace)).toBeNull()
        expect(findDeclaredRange('a-pkg', file)).toBeNull()
        for (const d of [none, star, workspace, file]) fs.rmSync(d, {recursive: true, force: true})
    })

    test('returns null when package.json is missing or unreadable', () => {
        expect(findDeclaredRange('a-pkg', path.join(os.tmpdir(), 'does-not-exist-xyz'))).toBeNull()
    })
})

describe('declarationChain', () => {
    test('asked, its @types package, then the terminal — deduped', () => {
        expect(declarationChain('bun', 'bun-types')).toEqual(['bun', '@types/bun', 'bun-types'])
        expect(declarationChain('@radix-ui/react-dialog')).toEqual([
            '@radix-ui/react-dialog',
            '@types/radix-ui__react-dialog'
        ])
        expect(declarationChain('@types/bun', '@types/bun')).toEqual(['@types/bun'])
    })
})

describe('findDeclaration', () => {
    test('a usable declaration anywhere on the chain beats an unusable earlier one', () => {
        const dir = makeProjectDir({
            dependencies: {'a-pkg': 'latest'},
            devDependencies: {'@types/a-pkg': '^2.0.0'}
        })
        expect(findDeclaration(['a-pkg', '@types/a-pkg'], dir)).toEqual({
            pkg: '@types/a-pkg',
            value: '^2.0.0',
            usable: true
        })
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('reports an unpinned declaration when the chain has nothing usable', () => {
        const dir = makeProjectDir({devDependencies: {'@types/bun': 'latest'}})
        expect(findDeclaration(['bun', '@types/bun', 'bun-types'], dir)).toEqual({
            pkg: '@types/bun',
            value: 'latest',
            usable: false
        })
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('null when no name on the chain appears at all', () => {
        const dir = makeProjectDir({dependencies: {other: '^1'}})
        expect(findDeclaration(['a-pkg', '@types/a-pkg'], dir)).toBeNull()
        fs.rmSync(dir, {recursive: true, force: true})
    })
})

describe('buildVersionBanner', () => {
    const NONE = makeProjectDir({dependencies: {other: '^1'}})

    test('returns empty string when there was no auto-install', () => {
        expect(buildVersionBanner(undefined, 'left-pad', '1.3.0', NONE)).toBe('')
    })

    test('declared-range banner names the range + version, no verify warning', () => {
        const b = buildVersionBanner(
            {source: 'declared-range', range: '^3.4.0'},
            'thing',
            '3.4.19',
            NONE
        )
        expect(b).toContain('^3.4.0')
        expect(b).toContain('3.4.19')
        expect(b).not.toMatch(/different MAJOR/i)
    })

    test('npm-latest banner warns about a possibly-different major + names version', () => {
        const b = buildVersionBanner({source: 'npm-latest'}, 'thing', '4.1.0', NONE)
        expect(b).toContain('4.1.0')
        expect(b).toMatch(/different MAJOR/i)
        expect(b).toMatch(/verify/i)
    })

    test('names the package ASKED about, not the terminal of the redirect chain', () => {
        const b = buildVersionBanner(
            {source: 'npm-latest', asked: 'bun'},
            'bun-types',
            '1.3.14',
            NONE
        )
        expect(b).toContain('"bun"')
        expect(b).not.toContain('"bun-types"')
        expect(b).toContain('The types this answer reads come from bun-types.')
    })

    test('a usable declaration off the chain is provenance, not a pin', () => {
        const dir = makeProjectDir({devDependencies: {'@types/bun': '^1.2.0'}})
        const b = buildVersionBanner(
            {source: 'npm-latest', asked: 'bun'},
            'bun-types',
            '1.3.14',
            dir
        )
        expect(b).toContain('"bun" is not declared in this project\'s package.json')
        expect(b).toContain('only its types are, as @types/bun ^1.2.0')
        expect(b).toContain('npm latest (v1.3.14)')
        fs.rmSync(dir, {recursive: true, force: true})
    })
})

describe('docsRaw auto-install version pinning', () => {
    // resolvePackage: first call (from the project cwd) is not_installed, so the
    // worker auto-installs; the post-install resolve returns a real fixture pkg so
    // the rest of the pipeline reaches `ok`. The fake spawn records the npm args.
    function pinHarness() {
        const installArgs: string[][] = []
        let calls = 0
        return {
            installArgs,
            resolvePackage: ((name: string, cwd: string) => {
                calls++
                if (calls === 1) {
                    throw new ResolveError('not_installed', `"${name}" not installed in ${cwd}`)
                }
                return realResolvePackage('tiny-pkg', FIXTURES)
            }) as typeof realResolvePackage,
            spawn: fakeSpawnByPrompt(args => {
                installArgs.push([...args])
                return {stdout: '', exitCode: 0}
            })
        }
    }

    test('installs the project-declared range, not latest, and pins the result', async () => {
        const dir = makeProjectDir({dependencies: {'left-pad': '^1.0.0'}})
        const cache = openCache(':memory:')
        const h = pinHarness()
        const r = await docsRaw({
            pkg: 'left-pad',
            query: 'x',
            cwd: dir,
            openCache: () => cache,
            npmVersionLookup: async () => ({pkg: 'left-pad', latest: '4.0.0', recent: []}),
            resolvePackage: h.resolvePackage,
            spawn: h.spawn
        })
        // npm install received `left-pad@^1.0.0`, never a bare `left-pad`.
        const npmInstall = h.installArgs.find(a => a.includes('install'))
        expect(npmInstall).toBeDefined()
        expect(npmInstall).toContain('left-pad@^1.0.0')
        expect(npmInstall).not.toContain('left-pad')
        expect(r.kind).toBe('ok')
        if (r.kind === 'ok') {
            expect(r.autoInstallPin).toEqual({
                source: 'declared-range',
                range: '^1.0.0',
                asked: 'left-pad'
            })
        }
        cache.close()
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('falls back to bare latest install + npm-latest pin when undeclared', async () => {
        const dir = makeProjectDir({dependencies: {something_else: '^1'}})
        const cache = openCache(':memory:')
        const h = pinHarness()
        const r = await docsRaw({
            pkg: 'left-pad',
            query: 'x',
            cwd: dir,
            openCache: () => cache,
            npmVersionLookup: async () => ({pkg: 'left-pad', latest: '4.0.0', recent: []}),
            resolvePackage: h.resolvePackage,
            spawn: h.spawn
        })
        const npmInstall = h.installArgs.find(a => a.includes('install'))
        expect(npmInstall).toBeDefined()
        expect(npmInstall).toContain('left-pad')
        expect(npmInstall!.some(a => a.startsWith('left-pad@'))).toBe(false)
        expect(r.kind).toBe('ok')
        if (r.kind === 'ok') {
            expect(r.autoInstallPin).toEqual({source: 'npm-latest', asked: 'left-pad'})
        }
        cache.close()
        fs.rmSync(dir, {recursive: true, force: true})
    })

    // The package NAME is model-chosen (a worker's question, or a
    // `/// <reference types="X" />` line in someone else's declarations), so a
    // hallucinated or typosquatted name must never get to run its install hooks.
    test('never lets an auto-installed package run its lifecycle scripts', async () => {
        const dir = makeProjectDir({dependencies: {}})
        const cache = openCache(':memory:')
        const h = pinHarness()
        await docsRaw({
            pkg: 'app.ts',
            query: 'x',
            cwd: dir,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            resolvePackage: h.resolvePackage,
            spawn: h.spawn
        })
        const npmInstall = h.installArgs.find(a => a.includes('install'))
        expect(npmInstall).toBeDefined()
        expect(npmInstall).toContain('--ignore-scripts')
        cache.close()
        fs.rmSync(dir, {recursive: true, force: true})
    })
})

describe('docsFocused', () => {
    test('returns answer + excerpt parsed from child stdout', async () => {
        const cache = openCache(':memory:')
        const r = await docsFocused({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>greet returns hi</answer>\n<excerpt>greet</excerpt>'
            }))
        })
        expect(r.answer).toBe('greet returns hi')
        expect(r.excerpt).toBe('greet')
        cache.close()
    })

    test('throws on docsRaw error (not_installed package)', async () => {
        const cache = openCache(':memory:')
        await expect(
            docsFocused({
                pkg: 'does-not-exist',
                query: 'x',
                cwd: FIXTURES,
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1, stderr: 'npm 404'}))
            })
        ).rejects.toThrow()
        cache.close()
    })
})
