import {describe, expect, test} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {deflateRawSync, crc32} from 'node:zlib'
import {
    parseGoMod,
    parseGoWork,
    parseVendorModules,
    goManifests,
    goProjectName,
    goDeclaredDeps,
    goManifestDeps,
    goDeclaredVersion,
    detectGo,
    isValidImportPath,
    isStdlibImport,
    isProjectStdlib,
    isGoFile,
    selectOwnPackage,
    escapeModulePath,
    unescapeModulePath,
    modulePrefixes,
    resolveGoPackage,
    resolveModulePath,
    goLatest,
    moduleZipUrl,
    acquireGoModule,
    selectBuildVariants,
    defaultGoModCache
} from '../../src/workers/eco-go.js'
import {ECOSYSTEMS, chooseEcosystem, detectEcosystems} from '../../src/workers/docs-ecosystems.js'
import {ResolveError} from '../../src/workers/docs-resolve.js'
import {docsRaw} from '../../src/workers/docs-core.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')
const PROJECT = path.join(FIXTURES, 'go-project')
const MODCACHE = path.join(FIXTURES, 'go-modcache')
const VENDORED = path.join(FIXTURES, 'go-vendor')
const WORKSPACE = path.join(FIXTURES, 'go-work')
const TAGS = path.join(FIXTURES, 'go-tags')

function dirs(modulesDir = path.join(os.tmpdir(), 'never-written')): {
    goModCache: string
    modulesDir: string
} {
    return {goModCache: MODCACHE, modulesDir}
}

describe('names and escaping', () => {
    test('an import path is a slash-separated path, and a shell trick is not', () => {
        expect(isValidImportPath('github.com/gin-gonic/gin')).toBe(true)
        expect(isValidImportPath('net/http')).toBe(true)
        expect(isValidImportPath('gopkg.in/yaml.v3')).toBe(true)
        expect(isValidImportPath('../etc/passwd')).toBe(false)
        expect(isValidImportPath('/abs/path')).toBe(false)
        expect(isValidImportPath('a//b')).toBe(false)
        expect(isValidImportPath('a; rm -rf /')).toBe(false)
    })

    test('uppercase round-trips through the proxy and cache spelling', () => {
        expect(escapeModulePath('github.com/BurntSushi/toml')).toBe('github.com/!burnt!sushi/toml')
        expect(unescapeModulePath('github.com/!burnt!sushi/toml')).toBe(
            'github.com/BurntSushi/toml'
        )
    })

    test("stdlib is Go's own rule: no dot in the first path element", () => {
        expect(isStdlibImport('net/http')).toBe(true)
        expect(isStdlibImport('internal/abi')).toBe(true)
        expect(isStdlibImport('unsafe')).toBe(true)
        expect(isStdlibImport('golang.org/x/net/html')).toBe(false)
        expect(isStdlibImport('go.uber.org/zap')).toBe(false)
    })

    test('a test file is excluded on its suffix, not on the word test', () => {
        expect(isGoFile('server.go')).toBe(true)
        expect(isGoFile('server_test.go')).toBe(false)
        // gin.CreateTestContext is documented public API.
        expect(isGoFile('test_helpers.go')).toBe(true)
        expect(isGoFile('README.md')).toBe(false)
    })

    test('module candidates run longest first', () => {
        expect(modulePrefixes('github.com/gin-gonic/gin/binding')).toEqual([
            'github.com/gin-gonic/gin/binding',
            'github.com/gin-gonic/gin'
        ])
        // No host serves a module at github.com/<one segment>.
        expect(modulePrefixes('github.com/foo/bar')).toEqual(['github.com/foo/bar'])
        expect(modulePrefixes('go.uber.org/zap/zapcore')).toEqual([
            'go.uber.org/zap/zapcore',
            'go.uber.org/zap'
        ])
    })
})

