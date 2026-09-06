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
    cargoProjectName,
    CARGO_DECL_SPLIT_RE
} from '../../src/workers/eco-cargo.js'
import {ECOSYSTEMS, defaultEcosystemIo} from '../../src/workers/docs-ecosystems.js'
import {docsRaw} from '../../src/workers/docs-core.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {chunkDeclarations} from '../../src/workers/docs-chunk.js'
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

    test('the lock also answers what the project pins, under either spelling', () => {
        // `lockedVersion` canonicalises `-`/`_` before matching, so a map keyed
        // only on the lockfile's literal name would give a different answer to the
        // same question — and a cache entry keyed the other way never expires.
        const deps = lockedDeps(CARGO_PROJECT)
        expect(deps?.['tiny-crate']).toBe('0.1.0')
        expect(deps?.['tiny_crate']).toBe('0.1.0')
        expect(deps?.syn).toBe('2.0.104')
        expect(deps?.['demo-app']).toBe('0.1.0')
        expect(lockedVersion('tiny_crate', CARGO_PROJECT)).toBe('0.1.0')
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

    test('a prerelease checkout is found, not reported missing', () => {
        // `clap-4.0.0-rc.1` split at the LAST dash gives version "rc.1", which no
        // version test accepts — so a crate sitting right there reads as absent.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-pre-'))
        fs.mkdirSync(path.join(modulesDir, 'cargo', 'clap-4.0.0-rc.1', 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(modulesDir, 'cargo', 'clap-4.0.0-rc.1', 'src', 'lib.rs'),
            'pub fn build() {}',
            'utf8'
        )
        const pkg = resolveCrate('clap', modulesDir, {
            cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
            modulesDir
        })
        expect(pkg.name).toBe('clap')
        expect(pkg.version).toBe('4.0.0-rc.1')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('a crate whose NAME ends in a dash and a digit is found', () => {
        // `md-5-0.10.6` split at the FIRST dash a digit follows gives name "md"
        // and version "5-0.10.6", so md-5, sha-1 and utf-8 all read as absent.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-dash-'))
        fs.mkdirSync(path.join(modulesDir, 'cargo', 'md-5-0.10.6', 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(modulesDir, 'cargo', 'md-5-0.10.6', 'src', 'lib.rs'),
            'pub fn digest() {}',
            'utf8'
        )
        const pkg = resolveCrate('md-5', modulesDir, {
            cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
            modulesDir
        })
        expect(pkg.name).toBe('md-5')
        expect(pkg.version).toBe('0.10.6')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('build metadata sorts by its RELEASE, not as a missing patch', () => {
        // `2.0.16+zstd.1.5.7` splits on `.` into 2, 0, "16+zstd", 1, 5, 7 — the
        // patch reads as NaN, coerced to 0, so 2.0.16 loses to 2.0.9.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-meta-'))
        for (const dir of ['zstd-sys-2.0.9', 'zstd-sys-2.0.16+zstd.1.5.7']) {
            fs.mkdirSync(path.join(modulesDir, 'cargo', dir, 'src'), {recursive: true})
            fs.writeFileSync(
                path.join(modulesDir, 'cargo', dir, 'src', 'lib.rs'),
                'pub fn z() {}',
                'utf8'
            )
        }
        const pkg = resolveCrate('zstd-sys', modulesDir, {
            cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
            modulesDir
        })
        expect(pkg.version).toBe('2.0.16+zstd.1.5.7')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test('a lock pin the disk does not hold is not_installed, not a substitute', () => {
        // Answering from another checkout's newer copy sets no install pin, so
        // buildVersionBanner emits nothing and the swap is silent.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-pin-'))
        fs.mkdirSync(path.join(modulesDir, 'cargo', 'tiny-crate-9.9.9', 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(modulesDir, 'cargo', 'tiny-crate-9.9.9', 'src', 'lib.rs'),
            'pub fn newer() {}',
            'utf8'
        )
        try {
            resolveCrate('tiny-crate', CARGO_PROJECT, {
                cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
                modulesDir
            })
            expect.unreachable()
        } catch (err) {
            expect(err).toBeInstanceOf(ResolveError)
            expect((err as ResolveError).kind).toBe('not_installed')
        }
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

    test("a braced re-export keeps its list — it is most crates' whole API", () => {
        const out2 = rustSurface(
            'pub use crate::runtime::{Runtime, Builder};\npub use self::spawn;'
        )
        expect(out2).toContain('pub use crate::runtime::{Runtime, Builder};')
        expect(out2).toContain('pub use self::spawn;')
        expect(out2).not.toContain('runtime::;')
    })

    test('the module doc is emitted once, not once per item', () => {
        const doubled = rustSurface('//! Crate doc.\n\n/// A thing.\npub fn thing() -> u8 { 1 }\n')
        expect(doubled.split('//! Crate doc.').length - 1).toBe(1)
        // A nested module must not reprint it either.
        const nested = rustSurface('//! Crate doc.\npub mod inner {\n    pub fn a() {}\n}\n')
        expect(nested.split('//! Crate doc.').length - 1).toBe(1)
    })

    test('a private field sharing a line with a public one is still dropped', () => {
        const inline = rustSurface('pub struct Cfg { pub n: u32, secret: u8 }')
        expect(inline).toContain('pub n: u32')
        expect(inline).not.toContain('secret')
    })

    test('a field doc is kept, and a generic or a closure type is not cut at its commas', () => {
        const generics = rustSurface(
            'pub struct M {\n    /// the map\n    pub map: HashMap<String, u8>,\n'
                + '    pub cb: Box<dyn Fn(u8, u8) -> u8>,\n    hidden: u8,\n}'
        )
        expect(generics).toContain('/// the map')
        expect(generics).toContain('pub map: HashMap<String, u8>,')
        expect(generics).toContain('pub cb: Box<dyn Fn(u8, u8) -> u8>,')
        expect(generics).not.toContain('hidden')
    })

    test('a raw string is opaque — a quote inside one is not a delimiter', () => {
        // `skipString` scanning for the next `"` re-opens on the quote INSIDE
        // r#"…"# , brace depth desynchronises, and the rest of the file is
        // swallowed. Tauri's whole WebviewBuilder surface went that way.
        const out2 = rustSurface(
            'pub fn quote() { let s = r#"a"b{"#; }\npub struct Wanted { pub x: u8 }\n'
        )
        expect(out2).toContain('pub fn quote()')
        expect(out2).toContain('pub struct Wanted')
        expect(
            rustSurface('#[doc = r##"has "quotes" and { braces"##]\npub fn documented();')
        ).toContain('pub fn documented')
    })

    test('an exported macro is API; an unexported one is not', () => {
        const out2 = rustSurface(
            '/// Return early.\n#[macro_export]\nmacro_rules! bail { ($m:literal) => {} }\n'
                + 'macro_rules! private_helper { () => {} }\n'
        )
        expect(out2).toContain('/// Return early.')
        expect(out2).toContain('macro_rules! bail')
        expect(out2).not.toContain('private_helper')
    })

    test('an impl on a private type is not published as callable API', () => {
        const out2 = rustSurface(
            'struct Secret { x: u8 }\nimpl Secret { pub fn new() -> Self { Secret{x:0} } }\n'
                + 'pub struct Open;\nimpl Open { pub fn go() {} }\n'
        )
        expect(out2).not.toContain('Secret')
        expect(out2).toContain('impl Open')
        expect(out2).toContain('pub fn go()')
    })

    test('a field whose type wraps across lines survives whole', () => {
        const out2 = rustSurface(
            'pub struct S {\n    /// the map\n    pub map: HashMap<\n        String,\n'
                + '        u8,\n    >,\n    pub(crate) hidden: u8,\n    pub b: u8,\n}'
        )
        expect(out2).toContain('/// the map')
        expect(out2).toContain('String, u8,')
        // `pub(crate)` is not the crate's public surface.
        expect(out2).not.toContain('hidden')
        // The truncation this replaced emitted `pub map: HashMap<,`.
        expect(out2).not.toContain('HashMap<,')
        expect(
            rustSurface('pub enum E {\n    A {\n        x: u8,\n    },\n    B(u8),\n}')
        ).not.toContain('A {,')
    })

    test('module docs belong to their own module, once', () => {
        // Not a leading RUN: a crate root opens with `#![allow(…)]` blocks and
        // documents itself below them.
        const belowAttrs = rustSurface('#![allow(dead_code)]\n//! Crate doc.\npub fn a() {}\n')
        expect(belowAttrs).toContain('//! Crate doc.')

        const nested = rustSurface(
            '//! Crate doc.\npub mod inner {\n    //! Inner doc.\n    pub fn a() {}\n}\n'
        )
        expect(nested.split('//! Inner doc.').length - 1).toBe(1)
        expect(nested.indexOf('//! Inner doc.')).toBeGreaterThan(nested.indexOf('pub mod inner'))
    })

    test('a brace inside a string or a char literal does not end an item', () => {
        // `let brace = '{';` sits inside greet's body. A scanner that counts it
        // never finds greet's closing brace and swallows the rest of the file.
        expect(out).toContain('pub trait Greetable')
    })
})

describe('chunking the surface', () => {
    test('a nested method is not its own chunk', () => {
        // `^\s*` matched INDENTED items too, so every method of an impl or a
        // trait became a chunk — an orphan signature with no receiver type, and
        // the next method's doc comment glued to its tail.
        const surface = rustSurface(
            'pub struct Foo { pub id: u64 }\n'
                + 'impl Foo {\n'
                + '    /// build\n'
                + '    pub fn new(id: u64) -> Self { Self { id } }\n'
                + '    /// take\n'
                + '    pub fn take(&self) -> u8 { 1 }\n'
                + '}\n'
                + 'pub trait Go { fn go(&self) -> u8; }\n'
        )
        const chunks = chunkDeclarations(surface, 'lib.rs', CARGO_DECL_SPLIT_RE, '//')
        const impl = chunks.filter(c => c.includes('impl Foo'))
        expect(impl).toHaveLength(1)
        expect(impl[0]).toContain('pub fn new')
        expect(impl[0]).toContain('pub fn take')
        expect(chunks.some(c => /^\/\/ lib\.rs\npub fn new/.test(c))).toBe(false)
        expect(chunks.filter(c => c.includes('fn go')).every(c => c.includes('trait Go'))).toBe(
            true
        )
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
        // The archive name carries a per-download suffix — concurrent research
        // children would otherwise share one path and delete each other's file.
        expect(tar!.some(a => /tiny-crate-0\.1\.0\..*\.crate$/.test(a))).toBe(true)

        const resolved = resolveCrate('tiny-crate', result.installDir, {
            cargoHome: path.join(os.tmpdir(), 'no-cargo-home'),
            modulesDir
        })
        expect(resolved.version).toBe('0.1.0')
        fs.rmSync(modulesDir, {recursive: true, force: true})
    })

    test("the download uses the REGISTRY spelling, not the caller's", async () => {
        // `use tokio_util::codec` is how the crate is written in Rust source, and
        // crateOf yields that. The crates.io API normalises `_` to `-`; the CDN
        // does not — it answers 403 for the underscore path.
        const modulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-name-'))
        const urls: string[] = []
        const io = defaultEcosystemIo({
            cargoHome: CARGO_HOME,
            modulesDir,
            fetch: (async (url: string) => {
                urls.push(url)
                if (url.includes('/api/v1/crates/')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({
                            crate: {name: 'tokio-util', max_stable_version: '0.7.13'},
                            versions: [{num: '0.7.13'}]
                        })
                    }
                }
                if (url.includes('tokio_util-')) return {ok: false, status: 403}
                return {
                    ok: true,
                    status: 200,
                    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
                }
            }) as unknown as typeof fetch,
            spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0}))
        })

        const result = await ECOSYSTEMS.cargo.acquire('tokio_util', null, io)
        expect(result.success).toBe(true)
        expect(urls).toContain('https://static.crates.io/crates/tokio-util/tokio-util-0.7.13.crate')
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

    test('the lock decides the version, and an older one is kept beside it', async () => {
        // A package index keeps every version it has seen — unlike the project
        // corpus, which keeps only its newest. Moving the lock back must therefore
        // be a cache HIT, not a re-index.
        const cache = openCache(':memory:')
        const project = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-lock-'))
        fs.writeFileSync(path.join(project, 'Cargo.toml'), '[package]\nname = "p"\n', 'utf8')
        const pin = (version: string): void =>
            fs.writeFileSync(
                path.join(project, 'Cargo.lock'),
                `version = 4\n\n[[package]]\nname = "many"\nversion = "${version}"\n`,
                'utf8'
            )
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eco-cargo-home-'))
        for (const version of ['1.0.0', '2.0.0']) {
            const dir = path.join(home, 'registry', 'src', 'index', `many-${version}`, 'src')
            fs.mkdirSync(dir, {recursive: true})
            fs.writeFileSync(path.join(dir, 'lib.rs'), `pub fn v${version[0]}() {}`, 'utf8')
        }
        const ask = async (): Promise<{version: string; hitCache: boolean}> => {
            const r = await docsRaw({
                pkg: 'many',
                query: 'v1 v2',
                cwd: project,
                openCache: () => cache,
                io: {cargoHome: home},
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 0})),
                npmVersionLookup: async () => null
            })
            if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`)
            return {version: r.pkg.version, hitCache: r.hitCache}
        }

        try {
            pin('1.0.0')
            expect(await ask()).toEqual({version: '1.0.0', hitCache: false})
            pin('2.0.0')
            expect(await ask()).toEqual({version: '2.0.0', hitCache: false})
            pin('1.0.0')
            expect(await ask()).toEqual({version: '1.0.0', hitCache: true})

            const versions = cache.db
                .prepare(
                    "SELECT DISTINCT version FROM chunks WHERE ecosystem = 'cargo' AND name = 'many' ORDER BY version"
                )
                .all() as {version: string}[]
            expect(versions.map(v => v.version)).toEqual(['1.0.0', '2.0.0'])
        } finally {
            cache.close()
            fs.rmSync(project, {recursive: true, force: true})
            fs.rmSync(home, {recursive: true, force: true})
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

// Defect 20. tokio wraps `pub struct TcpListener` in `cfg_net! { … }`, and a
// macro invocation was one opaque item, so 441 of tokio's 2,919 public items were
// dropped from the surface — including one of this test suite's own ground-truth
// symbols. Measured across 22 crates: 818 items sit inside an item-shaped macro
// block and 0 inside an interpolating one.
describe('an item inside a `name! { … }` block', () => {
    const CFG_NET = [
        'use crate::io::PollEvented;',
        '',
        'cfg_net! {',
        '    /// A TCP socket server, listening for connections.',
        '    pub struct TcpListener {',
        '        io: PollEvented<mio::net::TcpListener>,',
        '    }',
        '',
        '    impl TcpListener {',
        '        pub async fn bind<A: ToSocketAddrs>(addr: A) -> io::Result<TcpListener> {',
        '            todo!()',
        '        }',
        '    }',
        '}'
    ].join('\n')

    test('is reached, with its doc comment', () => {
        const s = rustSurface(CFG_NET)
        expect(s).toContain('pub struct TcpListener')
        expect(s).toContain('A TCP socket server')
        expect(s).toContain('pub async fn bind')
    })

    test('a private item inside one is still dropped', () => {
        expect(rustSurface('cfg_rt! {\n    struct Hidden { a: u8 }\n}')).not.toContain('Hidden')
    })

    test('a token template is not source, so nothing is taken from it', () => {
        const q = [
            'quote! {',
            '    pub struct #ident {',
            '        pub #field: #ty,',
            '    }',
            '}'
        ].join('\n')
        expect(rustSurface(q)).not.toContain('struct')
    })

    test('a body with no item at all contributes nothing', () => {
        expect(rustSurface('test_parse! {\n    parse_ok "GET / HTTP/1.1";\n}').trim()).toBe('')
    })

    test('a macro CALL with arguments is untouched', () => {
        expect(rustSurface('pub fn f() {}\nassert_eq!(a, b);').replace(/\s+/g, ' ')).toContain(
            'pub fn f'
        )
    })
})
