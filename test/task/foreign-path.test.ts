import {describe, expect, test} from 'bun:test'
import {
    applyForeignPathRepairs,
    findForeignPaths,
    foreignPathDefectText,
    foreignPathVerifyFindings,
    relativeRepairFor,
    repairForeignPaths,
    resolveRepoPath
} from '../../src/task/foreign-path.js'

/** A synthetic repo tree mirroring the shape of the real mx5 run-13 checkout. */
const REPO = new Set([
    'src/shared',
    'src/shared/types.ts',
    'src/client',
    'src/client/api.ts',
    'src/client/pages',
    'src/server',
    'src/server/index.ts',
    'playwright',
    'playwright/index.html',
    'dist',
    'package.json',
    'playwright-ct.config.ts'
])

const inRepo = (rel: string): boolean => REPO.has(rel)
/** Nothing under a foreign mount exists here; a few real system paths do. */
const onHost = (abs: string): boolean =>
    ['/usr/bin/env', '/etc/nginx/nginx.conf', '/var/log'].includes(abs)

const scan = (file: string, ...texts: string[]) =>
    findForeignPaths(
        texts.map(text => ({path: file, text})),
        onHost,
        inRepo
    )

describe('findForeignPaths — the real mx5 run-13 true positive', () => {
    // Verbatim from ~/hub/mx5/playwright-ct.config.ts L15-16, the leak that made
    // `bun run test:ct` collect 63 tests and run 0 (ENOENT at build time).
    const CONFIG_LINES = [
        "          '../../shared': '/workspace/src/shared',",
        "          '../api': '/workspace/src/client/api',"
    ]

    test('flags both leaked vite aliases', () => {
        const f = scan('playwright-ct.config.ts', ...CONFIG_LINES)
        expect(f).toHaveLength(2)
        expect(f.map(x => x.absolute)).toEqual([
            '/workspace/src/shared',
            '/workspace/src/client/api'
        ])
    })

    test('names the smallest foreign prefix and the real repo target', () => {
        const [shared, api] = scan('playwright-ct.config.ts', ...CONFIG_LINES)
        expect(shared.foreignPrefix).toBe('/workspace')
        expect(shared.repoPath).toBe('src/shared')
        // The extensionless module specifier must resolve — `src/client/api` is a
        // directory nowhere in the tree, only `src/client/api.ts` exists. Without
        // extension probing this true positive is silently missed.
        expect(api.foreignPrefix).toBe('/workspace')
        expect(api.repoPath).toBe('src/client/api.ts')
    })

    test('repairs to a file-relative path that actually resolves', () => {
        const f = scan('playwright-ct.config.ts', ...CONFIG_LINES)
        expect(relativeRepairFor(f[0])).toBe('./src/shared')
        expect(relativeRepairFor(f[1])).toBe('./src/client/api.ts')
    })

    test('repair is a literal substitution, leaving the rest of the line intact', () => {
        const text = ['export default {', ...CONFIG_LINES, '}'].join('\n')
        const f = scan('playwright-ct.config.ts', ...CONFIG_LINES)
        const {text: fixed, applied} = applyForeignPathRepairs(text, f)
        expect(applied).toHaveLength(2)
        expect(fixed).toContain("'../../shared': './src/shared',")
        expect(fixed).toContain("'../api': './src/client/api.ts',")
        expect(fixed).not.toContain('/workspace')
    })
})

