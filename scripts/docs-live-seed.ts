/**
 * Seed the three greenfield projects the live docs test runs against.
 *
 * Each project pins a library MAJOR newer than the local model's knowledge, with
 * its dependencies already installed. The pin is the instrument: a task that can
 * only be completed by reading the docs is the only task that measures the docs.
 *
 * FOUR REQUIREMENTS, DELIBERATELY. `granularityFloor` (task/decompose-granularity)
 * returns 0 below five ownable requirements and ceil(n/2) above, and
 * `planShapeIsHostsToAnswer` uses the same cut. There is no cap on task count —
 * MAX_TASKS was removed — so the spec is the only lever, and a fifth requirement
 * would put a floor of 3 under the plan and grow from there.
 *
 *   bun scripts/docs-live-seed.ts <root>            # seed all three
 *   bun scripts/docs-live-seed.ts <root> ts rs      # seed a subset
 *
 * `bun run test` globs `scripts/`, so nothing here runs on import.
 */

import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {PROJECTS, type ProjectSpec} from './docs-live-truth.js'

/**
 * The feature text handed to `/task-auto`, one per project.
 *
 * Written as exactly four obligations. They are the same four everywhere —
 * validate, serve, JSON, test — so a per-language failure stands out against the
 * other two rather than being explained by a different task.
 */
const FEATURES: Record<ProjectSpec['id'], string> = {
    ts:
        'Build a small config service in TypeScript. It must:'
        + ' (1) read config.json from the project root and validate it with zod,'
        + ' requiring a string name, a port number between 1 and 65535, and an admin email;'
        + ' (2) serve GET /config on a hono app, returning the validated config as JSON;'
        + ' (3) return HTTP 400 with the validation issues as JSON when config.json is invalid;'
        + ' (4) cover all three of those with tests in test/config.test.ts that pass under `bun test`.',
    rs:
        'Build a small config service in Rust. It must:'
        + ' (1) read config.json from the crate root and deserialize it with serde into a Config'
        + ' struct holding a String name, a u16 port and a String admin_email;'
        + ' (2) serve GET /config on an axum router, returning the config as JSON;'
        + ' (3) return HTTP 400 with a JSON error body when config.json fails to parse;'
        + ' (4) cover all three of those with tests in tests/config.rs that pass under `cargo test`.',
    hs:
        'Build a small config service in Haskell. It must:'
        + ' (1) read config.json from the project root and decode it with aeson into a Config'
        + ' record holding a Text name, an Int port and a Text adminEmail;'
        + ' (2) serve GET /config with scotty, returning the config as JSON;'
        + ' (3) return HTTP 400 with a JSON error body when config.json fails to decode;'
        + ' (4) cover all three of those with tests in test/Spec.hs that pass under `cabal test`.'
}

/** A valid config every project reads, so the happy path needs no invention. */
const CONFIG_JSON = JSON.stringify(
    {name: 'live-docs-check', port: 8123, adminEmail: 'ops@example.com'},
    null,
    2
)

function write(root: string, rel: string, body: string): void {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), {recursive: true})
    fs.writeFileSync(full, body.endsWith('\n') ? body : `${body}\n`, 'utf8')
}

function run(cmd: string, args: string[], cwd: string): void {
    execFileSync(cmd, args, {cwd, stdio: 'inherit', env: process.env})
}

function seedTs(root: string, pins: Record<string, string>): void {
    write(
        root,
        'package.json',
        JSON.stringify(
            {
                name: 'docs-live-ts',
                private: true,
                type: 'module',
                dependencies: {zod: pins.zod, hono: pins.hono}
            },
            null,
            2
        )
    )
    write(root, 'config.json', CONFIG_JSON)
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], root)
}

function seedRs(root: string, pins: Record<string, string>): void {
    write(
        root,
        'Cargo.toml',
        [
            '[package]',
            'name = "docs-live-rs"',
            'version = "0.1.0"',
            'edition = "2021"',
            '',
            '[dependencies]',
            `axum = "${pins.axum}"`,
            `tokio = { version = "${pins.tokio}", features = ["full"] }`,
            `serde_json = "${pins.serde_json}"`,
            'serde = { version = "1", features = ["derive"] }'
        ].join('\n')
    )
    // cargo refuses to resolve a package with no target at all.
    write(root, 'src/main.rs', 'fn main() {}')
    write(root, 'config.json', CONFIG_JSON)
    run('cargo', ['fetch'], root)
}

function seedHs(root: string, pins: Record<string, string>): void {
    write(
        root,
        'docs-live-hs.cabal',
        [
            'cabal-version:      2.4',
            'name:               docs-live-hs',
            'version:            0.1.0.0',
            'build-type:         Simple',
            '',
            'executable docs-live-hs',
            '    main-is:          Main.hs',
            '    hs-source-dirs:   app',
            '    build-depends:    base, text,',
            `                      aeson ==${pins.aeson},`,
            `                      scotty ==${pins.scotty}`,
            '    default-language: Haskell2010',
            '',
            'test-suite spec',
            '    type:             exitcode-stdio-1.0',
            '    main-is:          Spec.hs',
            '    hs-source-dirs:   test',
            '    build-depends:    base, text, hspec,',
            `                      aeson ==${pins.aeson},`,
            `                      scotty ==${pins.scotty}`,
            '    default-language: Haskell2010'
        ].join('\n')
    )
    write(root, 'app/Main.hs', 'main :: IO ()\nmain = pure ()')
    write(root, 'test/Spec.hs', 'main :: IO ()\nmain = pure ()')
    write(root, 'config.json', CONFIG_JSON)
    run('cabal', ['build', '--dependencies-only', 'all'], root)
}

const SEEDERS: Record<ProjectSpec['id'], (root: string, pins: Record<string, string>) => void> = {
    ts: seedTs,
    rs: seedRs,
    hs: seedHs
}

/**
 * A git repo per fixture, because autoCommit is on in the runner and a task-auto
 * run with no repo behaves differently from every real one.
 */
function initGit(root: string): void {
    run('git', ['init', '-q'], root)
    run('git', ['config', 'user.email', 'live@example.com'], root)
    run('git', ['config', 'user.name', 'docs live'], root)
    run('git', ['add', '-A'], root)
    run('git', ['commit', '-q', '-m', 'seed'], root)
}

function seed(runRoot: string, only: ReadonlySet<string>): void {
    for (const spec of PROJECTS) {
        if (only.size > 0 && !only.has(spec.id)) continue
        const root = path.join(runRoot, spec.id)
        fs.rmSync(root, {recursive: true, force: true})
        fs.mkdirSync(root, {recursive: true})
        console.log(`\n=== ${spec.id} (${spec.ecosystem}) → ${root}`)
        SEEDERS[spec.id](root, spec.pins)
        write(root, 'FEATURE.txt', FEATURES[spec.id])
        initGit(root)
        const pins = Object.entries(spec.pins)
            .map(([k, v]) => `${k}@${v}`)
            .join(' ')
        console.log(`    pinned ${pins}`)
    }
}

if (import.meta.main) {
    const [runRoot, ...ids] = process.argv.slice(2)
    if (!runRoot) {
        console.error('usage: bun scripts/docs-live-seed.ts <run-root> [ts] [rs] [hs]')
        process.exit(1)
    }
    seed(runRoot, new Set(ids))
}
