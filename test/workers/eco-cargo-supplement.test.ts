/**
 * Defect 16 — the cargo half of DEFECT-12-STOPPING-RULE.md, on axum's real shape.
 *
 * `pub trait IntoResponse` is declared in `axum-core`; `axum` only `pub use`s it,
 * so a query for it retrieves eight chunks and none of them define anything. The
 * fixture reproduces exactly that: a published `[dependencies.<name>]` manifest,
 * a nested `pub use axum_core::response::{…}` block, and one type the crate does
 * declare itself.
 */
import {describe, expect, test, beforeAll, afterAll} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
    cargoExportGap,
    cargoSupplementCandidates,
    resolveCrate
} from '../../src/workers/eco-cargo.js'
import {ECOSYSTEMS, defaultEcosystemIo} from '../../src/workers/docs-ecosystems.js'

const CARGO_HOME_FIXTURE = path.resolve(__dirname, '__fixtures__', 'cargo-home')

let root = ''
let plain = ''

function write(base: string, rel: string, body: string): void {
    const abs = path.join(base, rel)
    fs.mkdirSync(path.dirname(abs), {recursive: true})
    fs.writeFileSync(abs, body)
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-gap-'))
    // A PUBLISHED manifest: cargo normalises every dependency to its own table,
    // so the inline `axum-core = { … }` form the crate was written with is gone.
    write(
        root,
        'Cargo.toml',
        [
            '[package]',
            'name = "axum"',
            '',
            '[dependencies.axum-core]',
            'version = "0.5.6"',
            '',
            '[dependencies.bytes]',
            'version = "1"',
            '',
            '[dev-dependencies.axum-test]',
            'version = "1"'
        ].join('\n')
    )
    write(
        root,
        'src/lib.rs',
        [
            'pub mod response;',
            '',
            'pub use axum_core::{BoxError, Error};',
            '',
            'pub use bytes::Bytes;'
        ].join('\n')
    )
    write(
        root,
        'src/response/mod.rs',
        [
            'pub struct Html<T>(pub T);',
            '',
            '#[doc(inline)]',
            'pub use axum_core::response::{',
            '    AppendHeaders, IntoResponse, Response,',
            '};',
            '',
            'pub use crate::form::Form;'
        ].join('\n')
    )
    write(root, 'src/glob.rs', ['pub use axum_core::extract::*;'].join('\n'))

    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-plain-'))
    write(
        plain,
        'Cargo.toml',
        ['[package]', 'name = "serde_json"', '', '[dependencies.serde]', 'version = "1"'].join('\n')
    )
    write(plain, 'src/lib.rs', ['pub struct Value;', 'pub fn to_string() {}'].join('\n'))
})
afterAll(() => {
    fs.rmSync(root, {recursive: true, force: true})
    fs.rmSync(plain, {recursive: true, force: true})
})