describe('findForeignPaths — repair geometry', () => {
    test('rewrites relative to the FILE, not the repo root', () => {
        const f = findForeignPaths(
            [{path: 'src/client/pages/x.ts', text: "import '/workspace/src/shared/types.ts'"}],
            onHost,
            inRepo
        )
        expect(f).toHaveLength(1)
        expect(relativeRepairFor(f[0])).toBe('../../shared/types.ts')
    })

    test('longest-first ordering keeps a prefix repair from clobbering a longer one', () => {
        // `/workspace/src/shared` is a strict prefix of `/workspace/src/shared/types.ts`;
        // repairing the short one first would corrupt the long one mid-string.
        const lines = ["a: '/workspace/src/shared'", "b: '/workspace/src/shared/types.ts'"]
        const f = findForeignPaths(
            lines.map(text => ({path: 'cfg.ts', text})),
            onHost,
            inRepo
        )
        expect(f).toHaveLength(2)
        const {text: fixed} = applyForeignPathRepairs(lines.join('\n'), f)
        expect(fixed).toContain("a: './src/shared'")
        expect(fixed).toContain("b: './src/shared/types.ts'")
    })

    test('a finding whose literal is already gone is skipped, not misapplied', () => {
        const f = scan('cfg.ts', "x: '/workspace/src/shared'")
        const {text, applied} = applyForeignPathRepairs('unrelated content', f)
        expect(applied).toHaveLength(0)
        expect(text).toBe('unrelated content')
    })
})

