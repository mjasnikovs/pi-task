import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    acquirePackage,
    docsRaw,
    docsFocused,
    findDeclaredRange,
    findDeclaration,
    declarationChain,
    buildVersionBanner,
    buildPrompt
} from '../../src/workers/docs-core.js'
import {
    resolvePackage as realResolvePackage,
    ResolveError,
    type ResolvedPackage
} from '../../src/workers/docs-resolve.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {ECOSYSTEMS} from '../../src/workers/docs-ecosystems.js'

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

test('the extraction prompt names the registry the source actually came from', () => {
    // The child is handed Rust or Haskell whenever the row is not npm's, and this
    // is the one sentence telling it what it has.
    const crate: ResolvedPackage = {
        ecosystem: 'cargo',
        name: 'tokio',
        version: '1.53.1',
        root: '/x',
        entry: null,
        readme: null
    }
    expect(buildPrompt(crate, 'spawn a task', 'source')).toContain('a Rust crate from crates.io')
    expect(buildPrompt({...crate, ecosystem: 'npm'}, 'q', 'c')).toContain('an npm package')
})

describe('buildVersionBanner', () => {
    test('a non-npm answer names its own registry and its own manifest', () => {
        // The pin literal is shared across rows, so without the profile a crates.io
        // answer led with "not declared in this project's package.json … based on
        // npm latest" — two false claims in one model-facing sentence.
        const b = buildVersionBanner(
            {source: 'npm-latest', asked: 'tokio'},
            'tokio',
            '1.38.0',
            NONE,
            ECOSYSTEMS.cargo
        )
        expect(b).toContain('Cargo.toml')
        expect(b).toContain('crates.io')
        expect(b).not.toContain('package.json')
        expect(b).not.toContain('npm latest')
    })

    const NONE = makeProjectDir({dependencies: {other: '^1'}})

    test('no auto-install and a declared package says nothing', () => {
        const dir = makeProjectDir({dependencies: {'left-pad': '^1'}})
        expect(buildVersionBanner(undefined, 'left-pad', '1.3.0', dir)).toBe('')
        fs.rmSync(dir, {recursive: true, force: true})
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

    test('declared as a dist-tag is reported as declared, not as missing', () => {
        const dir = makeProjectDir({devDependencies: {'@types/bun': 'latest'}})
        const b = buildVersionBanner(
            {source: 'npm-latest', asked: 'bun'},
            'bun-types',
            '1.3.14',
            dir
        )
        expect(b).toContain(
            '"bun" is declared in this project\'s package.json only through @types/bun, as `latest`'
        )
        expect(b).not.toContain('is not declared')
        expect(b).not.toMatch(/different MAJOR/i)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('a protocol declaration on the package itself is also declared', () => {
        const dir = makeProjectDir({dependencies: {'a-pkg': 'workspace:*'}})
        const b = buildVersionBanner({source: 'npm-latest', asked: 'a-pkg'}, 'a-pkg', '2.0.0', dir)
        expect(b).toContain('"a-pkg" is declared in this project\'s package.json as `workspace:*`')
        expect(b).not.toContain('is not declared')
        fs.rmSync(dir, {recursive: true, force: true})
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

// ─── acquirePackage: the ladder both call sites now share ────────────────────
//
// `acquirePackage` is the one ladder both call sites use: docsRaw for the
// requested package, and `tryResolveOrInstall` for each hop of the type-redirect
// chain. Driving it directly is what keeps the abort signal, the version pin and
// the provenance the same on both paths — a hop that acquired its own way could
// otherwise install `latest` while the primary path pinned.
describe('acquirePackage', () => {
    function harness() {
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

    test('a HOP install honours the project-declared range, not latest', async () => {
        // The declaration hop is the one most likely to be declared:
        // "a project that uses Bun declares `@types/bun`, not `bun`".
        const dir = makeProjectDir({devDependencies: {'@types/bun': '^1.2.0'}})
        const h = harness()
        const got = await acquirePackage({
            name: '@types/bun',
            cwd: dir,
            spawn: h.spawn,
            resolvePackage: h.resolvePackage,
            signal: undefined
        })
        const npmInstall = h.installArgs.find(a => a.includes('install'))
        expect(npmInstall).toContain('@types/bun@^1.2.0')
        expect(got.ok).toBe(true)
        if (got.ok) {
            expect(got.autoInstalled).toBe(true)
            expect(got.pin).toEqual({
                source: 'declared-range',
                range: '^1.2.0',
                asked: '@types/bun'
            })
        }
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('reports the acquisition as already-present when no install was needed', async () => {
        const dir = makeProjectDir({dependencies: {}})
        const installArgs: string[][] = []
        const got = await acquirePackage({
            name: 'tiny-pkg',
            cwd: dir,
            spawn: fakeSpawnByPrompt(args => {
                installArgs.push([...args])
                return {stdout: '', exitCode: 0}
            }),
            resolvePackage: (() => realResolvePackage('tiny-pkg', FIXTURES)) as never,
            signal: undefined
        })
        expect(got.ok).toBe(true)
        if (got.ok) {
            expect(got.autoInstalled).toBe(false)
            expect(got.pin).toBeUndefined()
        }
        expect(installArgs).toHaveLength(0)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('names the stage it failed at, so the caller can shape its own error', async () => {
        const dir = makeProjectDir({dependencies: {}})
        const failing = await acquirePackage({
            name: 'left-pad',
            cwd: dir,
            spawn: fakeSpawnByPrompt(() => ({stdout: '', stderr: 'E404 not found', exitCode: 1})),
            resolvePackage: ((name: string) => {
                throw new ResolveError('not_installed', `"${name}" not installed`)
            }) as never,
            signal: undefined
        })
        expect(failing.ok).toBe(false)
        if (!failing.ok) {
            expect(failing.stage).toBe('install')
            if (failing.stage === 'install') expect(failing.asked).toBe('left-pad')
        }

        const badName = await acquirePackage({
            name: 'Bad Name',
            cwd: dir,
            spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0})),
            resolvePackage: ((name: string) => {
                throw new ResolveError('invalid_name', `"${name}" is not a package name`)
            }) as never,
            signal: undefined
        })
        expect(badName.ok).toBe(false)
        if (!badName.ok) expect(badName.stage).toBe('resolve')
        fs.rmSync(dir, {recursive: true, force: true})
    })

    // Driven through docsRaw rather than acquirePackage: the signal has to survive
    // the whole call chain, and a caller that drops it — passing a bare `undefined`
    // to fill a positional — leaves a user cancel undelivered to the npm install.
    test('a cancelled run does not silently complete docsRaw’s own install', async () => {
        const dir = makeProjectDir({dependencies: {}})
        const cache = openCache(':memory:')
        const ac = new AbortController()
        ac.abort()
        const h = harness()
        const r = await docsRaw({
            pkg: 'left-pad',
            query: 'x',
            cwd: dir,
            signal: ac.signal,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            resolvePackage: h.resolvePackage,
            spawn: h.spawn
        })
        // The fake npm exits 0, so ONLY the delivered abort can fail this install.
        expect(r.kind).toBe('error')
        if (r.kind === 'error') expect(r.resolveError).toBe('not_installed')
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

    test('a FAILED child yields no answer — its stdout is not read as documentation', async () => {
        // parseChildOutput (shared/child-output.ts) returns the whole trimmed stdout
        // as `answer` when there is no <answer> tag. So a child that dies mid-answer
        // hands its error dump up as documentation, and phases.ts pastes whatever
        // `r.answer` holds into the spec. The failure has to be caught here instead.
        const cache = openCache(':memory:')
        const r = await docsFocused({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => ({
                stdout: 'error: model endpoint unreachable',
                exitCode: 1,
                stderr: 'connect ECONNREFUSED 127.0.0.1:8080'
            }))
        })
        expect(r.answer).toBe('')
        expect(r.failure).toContain('Worker exited 1')
        expect(r.failure).toContain('ECONNREFUSED')
        expect(r.exitCode).toBe(1)
        expect(r.excerptVerified).toBeUndefined()
        // The package metadata a caller reports alongside the failure is still there.
        expect(r.pkg.name).toBe('tiny-pkg')
        cache.close()
    })

    test('an ABORTED child yields no answer either', async () => {
        const cache = openCache(':memory:')
        const r = await docsFocused({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            signal: AbortSignal.abort(),
            spawn: fakeSpawnByPrompt(() => ({stdout: '<answer>half an answer</answer>'}))
        })
        expect(r.answer).toBe('')
        expect(r.aborted).toBe(true)
        expect(r.failure).toBe('Docs lookup aborted.')
        cache.close()
    })

    test('a verified excerpt carries the full verification record, not just a verdict', async () => {
        const cache = openCache(':memory:')
        const r = await docsFocused({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>a</answer>\n<excerpt>not in the package at all</excerpt>'
            }))
        })
        expect(r.excerptVerified).toBe(false)
        expect(r.failure).toBeUndefined()
        expect(r.excerptCheck?.normalisedExcerpt).toBe('not in the package at all')
        expect(r.excerptCheck?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
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

describe('buildVersionBanner — resolvable but not declared', () => {
    // Live run 2026-09-05, the Rust HARD FAIL (DOC_REGRESSINONS.md section 4).
    // `tower 0.5.3` is in Cargo.lock, pulled in transitively by axum, and absent
    // from [dependencies]. The tool answered `tower::util::ServiceExt` in full
    // confidence, the model wrote that import, and the crate did not compile:
    //   error[E0433]: cannot find module or crate `tower` in this scope
    // Measured on npm in the same container: 23 declared deps, 106 undeclared
    // packages on disk, three of three answered with no warning.
    function cargoProject(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-undeclared-'))
        fs.writeFileSync(
            path.join(dir, 'Cargo.toml'),
            [
                '[package]',
                'name = "docs-live-rs"',
                'version = "0.1.0"',
                '',
                '[dependencies]',
                'axum = "0.8.9"',
                'tokio = { version = "1.53.1", features = ["full"] }',
                'serde_json = "1.0.151"',
                'serde = { version = "1", features = ["derive"] }',
                ''
            ].join('\n'),
            'utf8'
        )
        fs.writeFileSync(
            path.join(dir, 'Cargo.lock'),
            [
                '[[package]]',
                'name = "axum"',
                'version = "0.8.9"',
                '',
                '[[package]]',
                'name = "tower"',
                'version = "0.5.3"',
                ''
            ].join('\n'),
            'utf8'
        )
        return dir
    }

    test('cargo: a crate only in Cargo.lock is named as not declared', () => {
        const dir = cargoProject()
        const b = buildVersionBanner(undefined, 'tower', '0.5.3', dir, ECOSYSTEMS.cargo)
        expect(b).toMatch(/not a declared dependency/i)
        expect(b).toContain('tower')
        expect(b).toContain('Cargo.toml')
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('cargo: a declared crate gets no such warning', () => {
        const dir = cargoProject()
        const b = buildVersionBanner(undefined, 'axum', '0.8.9', dir, ECOSYSTEMS.cargo)
        expect(b).not.toMatch(/not a declared dependency/i)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('npm: a transitive package on disk is named as not declared', () => {
        const dir = makeProjectDir({dependencies: {debug: '^4.0.0'}})
        const b = buildVersionBanner(undefined, 'ms', '2.1.0', dir)
        expect(b).toMatch(/not a declared dependency/i)
        expect(b).toContain('ms')
        expect(b).toContain('package.json')
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('npm: a declared package gets no such warning', () => {
        const dir = makeProjectDir({dependencies: {debug: '^4.0.0'}})
        expect(buildVersionBanner(undefined, 'debug', '4.1.13', dir)).not.toMatch(
            /not a declared dependency/i
        )
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('no manifest at all says nothing — "cannot tell" is not "not declared"', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-nomanifest-'))
        expect(buildVersionBanner(undefined, 'ms', '2.1.0', dir)).toBe('')
        fs.rmSync(dir, {recursive: true, force: true})
    })
})