describe('cargoExportGap', () => {
    test('a name the crate pub-uses from a dependency and declares nowhere is a hole', () => {
        const gap = cargoExportGap(root)
        expect(gap.empty).toBe(false)
        expect(
            gap.fillsHole('pub trait IntoResponse {\n    fn into_response(self) -> Response;\n}')
        ).toBe(true)
        expect(gap.fillsHole('pub struct AppendHeaders<H>(pub H);')).toBe(true)
    })

    test('a name the crate declares itself is not a hole', () => {
        expect(cargoExportGap(root).fillsHole('pub struct Html<T>(pub T);')).toBe(false)
    })

    test('a `crate::` re-export is internal and never a hole', () => {
        expect(cargoExportGap(root).fillsHole('pub struct Form<T>(pub T);')).toBe(false)
    })

    test('a glob re-export takes the supplier module wholesale', () => {
        const gap = cargoExportGap(root)
        expect(gap.wholesale('src/extract/mod.rs', 'pub fn anything() {}')).toBe(true)
        expect(gap.wholesale('src/response/into_response.rs', 'pub fn anything() {}')).toBe(false)
    })

    test('a re-exported name containing "as" is not truncated', () => {
        // `Hasher` split on a bare "as" yields "H". The rename form is `X as Y`,
        // which only exists with the spaces intact.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-as-'))
        try {
            write(
                dir,
                'Cargo.toml',
                ['[package]', 'name = "h"', '', '[dependencies.dep]', 'version = "1"'].join('\n')
            )
            write(dir, 'src/lib.rs', 'pub use dep::{Hasher, Inner as Outer};')
            const gap = cargoExportGap(dir)
            expect(gap.fillsHole('pub struct Hasher;')).toBe(true)
            expect(gap.fillsHole('pub struct H;')).toBe(false)
            // The rename's SOURCE name is the hole; the supplier declares `Inner`.
            expect(gap.fillsHole('pub struct Inner;')).toBe(true)
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('a crate that re-exports nothing external has no gap at all', () => {
        expect(cargoExportGap(plain).empty).toBe(true)
    })
})

describe('cargoSupplementCandidates', () => {
    const resolved = {
        'axum-core': '0.5.6',
        'axum-macros': '0.5.0',
        bytes: '1.11.0',
        'axum-test': '1.0.0'
    }

    test('a prefix-named runtime dependency is a candidate; a foreign one is not', () => {
        const got = cargoSupplementCandidates('axum', new Set(['axum-core', 'bytes']), resolved)
        expect(got.map(c => c.name)).toEqual(['axum-core'])
    })

    test('the manifest writes `-` and the code writes `_`, so both spellings match', () => {
        const got = cargoSupplementCandidates('clap', new Set(['clap_builder', 'clap-derive']), {
            clap_builder: '4.5.51',
            'clap-derive': '4.5.51'
        })
        expect(got.map(c => c.name)).toEqual(['clap-derive', 'clap_builder'])
    })

    test('a candidate with no resolved version is dropped, not guessed', () => {
        const got = cargoSupplementCandidates(
            'axum',
            new Set(['axum-core', 'axum-extra']),
            resolved
        )
        expect(got.map(c => c.name)).toEqual(['axum-core'])
    })

    test('the crate itself is never its own supplement', () => {
        expect(cargoSupplementCandidates('axum', new Set(['axum']), {axum: '0.8.9'})).toEqual([])
    })
})

describe('the cargo supplements hook reads the PROJECT lock', () => {
    // `findLock` walks upward, and a crate unpacked under `~/.cargo/registry` sits
    // below whatever lock happens to be above it. Reading the crate's own root
    // returned `axum-macros 0.5.1` on this machine — a version the project never
    // resolved — which is an index whose shape depends on the machine.
    let project = ''
    beforeAll(() => {
        project = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-proj-'))
        write(
            project,
            'Cargo.toml',
            ['[package]', 'name = "app"', '', '[dependencies]', 'tiny-axum = "0.1"'].join('\n')
        )
        write(
            project,
            'Cargo.lock',
            [
                '[[package]]',
                'name = "tiny-axum"',
                'version = "0.1.0"',
                '',
                '[[package]]',
                'name = "tiny-axum-core"',
                'version = "0.1.0"'
            ].join('\n')
        )
    })
    afterAll(() => fs.rmSync(project, {recursive: true, force: true}))

    const io = () =>
        defaultEcosystemIo({cargoHome: CARGO_HOME_FIXTURE, modulesDir: CARGO_HOME_FIXTURE})

    test('a dependency the project resolved becomes a supplement', async () => {
        const pkg = resolveCrate('tiny-axum', project, {
            cargoHome: CARGO_HOME_FIXTURE,
            modulesDir: CARGO_HOME_FIXTURE
        })
        const sups = await ECOSYSTEMS.cargo.supplements!(pkg, project, io())
        expect(sups.map(s => s.name)).toEqual(['tiny-axum-core'])
    })

    test('a project with no lock resolves no version, so no supplement', async () => {
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-nolock-'))
        try {
            const pkg = resolveCrate('tiny-axum', project, {
                cargoHome: CARGO_HOME_FIXTURE,
                modulesDir: CARGO_HOME_FIXTURE
            })
            const sups = await ECOSYSTEMS.cargo.supplements!(pkg, bare, io())
            expect(sups).toEqual([])
        } finally {
            fs.rmSync(bare, {recursive: true, force: true})
        }
    })
})