describe('parseGoMod', () => {
    const mod = parseGoMod(fs.readFileSync(path.join(PROJECT, 'go.mod'), 'utf8'))

    test('reads the module path and the language version', () => {
        expect(mod.module).toBe('example.com/docs-live-go')
        expect(mod.goVersion).toBe('1.24')
        expect(mod.toolchain).toBe('go1.24.12')
    })

    test('collects requires across every block and both forms', () => {
        const names = mod.requires.map(r => r.module)
        expect(names).toContain('github.com/foo/tiny-go')
        expect(names).toContain('gopkg.in/yaml.v3')
        expect(names).toContain('golang.org/x/text')
    })

    test('the indirect marker decides, not the block a line sits in', () => {
        const byName = new Map(mod.requires.map(r => [r.module, r.indirect]))
        expect(byName.get('github.com/gin-gonic/gin')).toBe(false)
        expect(byName.get('gopkg.in/yaml.v3')).toBe(true)
        expect(byName.get('golang.org/x/text')).toBe(true)
        // Sits in an indirect block with no marker of its own.
        expect(byName.get('k8s.io/api')).toBe(false)
    })

    test('reads replace targets and survives exclude and retract', () => {
        expect(mod.replaces.get('k8s.io/api')).toBe('./staging/k8s.io/api')
        expect(mod.requires.some(r => r.module.startsWith('['))).toBe(false)
        expect(mod.requires.some(r => r.module === 'github.com/linode/linodego')).toBe(false)
    })
})

describe('project dependencies', () => {
    test('declaredDeps is every require, indirect included', () => {
        const deps = goDeclaredDeps(PROJECT)!
        expect(deps['github.com/gin-gonic/gin']).toBe('v1.12.0')
        expect(deps['golang.org/x/text']).toBe('v0.34.0')
    })

    test('a require replaced by a local directory is dropped', () => {
        // `k8s.io/api v0.0.0` is a placeholder that resolves only through the
        // replace; fetching it from the proxy would 404.
        expect(goDeclaredDeps(PROJECT)).not.toHaveProperty('k8s.io/api')
    })

    test('manifestDeps is what the project may import directly', () => {
        const deps = goManifestDeps(PROJECT)!
        expect(deps.has('github.com/gin-gonic/gin')).toBe(true)
        expect(deps.has('gopkg.in/yaml.v3')).toBe(false)
    })

    test('a directory with no manifest cannot tell, which is not "declares nothing"', () => {
        const empty = tmpDir('go-empty')
        expect(goDeclaredDeps(empty)).toBeUndefined()
        expect(goManifestDeps(empty)).toBeUndefined()
    })

    test('the longest matching require pins a subpackage import', () => {
        expect(goDeclaredVersion('github.com/gin-gonic/gin/binding', PROJECT)).toBe('v1.12.0')
        expect(goDeclaredVersion('github.com/nothing/here', PROJECT)).toBeNull()
    })

    test('the project name comes from its own module directive', () => {
        expect(goProjectName(PROJECT)).toBe('example.com/docs-live-go')
    })
})

describe('go.work', () => {
    test('every use directory is a manifest, not just the root', () => {
        const dirsFound = parseGoWork(
            fs.readFileSync(path.join(WORKSPACE, 'go.work'), 'utf8'),
            WORKSPACE
        )
        expect(dirsFound).toEqual([path.join(WORKSPACE, 'app'), path.join(WORKSPACE, 'lib')])
        expect(goManifests(path.join(WORKSPACE, 'app'))).toHaveLength(2)
    })

    test('dependencies are the union across members', () => {
        const deps = goManifestDeps(path.join(WORKSPACE, 'app'))!
        expect(deps.has('github.com/gin-gonic/gin')).toBe(true)
        expect(deps.has('go.uber.org/zap')).toBe(true)
    })

    test('a member module is not a dependency of the workspace', () => {
        // `example.com/lib v0.0.0` resolves from the working tree; asking a
        // registry for it is the k8s staging mistake.
        expect(goManifestDeps(path.join(WORKSPACE, 'app'))!.has('example.com/lib')).toBe(false)
    })
})

