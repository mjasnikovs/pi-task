import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    lockVersions,
    lockedVersion,
    lockedDeps,
    findLock,
    crateOf,
    isValidCrateName,
    resolveCrate,
    cratesLatest,
    crateTarballUrl,
    rustSurface,
    cargoProjectName
} from '../../src/workers/eco-cargo.js'
import {ECOSYSTEMS, defaultEcosystemIo} from '../../src/workers/docs-ecosystems.js'
import {docsRaw} from '../../src/workers/docs-core.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {ResolveError} from '../../src/workers/docs-resolve.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')
const CARGO_PROJECT = path.join(FIXTURES, 'cargo-project')
const CARGO_HOME = path.join(FIXTURES, 'cargo-home')
const TAURI = path.join(FIXTURES, 'cargo-project-tauri')
const CRATE_ROOT = path.join(
    CARGO_HOME,
    'registry',
    'src',
    'index.crates.io-0000000000000000',
    'tiny-crate-0.1.0'
)

function dirs(modulesDir = path.join(os.tmpdir(), 'never-written')): {
    cargoHome: string
    modulesDir: string
} {
    return {cargoHome: CARGO_HOME, modulesDir}
}

describe('the lock is the version', () => {
    test('reads a crate version out of the [[package]] blocks', () => {
        const lock = fs.readFileSync(path.join(CARGO_PROJECT, 'Cargo.lock'), 'utf8')
        expect(lockVersions(lock, 'tiny-crate')).toEqual(['0.1.0'])
        // A workspace legitimately holds two majors; the newest is what resolves.
        expect(lockVersions(lock, 'syn')).toEqual(['1.0.109', '2.0.104'])
        expect(lockedVersion('syn', CARGO_PROJECT)).toBe('2.0.104')
    })

    test('a dash and an underscore name the same crate', () => {
        const lock = fs.readFileSync(path.join(CARGO_PROJECT, 'Cargo.lock'), 'utf8')
        expect(lockVersions(lock, 'tiny_crate')).toEqual(['0.1.0'])
    })

    test('a path into a crate resolves to the crate', () => {
        expect(crateOf('serde_json::Value')).toBe('serde_json')
        expect(isValidCrateName('serde_json::Value')).toBe(true)
        expect(isValidCrateName('Data.Aeson')).toBe(false)
    })

    test('the lock is found one level DOWN in a Tauri repo', () => {
        // package.json at the root, the crate under src-tauri/ — the upward walk
        // from the root finds nothing at all.
        expect(findLock(TAURI)).toBe(path.join(TAURI, 'src-tauri', 'Cargo.lock'))
        expect(lockedVersion('tiny-crate', TAURI)).toBe('0.1.0')
    })

    test('the lock also answers what the project pins, for cache invalidation', () => {
        expect(lockedDeps(CARGO_PROJECT)).toEqual({
            'demo-app': '0.1.0',
            'tiny-crate': '0.1.0',
            syn: '2.0.104'
        })
        expect(lockedDeps(os.tmpdir())).toBeUndefined()
    })
})