describe('findForeignPaths — false-positive guards', () => {
    test('does NOT flag absolute paths that exist on this host', () => {
        expect(scan('run.sh', '#!/usr/bin/env bash')).toHaveLength(0)
        expect(scan('cfg.ts', "const c = '/etc/nginx/nginx.conf'")).toHaveLength(0)
    })

    test('does NOT flag absolute paths with no counterpart in the repo', () => {
        // The deploy/system paths a real project legitimately hardcodes. None has a
        // repo tail, so none can be a sandbox leak.
        for (const line of [
            "root: '/var/www/html'",
            "socket: '/run/postgresql/.s.PGSQL.5432'",
            "logfile: '/opt/myapp/logs/app.log'",
            "cert: '/etc/letsencrypt/live/example.com/fullchain.pem'"
        ]) {
            expect(scan('cfg.ts', line)).toHaveLength(0)
        }
    })

    test('does NOT match URL paths or relative paths', () => {
        for (const line of [
            "fetch('https://api.example.com/src/shared')",
            "fetch('http://localhost:3000/src/client/api')",
            "import x from '../src/shared'",
            "import y from 'src/shared/types.ts'",
            "const p = 'pkg://src/shared'"
        ]) {
            expect(scan('cfg.ts', line)).toHaveLength(0)
        }
    })

    test('does NOT flag single-segment absolute paths', () => {
        expect(scan('cfg.ts', "d: '/workspace'")).toHaveLength(0)
    })

    test('container manifests declare container paths — never a leak there', () => {
        const line = 'WORKDIR /workspace/src/shared'
        expect(scan('Dockerfile', line)).toHaveLength(0)
        expect(scan('deploy/Dockerfile.prod', line)).toHaveLength(0)
        expect(scan('docker-compose.yml', "    - './x:/workspace/src/shared'")).toHaveLength(0)
        expect(scan('.devcontainer/devcontainer.json', line)).toHaveLength(0)
        // ...but the same string in ordinary source still fires.
        expect(scan('cfg.ts', "x: '/workspace/src/shared'")).toHaveLength(1)
    })

    test('generated / vendored / lockfile paths are out of scope', () => {
        const line = "x: '/workspace/src/shared'"
        expect(scan('node_modules/pkg/index.js', line)).toHaveLength(0)
        expect(scan('dist/bundle.js', line)).toHaveLength(0)
        expect(scan('package-lock.json', line)).toHaveLength(0)
    })

    // The three classes the real-repo FP suite caught before wiring
    // (scripts/foreign-path-fp-suite.ts). Each is pinned here so a future pattern
    // change cannot silently reintroduce it.
    test('tool caches and reports are out of scope (FP suite catch #1)', () => {
        // mx5's committed .playwright-cache/metainfo.json records the sandbox path
        // of all 38 modules the CT runner compiled — a faithful log of a past
        // build, not an authored decision.
        const line = '"filename": "/workspace/src/client/pages/Admin.tsx",'
        expect(scan('.playwright-cache/metainfo.json', line)).toHaveLength(0)
        expect(scan('test-results/out.json', line)).toHaveLength(0)
        expect(scan('playwright-report/data.json', line)).toHaveLength(0)
        expect(scan('.vite/deps/x.js', line)).toHaveLength(0)
    })

    test('a `.`/`..` tail resolves to the repo root and is evidence of nothing (catch #2)', () => {
        // pi-task's own scripts/ab-planning.ts documents a scratch dir as
        // `/tmp/pi-task-ab/.` — whose tail "resolves" to `.`, true of every repo.
        expect(scan('scripts/ab.ts', ' * /tmp/pi-task-ab/.')).toHaveLength(0)
        expect(scan('cfg.ts', "x: '/workspace/src/shared/..'")).toHaveLength(0)
    })

    test('a whole-line comment mentions paths, it does not resolve them (catch #4)', () => {
        // This module's own documentation discusses `/workspace/...` in comments.
        for (const line of [
            '// environment (/workspace/src/shared) that resolve nowhere here',
            ' * leaked prefix /workspace/src/shared',
            '# see /workspace/src/shared',
            '<!-- /workspace/src/shared -->'
        ]) {
            expect(scan('src/task/x.ts', line)).toHaveLength(0)
        }
        // A trailing comment on a live code line is NOT a pass — the code runs.
        expect(scan('cfg.ts', "x: '/workspace/src/shared', // the alias")).toHaveLength(1)
    })

    test('a backticked path is being named, not used (catch #5)', () => {
        // Prompt text and error messages cite paths in markdown backticks.
        expect(scan('src/task/prompt.ts', "'  `/workspace/src/shared` is a leak',")).toHaveLength(0)
        // Without the backticks, the same string is a real path value.
        expect(scan('src/task/prompt.ts', "'  /workspace/src/shared',")).toHaveLength(1)
    })

    test('a single generic extensionless tail is too weak to be evidence (catch #6)', () => {
        // Nearly every repo has `src`, so nearly any absolute path would "resolve".
        expect(scan('cfg.ts', "note: '/home/someone/proj/src'")).toHaveLength(0)
        expect(scan('cfg.ts', "note: '/other/dist'")).toHaveLength(0)
        // A nested tail, or a concrete filename, still fires.
        expect(scan('cfg.ts', "note: '/other/src/shared'")).toHaveLength(1)
        expect(
            findForeignPaths(
                [{path: 'cfg.ts', text: "note: '/other/package.json'"}],
                onHost,
                inRepo
            )
        ).toHaveLength(1)
    })

    test('test files carry synthetic absolute paths as fixtures (catch #3)', () => {
        // pi-task's single-read-guard.test.ts asserts on the literal string
        // '/workspace/package.json'. Excluding tests is the safe direction: a leak
        // that breaks a build lives in source or config.
        const line = "const msg = check('/workspace/src/shared')"
        expect(scan('src/workers/guard.test.ts', line)).toHaveLength(0)
        expect(scan('src/client/pages/Admin.spec.tsx', line)).toHaveLength(0)
        expect(scan('tests/helpers.ts', line)).toHaveLength(0)
        // ...but the same line in ordinary source still fires.
        expect(scan('src/workers/guard.ts', line)).toHaveLength(1)
    })

    test('non-source extensions are not scanned', () => {
        expect(scan('notes.md', "see '/workspace/src/shared'")).toHaveLength(0)
        expect(scan('logo.png', "'/workspace/src/shared'")).toHaveLength(0)
    })

    test('the same leak on two lines of one file is reported once', () => {
        const f = scan('cfg.ts', "a: '/workspace/src/shared'", "b: '/workspace/src/shared'")
        expect(f).toHaveLength(1)
    })
})