describe('parseVendorModules', () => {
    const index = parseVendorModules(
        fs.readFileSync(path.join(VENDORED, 'vendor', 'modules.txt'), 'utf8')
    )

    test('maps each vendored package to its module and version', () => {
        expect(index.get('github.com/foo/tiny-go')).toEqual({
            module: 'github.com/foo/tiny-go',
            version: 'v0.1.0'
        })
        expect(index.get('github.com/foo/tiny-go/inner')?.module).toBe('github.com/foo/tiny-go')
    })

    test('the ## annotation lines are not package paths', () => {
        expect(index.has('explicit; go 1.24')).toBe(false)
    })
})

describe('resolveGoPackage', () => {
    test('finds a module in the cache and reports the version from its directory', () => {
        const pkg = resolveGoPackage('github.com/foo/tiny-go', PROJECT, dirs())
        expect(pkg.ecosystem).toBe('go')
        expect(pkg.version).toBe('v0.1.0')
        expect(pkg.root).toBe(path.join(MODCACHE, 'github.com/foo/tiny-go@v0.1.0'))
        expect(pkg.entry).toBe(path.join(pkg.root, 'doc.go'))
    })

    test('a subpackage import resolves to its own directory', () => {
        const pkg = resolveGoPackage('github.com/foo/tiny-go/inner', PROJECT, dirs())
        expect(pkg.root).toBe(path.join(MODCACHE, 'github.com/foo/tiny-go@v0.1.0', 'inner'))
    })

    test('an uppercase module path is found through its escaped directory', () => {
        const pkg = resolveGoPackage('github.com/BurntSushi/toml', PROJECT, dirs())
        expect(pkg.version).toBe('v1.6.0')
    })

    test('vendored source wins, needing no cache and no network', () => {
        const pkg = resolveGoPackage('github.com/foo/tiny-go', VENDORED, {
            goModCache: path.join(os.tmpdir(), 'no-such-cache'),
            modulesDir: path.join(os.tmpdir(), 'no-such-modules')
        })
        expect(pkg.root).toBe(path.join(VENDORED, 'vendor', 'github.com/foo/tiny-go'))
        expect(pkg.version).toBe('v0.1.0')
    })

    test('an absent package is not_installed, never a substituted version', () => {
        try {
            resolveGoPackage('github.com/foo/absent', PROJECT, dirs())
            throw new Error('expected a ResolveError')
        } catch (err) {
            expect(err).toBeInstanceOf(ResolveError)
            expect((err as ResolveError).kind).toBe('not_installed')
        }
    })

    test('an invalid import path is refused before anything is read', () => {
        try {
            resolveGoPackage('../../etc', PROJECT, dirs())
            throw new Error('expected a ResolveError')
        } catch (err) {
            expect((err as ResolveError).kind).toBe('invalid_name')
        }
    })
})

describe('isProjectStdlib', () => {
    test('a dotless module path does not make its own packages stdlib', () => {
        const project = tmpDir('go-dotless')
        fs.writeFileSync(path.join(project, 'go.mod'), 'module myapp\n\ngo 1.24\n')
        expect(isStdlibImport('myapp/internal/db')).toBe(true)
        expect(isProjectStdlib('myapp/internal/db', project)).toBe(false)
        expect(isProjectStdlib('net/http', project)).toBe(true)
    })
})

/** A proxy that answers only for the paths given, the way the real one does. */
function fakeProxy(known: Record<string, {Version: string; Time?: string}>): typeof fetch {
    return (async (url: string) => {
        const match = /proxy\.golang\.org\/(.+)\/@latest$/.exec(String(url))
        const body = match ? known[match[1]] : undefined
        if (!body) return {ok: false, status: 404, json: async () => ({})}
        return {ok: true, status: 200, json: async () => body}
    }) as unknown as typeof fetch
}