describe('finding a crate on disk', () => {
    test('resolves the locked version out of the registry checkout', () => {
        const pkg = resolveCrate('tiny-crate', CARGO_PROJECT, dirs())
        expect(pkg.ecosystem).toBe('cargo')
        expect(pkg.name).toBe('tiny-crate')
        expect(pkg.version).toBe('0.1.0')
        expect(pkg.root).toBe(CRATE_ROOT)
        expect(pkg.entry).toBe(path.join(CRATE_ROOT, 'src', 'lib.rs'))
        expect(pkg.readme).toBe(path.join(CRATE_ROOT, 'README.md'))
    })

    test('a path into a crate resolves the crate itself', () => {
        expect(resolveCrate('tiny_crate::Greeting', CARGO_PROJECT, dirs()).name).toBe('tiny-crate')
    })

    test('a crate with no checkout is not_installed, not a wrong answer', () => {
        try {
            resolveCrate('tokio', CARGO_PROJECT, dirs())
            expect.unreachable()
        } catch (err) {
            expect(err).toBeInstanceOf(ResolveError)
            expect((err as ResolveError).kind).toBe('not_installed')
        }
    })

    test('the newest fetched copy answers when no lock is in reach', () => {
        // This is where the post-fetch re-resolve arrives: it is handed the
        // download directory, which holds no manifest.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-mod-'))
        fs.mkdirSync(path.join(modulesDir, 'cargo', 'left-pad-2.0.0', 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(modulesDir, 'cargo', 'left-pad-2.0.0', 'src', 'lib.rs'),
            'pub fn pad() {}',
            'utf8'
        )
        const pkg = resolveCrate('left-pad', modulesDir, {cargoHome: CARGO_HOME, modulesDir})
        expect(pkg.version).toBe('2.0.0')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('reads the project name out of [package]', () => {
        expect(cargoProjectName(CARGO_PROJECT)).toBe('demo-app')
        expect(cargoProjectName(os.tmpdir())).toBeNull()
    })
})

describe('the surface', () => {
    const lib = fs.readFileSync(path.join(CRATE_ROOT, 'src', 'lib.rs'), 'utf8')
    const out = rustSurface(lib)

    test('keeps every public item and its docs', () => {
        expect(out).toContain('//! A tiny crate used as a docs fixture.')
        expect(out).toContain('pub fn greet(name: &str) -> String;')
        expect(out).toContain('#[derive(Debug, Clone)]')
        expect(out).toContain('pub enum Volume')
        expect(out).toContain('pub struct Greeting')
        expect(out).toContain('/// Build a greeting for `name`.')
        expect(out).toContain('pub fn quiet(name: &str) -> Self;')
        // A trait member and a trait impl's members carry no `pub` and are public.
        expect(out).toContain('fn display_name(&self) -> String;')
        expect(out).toContain('fn fmt(&self, f: &mut fmt::Formatter<')
    })

    test('drops every body, private item and private field', () => {
        for (const line of out.split('\n')) {
            expect(line.trimStart().startsWith('let ')).toBe(false)
            expect(line.trimStart().startsWith('return ')).toBe(false)
        }
        expect(out).not.toContain('private_helper')
        expect(out).not.toContain('crate_only')
        expect(out).not.toContain('SECRET')
        expect(out).not.toContain('seen: bool')
        expect(out.length).toBeLessThan(lib.length)
    })

    test('a brace inside a string or a char literal does not end an item', () => {
        // `let brace = '{';` sits inside greet's body. A scanner that counts it
        // never finds greet's closing brace and swallows the rest of the file.
        expect(out).toContain('pub trait Greetable')
    })
})

describe('acquiring a crate', () => {
    test('downloads the .crate to a file and hands it to tar', async () => {
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-acq-'))
        const argv: string[][] = []
        const io = defaultEcosystemIo({
            cargoHome: CARGO_HOME,
            modulesDir,
            fetch: (async () => ({
                ok: true,
                status: 200,
                arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
            })) as unknown as typeof fetch,
            spawn: fakeSpawnByPrompt(args => {
                argv.push([...args])
                // Stand in for the extraction, so no real tar has to run.
                const target = path.join(modulesDir, 'cargo', 'tiny-crate-0.1.0', 'src')
                fs.mkdirSync(target, {recursive: true})
                fs.writeFileSync(path.join(target, 'lib.rs'), 'pub fn greet() {}', 'utf8')
                return {stdout: '', exitCode: 0}
            })
        })

        const result = await ECOSYSTEMS.cargo.acquire('tiny-crate', '0.1.0', io)
        expect(result.success).toBe(true)
        const tar = argv.find(a => a.includes('-xzf'))
        expect(tar).toBeDefined()
        expect(tar).toContain('-C')
        expect(tar!.some(a => a.endsWith('tiny-crate-0.1.0.crate'))).toBe(true)

        const resolved = resolveCrate('tiny-crate', result.installDir, {
            cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
            modulesDir
        })
        expect(resolved.version).toBe('0.1.0')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('the tarball URL is the crates.io static host', () => {
        expect(crateTarballUrl('serde_json::Value', '1.0.0')).toBe(
            'https://static.crates.io/crates/serde_json/serde_json-1.0.0.crate'
        )
    })
})

describe('the crates.io version lookup', () => {
    const BODY = {
        crate: {max_stable_version: '1.53.1', newest_version: '1.54.0-beta.1'},
        versions: [
            {num: '1.54.0-beta.1', created_at: '2026-08-01T00:00:00Z'},
            {num: '1.53.1', created_at: '2026-07-01T00:00:00Z'}
        ]
    }

    test('reports the newest STABLE version and when it was published', async () => {
        let seenUrl = ''
        let seenAgent = ''
        const fakeFetch = (async (url: string, init: {headers: Record<string, string>}) => {
            seenUrl = url
            seenAgent = init.headers['user-agent']
            return {ok: true, status: 200, json: async () => BODY}
        }) as unknown as typeof fetch

        const info = await cratesLatest('tokio', fakeFetch)
        expect(info).toEqual({
            pkg: 'tokio',
            latest: '1.53.1',
            recent: ['1.54.0-beta.1', '1.53.1'],
            publishedAt: '2026-07-01T00:00:00Z'
        })
        expect(seenUrl).toBe('https://crates.io/api/v1/crates/tokio')
        // crates.io rejects a request that does not name its caller.
        expect(seenAgent).toContain('pi-task')
    })

    test('a failing registry is no version, not an error', async () => {
        const dead = (async () => ({ok: false, status: 503})) as unknown as typeof fetch
        expect(await cratesLatest('tokio', dead)).toBeNull()
    })
})

describe('end to end', () => {
    test('a cargo project answers from crate source, scoped to the cargo rows', async () => {
        const cache = openCache(':memory:')
        try {
            const result = await docsRaw({
                pkg: 'tiny-crate',
                query: 'greet a name',
                cwd: CARGO_PROJECT,
                openCache: () => cache,
                io: {cargoHome: CARGO_HOME},
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0})),
                npmVersionLookup: async () => {
                    throw new Error('npm must not be asked about a crate')
                }
            })
            expect(result.kind).toBe('ok')
            if (result.kind !== 'ok') return
            expect(result.pkg.ecosystem).toBe('cargo')
            expect(result.pkg.version).toBe('0.1.0')
            expect(result.registryLabel).toBe('crates.io')
            expect(result.chunks.some(c => c.content.includes('pub fn greet'))).toBe(true)

            const scoped = cache.db
                .prepare("SELECT count(*) AS c FROM chunks WHERE ecosystem = 'cargo'")
                .get() as {c: number}
            expect(scoped.c).toBeGreaterThan(0)
            const npmRows = cache.db
                .prepare("SELECT count(*) AS c FROM chunks WHERE ecosystem = 'npm'")
                .get() as {c: number}
            expect(npmRows.c).toBe(0)
        } finally {
            cache.close()
        }
    })

    test('a Tauri repo reads the crate it has, and refuses the name it does not', async () => {
        const cache = openCache(':memory:')
        let installs = 0
        const spawn = fakeSpawnByPrompt(args => {
            if (args.includes('install')) installs++
            return {stdout: '', exitCode: 0}
        })
        try {
            const found = await docsRaw({
                pkg: 'tiny-crate',
                query: 'greet',
                cwd: TAURI,
                openCache: () => cache,
                io: {cargoHome: CARGO_HOME},
                spawn,
                npmVersionLookup: async () => null
            })
            expect(found.kind).toBe('ok')
            if (found.kind === 'ok') expect(found.pkg.ecosystem).toBe('cargo')

            // Installed in neither, so which registry to read is not decidable.
            const ambiguous = await docsRaw({
                pkg: 'nowhere-at-all',
                query: 'anything',
                cwd: TAURI,
                openCache: () => cache,
                io: {cargoHome: CARGO_HOME},
                spawn,
                npmVersionLookup: async () => null
            })
            expect(ambiguous.kind).toBe('error')
            if (ambiguous.kind === 'error') {
                expect(ambiguous.resolveError).toBe('ambiguous_ecosystem')
                expect(ambiguous.message).toContain('ecosystem:')
            }
            expect(installs).toBe(0)
        } finally {
            cache.close()
        }
    })
})