describe('repairForeignPaths', () => {
    const io = (files: Map<string, string>) => ({
        readFile: (rel: string) =>
            files.has(rel) ? Promise.resolve(files.get(rel)!) : Promise.reject(new Error('ENOENT')),
        writeFile: (rel: string, text: string) => {
            files.set(rel, text)
            return Promise.resolve()
        },
        existsInRepo: inRepo
    })

    test('writes the repair and reports it', async () => {
        const files = new Map([
            ['playwright-ct.config.ts', "alias: {'../../shared': '/workspace/src/shared'}"]
        ])
        const f = scan(
            'playwright-ct.config.ts',
            "alias: {'../../shared': '/workspace/src/shared'}"
        )
        const r = await repairForeignPaths(f, io(files))
        expect(r.remaining).toHaveLength(0)
        expect(r.repaired).toEqual([
            'playwright-ct.config.ts: `/workspace/src/shared` → `./src/shared`'
        ])
        expect(files.get('playwright-ct.config.ts')).toBe("alias: {'../../shared': './src/shared'}")
    })

    test('groups multiple leaks in one file into a single write', async () => {
        const text = ["a: '/workspace/src/shared',", "b: '/workspace/src/client/api',"].join('\n')
        const files = new Map([['cfg.ts', text]])
        const f = findForeignPaths(
            text.split('\n').map(t => ({path: 'cfg.ts', text: t})),
            onHost,
            inRepo
        )
        const r = await repairForeignPaths(f, io(files))
        expect(r.repaired).toHaveLength(2)
        expect(files.get('cfg.ts')).toBe(
            ["a: './src/shared',", "b: './src/client/api.ts',"].join('\n')
        )
    })

    test('an unreadable file is left alone and its finding survives to verify', async () => {
        const f = scan('gone.ts', "x: '/workspace/src/shared'")
        const r = await repairForeignPaths(f, io(new Map()))
        expect(r.repaired).toHaveLength(0)
        expect(r.remaining).toEqual(f)
    })

    test('a repair that does not re-resolve is dropped, not written', async () => {
        const files = new Map([['cfg.ts', "x: '/workspace/src/shared'"]])
        const f = scan('cfg.ts', "x: '/workspace/src/shared'")
        // The tree disappears underneath the repair — re-validation must catch it.
        const r = await repairForeignPaths(f, {...io(files), existsInRepo: () => false})
        expect(r.repaired).toHaveLength(0)
        expect(r.remaining).toEqual(f)
        expect(files.get('cfg.ts')).toBe("x: '/workspace/src/shared'")
    })

    test('a write failure leaves the finding for verify', async () => {
        const f = scan('cfg.ts', "x: '/workspace/src/shared'")
        const r = await repairForeignPaths(f, {
            readFile: () => Promise.resolve("x: '/workspace/src/shared'"),
            writeFile: () => Promise.reject(new Error('EROFS')),
            existsInRepo: inRepo
        })
        expect(r.repaired).toHaveLength(0)
        expect(r.remaining).toEqual(f)
    })

    test('no findings → no reads, no writes', async () => {
        const r = await repairForeignPaths([], {
            readFile: () => Promise.reject(new Error('should not read')),
            writeFile: () => Promise.reject(new Error('should not write')),
            existsInRepo: inRepo
        })
        expect(r).toEqual({repaired: [], remaining: []})
    })
})

describe('resolveRepoPath', () => {
    test('resolves exact, extensionless, and index forms', () => {
        expect(resolveRepoPath('src/shared', inRepo)).toBe('src/shared')
        expect(resolveRepoPath('src/client/api', inRepo)).toBe('src/client/api.ts')
        expect(resolveRepoPath('lib', rel => rel === 'lib/index.ts')).toBe('lib/index.ts')
    })

    test('returns null when nothing resolves', () => {
        expect(resolveRepoPath('nope/missing', inRepo)).toBeNull()
    })
})

describe('rendering', () => {
    test('verify findings name file, leaked path, and real target', () => {
        const [line] = foreignPathVerifyFindings(scan('cfg.ts', "x: '/workspace/src/shared'"))
        expect(line).toContain('cfg.ts')
        expect(line).toContain('/workspace/src/shared')
        expect(line).toContain('src/shared')
        expect(line).toContain('does not exist on this machine')
    })

    test('defect text carries a numbered repair per finding', () => {
        const text = foreignPathDefectText(scan('cfg.ts', "x: '/workspace/src/shared'"))
        expect(text).toContain('SANDBOX PATH LEAK')
        expect(text).toContain('1. cfg.ts')
        expect(text).toContain('./src/shared')
    })

    test('empty findings render an empty verify block', () => {
        expect(foreignPathVerifyFindings([])).toEqual([])
    })
})