describe('resolveModulePath', () => {
    test('takes the longest prefix that resolves', async () => {
        const proxy = fakeProxy({
            'github.com/gin-gonic/gin': {Version: 'v1.12.0'}
        })
        expect(await resolveModulePath('github.com/gin-gonic/gin/binding', proxy)).toEqual({
            module: 'github.com/gin-gonic/gin',
            version: 'v1.12.0'
        })
    })

    test('a submodule is preferred over the repo root it sits in', async () => {
        // Both resolve, to genuinely different modules; shortest-first is wrong.
        const proxy = fakeProxy({
            'github.com/aws/aws-sdk-go-v2/service/s3': {Version: 'v1.111.0'},
            'github.com/aws/aws-sdk-go-v2': {Version: 'v1.46.0'}
        })
        const got = await resolveModulePath('github.com/aws/aws-sdk-go-v2/service/s3', proxy)
        expect(got?.module).toBe('github.com/aws/aws-sdk-go-v2/service/s3')
    })

    test('a major-version suffix is a path element and stops the walk there', async () => {
        const proxy = fakeProxy({
            'github.com/go-redis/redis/v8': {Version: 'v8.11.5'},
            'github.com/go-redis/redis': {Version: 'v6.15.9+incompatible'}
        })
        const got = await resolveModulePath('github.com/go-redis/redis/v8', proxy)
        expect(got?.version).toBe('v8.11.5')
    })

    test('a 200 with no version does not stop the walk', async () => {
        // Observed live: `.../service/@latest` answered 200 with an empty body on
        // one probe and 404 on the next, so `res.ok` is not a stop condition.
        const proxy = (async (url: string) => {
            if (String(url).includes('/service/@latest')) {
                return {ok: true, status: 200, json: async () => ({})}
            }
            if (String(url).includes('aws-sdk-go-v2/@latest')) {
                return {ok: true, status: 200, json: async () => ({Version: 'v1.46.0'})}
            }
            return {ok: false, status: 404, json: async () => ({})}
        }) as unknown as typeof fetch
        const got = await resolveModulePath('github.com/aws/aws-sdk-go-v2/service', proxy)
        expect(got?.module).toBe('github.com/aws/aws-sdk-go-v2')
    })

    test('nothing resolves means nothing, not the shortest prefix', async () => {
        expect(await resolveModulePath('github.com/nobody/nothing', fakeProxy({}))).toBeNull()
    })
})

describe('goLatest', () => {
    test('maps the proxy answer onto the shared version shape', async () => {
        const proxy = fakeProxy({
            'go.uber.org/zap': {Version: 'v1.28.0', Time: '2026-04-28T02:13:09Z'}
        })
        expect(await goLatest('go.uber.org/zap/zapcore', proxy)).toEqual({
            pkg: 'go.uber.org/zap',
            latest: 'v1.28.0',
            recent: [],
            publishedAt: '2026-04-28T02:13:09Z'
        })
    })

    test('the standard library has no published version to report', async () => {
        expect(await goLatest('net/http', fakeProxy({}))).toBeNull()
    })
})

describe('moduleZipUrl', () => {
    test('escapes the module path and the version', () => {
        expect(moduleZipUrl('github.com/BurntSushi/toml', 'v1.6.0')).toBe(
            'https://proxy.golang.org/github.com/!burnt!sushi/toml/@v/v1.6.0.zip'
        )
    })
})

/** A module zip shaped like the proxy's: deflate, sizes only in the directory. */
function buildModuleZip(prefix: string, files: Record<string, string>): Buffer {
    const locals: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const [rel, body] of Object.entries(files)) {
        const raw = Buffer.from(body, 'utf8')
        const data = deflateRawSync(raw)
        const name = Buffer.from(`${prefix}/${rel}`, 'utf8')

        const local = Buffer.alloc(30 + name.length)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(0x08, 6)
        local.writeUInt16LE(8, 8)
        local.writeUInt16LE(name.length, 26)
        name.copy(local, 30)
        locals.push(local, data)

        const cdfh = Buffer.alloc(46 + name.length)
        cdfh.writeUInt32LE(0x02014b50, 0)
        cdfh.writeUInt16LE(0x08, 8)
        cdfh.writeUInt16LE(8, 10)
        cdfh.writeUInt32LE(crc32(raw), 16)
        cdfh.writeUInt32LE(data.length, 20)
        cdfh.writeUInt32LE(raw.length, 24)
        cdfh.writeUInt16LE(name.length, 28)
        cdfh.writeUInt32LE(offset, 42)
        name.copy(cdfh, 46)
        central.push(cdfh)

        offset += local.length + data.length
    }
    const cd = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, cd, eocd])
}

describe('acquireGoModule', () => {
    const archive = buildModuleZip('github.com/foo/fetched@v0.2.0', {
        'go.mod': 'module github.com/foo/fetched\n',
        'api.go': 'package fetched\n\n// Run does the thing.\nfunc Run() {}\n',
        'api_test.go': 'package fetched\n\nfunc TestRun(t *testing.T) {}\n',
        'README.md': '# fetched\n',
        'internal/secret.go': 'package internal\n'
    })

    function fetchOk(seen: string[]): typeof fetch {
        return (async (url: string) => {
            const u = String(url)
            seen.push(u)
            if (u.endsWith('/@latest')) {
                return u.includes('/foo/fetched/@latest') ?
                        {ok: true, status: 200, json: async () => ({Version: 'v0.2.0'})}
                    :   {ok: false, status: 404, json: async () => ({})}
            }
            return {ok: true, status: 200, arrayBuffer: async () => archive}
        }) as unknown as typeof fetch
    }

    test('extracts into the module cache layout, so one rule reads both', async () => {
        const modulesDir = tmpDir('go-acquire')
        const seen: string[] = []
        const got = await acquireGoModule(
            'github.com/foo/fetched',
            null,
            PROJECT,
            {goModCache: MODCACHE, modulesDir},
            fetchOk(seen)
        )
        expect(got.success).toBe(true)
        const root = path.join(modulesDir, 'go', 'github.com/foo/fetched@v0.2.0')
        expect(fs.readFileSync(path.join(root, 'api.go'), 'utf8')).toContain('func Run()')
        expect(seen).toContain('https://proxy.golang.org/github.com/foo/fetched/@v/v0.2.0.zip')
    })

    test('the declared pin is fetched, not whatever the proxy tags newest', async () => {
        const modulesDir = tmpDir('go-acquire-pin')
        const seen: string[] = []
        await acquireGoModule(
            'github.com/foo/fetched',
            'v0.1.5',
            PROJECT,
            {goModCache: MODCACHE, modulesDir},
            fetchOk(seen)
        )
        expect(seen.some(u => u.endsWith('v0.1.5.zip'))).toBe(true)
    })

    test('test files and internal trees are never written', async () => {
        const modulesDir = tmpDir('go-acquire-filter')
        await acquireGoModule(
            'github.com/foo/fetched',
            null,
            PROJECT,
            {goModCache: MODCACHE, modulesDir},
            fetchOk([])
        )
        const root = path.join(modulesDir, 'go', 'github.com/foo/fetched@v0.2.0')
        expect(fs.existsSync(path.join(root, 'api_test.go'))).toBe(false)
        expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true)
    })

    test('a fetched module then resolves off disk', async () => {
        const modulesDir = tmpDir('go-acquire-resolve')
        await acquireGoModule(
            'github.com/foo/fetched',
            null,
            PROJECT,
            {goModCache: MODCACHE, modulesDir},
            fetchOk([])
        )
        const pkg = resolveGoPackage('github.com/foo/fetched', PROJECT, {
            goModCache: MODCACHE,
            modulesDir
        })
        expect(pkg.version).toBe('v0.2.0')
    })

    test('an uppercase module is written escaped, the way the cache spells it', async () => {
        // Found live: the zip spells the path in its ORIGINAL case, so writing
        // entries verbatim left `github.com/BurntSushi/toml` on disk beside a
        // resolver looking for `github.com/!burnt!sushi/toml` — every uppercase
        // module resolved as not-installed straight after a successful fetch.
        const modulesDir = tmpDir('go-acquire-case')
        const upper = buildModuleZip('github.com/Foo/Cased@v0.3.0', {
            'api.go': 'package cased\n\n// Run does the thing.\nfunc Run() {}\n'
        })
        const serve = (async (url: string) => {
            const u = String(url)
            if (u.endsWith('/@latest')) {
                return u.includes('/!foo/!cased/@latest') ?
                        {ok: true, status: 200, json: async () => ({Version: 'v0.3.0'})}
                    :   {ok: false, status: 404, json: async () => ({})}
            }
            return {ok: true, status: 200, arrayBuffer: async () => upper}
        }) as unknown as typeof fetch

        const got = await acquireGoModule(
            'github.com/Foo/Cased',
            null,
            PROJECT,
            {goModCache: MODCACHE, modulesDir},
            serve
        )
        expect(got.success).toBe(true)
        expect(
            fs.existsSync(path.join(modulesDir, 'go', 'github.com/!foo/!cased@v0.3.0', 'api.go'))
        ).toBe(true)
        expect(
            resolveGoPackage('github.com/Foo/Cased', PROJECT, {goModCache: MODCACHE, modulesDir})
                .version
        ).toBe('v0.3.0')
    })

    test('a module nothing serves fails with a message naming the path', async () => {
        const got = await acquireGoModule(
            'github.com/foo/absent',
            null,
            PROJECT,
            {goModCache: MODCACHE, modulesDir: tmpDir('go-acquire-miss')},
            fakeProxy({})
        )
        expect(got.success).toBe(false)
        expect(got.stderr).toContain('github.com/foo/absent')
    })
})

describe('selectBuildVariants', () => {
    test('keeps the variant that holds with no build tags', () => {
        const files = fs.readdirSync(TAGS).map(f => path.join(TAGS, f))
        const kept = selectBuildVariants(files).map(f => path.basename(f))
        expect(kept).toEqual(['json.go', 'plain.go'])
    })

    test('a directory whose every file is tag-guarded stays readable', () => {
        const dir = tmpDir('go-all-tagged')
        fs.writeFileSync(path.join(dir, 'a.go'), '//go:build linux\n\npackage a\n')
        fs.writeFileSync(path.join(dir, 'b.go'), '//go:build windows\n\npackage a\n')
        expect(selectBuildVariants(fs.readdirSync(dir).map(f => path.join(dir, f)))).toHaveLength(2)
    })

    test('files in different directories are never variants of each other', () => {
        const files = [path.join(TAGS, 'jsoniter.go'), path.join(PROJECT, 'main.go')]
        expect(selectBuildVariants(files)).toHaveLength(2)
    })
})

describe('the row in the roster', () => {
    test('a go.mod above or beside the cwd is a Go project', () => {
        expect(detectGo(PROJECT)).toBe(true)
        expect(detectGo(path.join(WORKSPACE, 'app'))).toBe(true)
        expect(detectGo(FIXTURES)).toBe(false)
    })

    test('go is detected alongside the ecosystems it shares a repo with', () => {
        const polyglot = tmpDir('go-polyglot')
        fs.writeFileSync(path.join(polyglot, 'go.mod'), 'module example.com/p\n\ngo 1.24\n')
        fs.writeFileSync(path.join(polyglot, 'package.json'), '{"dependencies":{"zod":"^4"}}')
        expect(detectEcosystems(polyglot).sort()).toEqual(['go', 'npm'])
    })

    test('a name both registries declare is decided by the manifest, not roster order', () => {
        const polyglot = tmpDir('go-ambiguous')
        fs.writeFileSync(
            path.join(polyglot, 'go.mod'),
            'module example.com/p\n\ngo 1.24\n\nrequire github.com/foo/semver v1.0.28\n'
        )
        fs.writeFileSync(path.join(polyglot, 'package.json'), '{"dependencies":{"zod":"^4"}}')
        const chosen = chooseEcosystem({
            cwd: polyglot,
            declaresPackage: p => p.manifestDeps(polyglot)?.has('github.com/foo/semver') ?? false
        })
        expect(chosen.ok).toBe(true)
        expect(chosen.ok && chosen.profile.id).toBe('go')
    })

    test('the row states its own registry and manifest for a refusal message', () => {
        expect(ECOSYSTEMS.go.registryLabel).toBe('proxy.golang.org')
        expect(ECOSYSTEMS.go.manifestLabel).toBe('go.mod')
        expect(ECOSYSTEMS.go.surfaceLabel).toContain('.go')
    })

    test('the fingerprint carries the file-selection rule, not only the extractor', () => {
        expect(ECOSYSTEMS.go.contentFingerprint()).toContain('selectBuildVariants')
    })
})

describe('defaultGoModCache', () => {
    test('honours GOMODCACHE, then GOPATH, then the documented default', () => {
        const before = {mod: process.env.GOMODCACHE, gopath: process.env.GOPATH}
        try {
            process.env.GOMODCACHE = '/explicit/cache'
            expect(defaultGoModCache()).toBe('/explicit/cache')
            delete process.env.GOMODCACHE
            process.env.GOPATH = '/my/gopath'
            expect(defaultGoModCache()).toBe(path.join('/my/gopath', 'pkg', 'mod'))
            delete process.env.GOPATH
            expect(defaultGoModCache()).toBe(path.join(os.homedir(), 'go', 'pkg', 'mod'))
        } finally {
            if (before.mod === undefined) delete process.env.GOMODCACHE
            else process.env.GOMODCACHE = before.mod
            if (before.gopath === undefined) delete process.env.GOPATH
            else process.env.GOPATH = before.gopath
        }
    })
})

describe('end to end', () => {
    test('a Go project answers from package source, scoped to the go rows', async () => {
        const cache = openCache(':memory:')
        try {
            const result = await docsRaw({
                pkg: 'github.com/foo/tiny-go',
                query: 'greet a name',
                cwd: PROJECT,
                openCache: () => cache,
                io: {goModCache: MODCACHE},
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0})),
                npmVersionLookup: async () => {
                    throw new Error('npm must not be asked about a Go package')
                }
            })
            expect(result.kind).toBe('ok')
            if (result.kind !== 'ok') return
            expect(result.pkg.ecosystem).toBe('go')
            expect(result.pkg.version).toBe('v0.1.0')
            expect(result.registryLabel).toBe('proxy.golang.org')

            const text = result.chunks.map(c => c.content).join('\n')
            expect(text).toContain('func Greet(name string) string')
            // The extractor's whole job: bodies, private names and the licence
            // header must not reach the index.
            expect(text).not.toContain('func hidden')
            expect(text).not.toContain('All rights reserved')
            // A subpackage the root never imports is a DIFFERENT package that this
            // one cannot hand you, so it is not indexed under this name. It used to
            // be, and re-run 9 measured the cost: 10 of gin's 51 retrieved chunks
            // came from `ginS`. A caller who wants it asks for the path, which
            // resolves on its own.
            const deep = cache.db
                .prepare("SELECT count(*) AS c FROM chunks WHERE content LIKE '%Deep%'")
                .get() as {c: number}
            expect(deep.c).toBe(0)

            const npmRows = cache.db
                .prepare("SELECT count(*) AS c FROM chunks WHERE ecosystem = 'npm'")
                .get() as {c: number}
            expect(npmRows.c).toBe(0)
        } finally {
            cache.close()
        }
    })

    test('build-tag twins are indexed once, not four times', async () => {
        const cache = openCache(':memory:')
        const project = tmpDir('go-tags-project')
        const modules = tmpDir('go-tags-modules')
        fs.writeFileSync(
            path.join(project, 'go.mod'),
            'module example.com/p\n\ngo 1.24\n\nrequire github.com/foo/tagged v0.1.0\n'
        )
        const root = path.join(modules, 'go', 'github.com/foo/tagged@v0.1.0')
        fs.mkdirSync(root, {recursive: true})
        for (const file of fs.readdirSync(TAGS)) {
            fs.copyFileSync(path.join(TAGS, file), path.join(root, file))
        }
        try {
            const result = await docsRaw({
                pkg: 'github.com/foo/tagged',
                query: 'marshal a value',
                cwd: project,
                openCache: () => cache,
                io: {goModCache: path.join(modules, 'empty'), modulesDir: modules},
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0})),
                npmVersionLookup: async () => null
            })
            expect(result.kind).toBe('ok')
            if (result.kind !== 'ok') return
            const text = result.chunks.map(c => c.content).join('\n')
            expect(text).toContain('Marshal is the default encoder')
            expect(text).not.toContain('jsoniter encoder')
            expect(text).not.toContain('go-json encoder')
        } finally {
            cache.close()
        }
    })
})

// A Go subdirectory is a DIFFERENT importable package. Walking a module's whole
// tree filed every one of them under the parent's name: on re-run 9's cache 71% of
// `encoding/json`'s chunks, 54% of zap's and 34% of gin's, and it reached retrieval
// — a question about registering a gin route came back with 10 `ginS` chunks of 51.
function goTree(files: Record<string, string>): {root: string; paths: string[]} {
    const root = tmpDir('go-own-package')
    const paths: string[] = []
    for (const [rel, src] of Object.entries(files)) {
        const abs = path.join(root, rel)
        fs.mkdirSync(path.dirname(abs), {recursive: true})
        fs.writeFileSync(abs, src)
        paths.push(abs)
    }
    return {root, paths}
}

const NAME = 'github.com/foo/bar'

test('a subpackage the root never imports is dropped', () => {
    const {root, paths} = goTree({
        'bar.go': `package bar\n\nimport "${NAME}/render"\n`,
        'render/render.go': 'package render\n',
        'ginS/gins.go': 'package ginS\n'
    })
    // path.relative emits backslashes on Windows; the expected literals use slashes.
    const kept = selectOwnPackage(paths, root, NAME, 'v1.2.0').map(f =>
        path.relative(root, f).replace(/\\/g, '/')
    )
    expect(kept).toEqual(['bar.go', 'render/render.go'])
})

test('the import closure is followed, so an alias hop survives', () => {
    // zap's `Field` is `= zapcore.Field`, and zapcore in turn reaches `buffer`.
    const {root, paths} = goTree({
        'zap.go': `package zap\n\nimport "${NAME}/zapcore"\n\ntype Field = zapcore.Field\n`,
        'zapcore/core.go': `package zapcore\n\nimport "${NAME}/buffer"\n`,
        'buffer/buffer.go': 'package buffer\n',
        'zapgrpc/grpc.go': 'package zapgrpc\n'
    })
    const kept = selectOwnPackage(paths, root, NAME, 'v1.28.0').map(f =>
        path.relative(root, f).replace(/\\/g, '/')
    )
    expect(kept.sort()).toEqual(['buffer/buffer.go', 'zap.go', 'zapcore/core.go'])
})

test('a mismatching major goes even though the root imports it', () => {
    // encoding/json is BUILT on encoding/json/v2 and imports it. v2 is the same API
    // at a different major — same `Marshal`, same `Unmarshal` — and half the
    // retrieval for the commonest decode question came back from it.
    const {root, paths} = goTree({
        'json.go': `package json\n\nimport "${NAME}/v2"\nimport "${NAME}/jsontext"\n`,
        'v2/json.go': 'package json\n',
        'jsontext/text.go': 'package jsontext\n'
    })
    const kept = selectOwnPackage(paths, root, NAME, 'go1.25.14').map(f =>
        path.relative(root, f).replace(/\\/g, '/')
    )
    expect(kept.sort()).toEqual(['json.go', 'jsontext/text.go'])
})

test('a vN directory matching the package major is kept', () => {
    const {root, paths} = goTree({
        'bar.go': `package bar\n\nimport "${NAME}/v1"\n`,
        'v1/impl.go': 'package v1\n'
    })
    const kept = selectOwnPackage(paths, root, NAME, 'v1.2.0').map(f =>
        path.relative(root, f).replace(/\\/g, '/')
    )
    expect(kept.sort()).toEqual(['bar.go', 'v1/impl.go'])
})

test('a module whose root is not a package keeps everything', () => {
    const {root, paths} = goTree({
        'service/s3/api.go': 'package s3\n',
        'service/sqs/api.go': 'package sqs\n'
    })
    expect(selectOwnPackage(paths, root, NAME, 'v1.0.0').length).toBe(2)
})

test('a string that is not an import path does not reach a subpackage', () => {
    const {root, paths} = goTree({
        'bar.go': `package bar\n\nconst doc = "${NAME}/render is a package"\n`,
        'render/render.go': 'package render\n'
    })
    const kept = selectOwnPackage(paths, root, NAME, 'v1.2.0').map(f =>
        path.relative(root, f).replace(/\\/g, '/')
    )
    expect(kept).toEqual(['bar.go'])
})
