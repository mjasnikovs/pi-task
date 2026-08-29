import {test, expect} from 'bun:test'
import {
    extractRuntimeSpecifiers,
    classifyRuntimeImport,
    findPhantomImports,
    formatApiCorrections,
    formatApiOverrideBanner,
    findDeliveryPhantoms,
    rewritePhantomSpecifiers
} from '../../src/workers/phantom-imports.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

const TYPES = `
declare module "bun" {
  const sql: SQL;
  class SQL {}
}
declare module "bun:sqlite" {}
declare module "bun:test" {}
declare module "bun:ffi" {}
`

test('extractRuntimeSpecifiers finds distinct bun:/node:/deno: specifiers, in order', () => {
    const got = extractRuntimeSpecifiers(
        'use bun:sql and node:fs/promises and bun:sql again, not zod or react'
    )
    expect(got).toEqual(['bun:sql', 'node:fs/promises'])
})

test('extractRuntimeSpecifiers ignores ordinary and scoped package names', () => {
    expect(extractRuntimeSpecifiers('import zod, @hono/zod-validator, react/jsx-runtime')).toEqual(
        []
    )
})

test('classifyRuntimeImport: a declared submodule is real', () => {
    const v = classifyRuntimeImport('bun:sqlite', 'bun', 'sqlite', TYPES)
    expect(v.real).toBe(true)
    expect(v.baseSymbol).toBeNull()
})

test('classifyRuntimeImport: an undeclared submodule is phantom and finds the base symbol', () => {
    const v = classifyRuntimeImport('bun:sql', 'bun', 'sql', TYPES)
    expect(v.real).toBe(false)
    // Case-insensitive: matches `const sql` or `class SQL`.
    expect(v.baseSymbol?.toLowerCase()).toBe('sql')
    expect(v.realModules).toEqual(['bun:ffi', 'bun:sqlite', 'bun:test'])
})

test('classifyRuntimeImport: phantom with no base symbol falls back to the module list', () => {
    const v = classifyRuntimeImport('bun:nope', 'bun', 'nope', TYPES)
    expect(v.real).toBe(false)
    expect(v.baseSymbol).toBeNull()
})

test('findPhantomImports flags only the unverifiable specifiers (injected loader)', async () => {
    const text = 'Use bun:sql for the DB, bun:sqlite for tests, bun:nope for nothing.'
    const phantoms = await findPhantomImports(text, '/irrelevant', () => TYPES)
    expect(phantoms.map(p => p.spec)).toEqual(['bun:sql', 'bun:nope'])
    expect(phantoms[0].suggestion).toContain('import { sql } from "bun"')
    expect(phantoms[1].suggestion).toContain('bun:ffi, bun:sqlite, bun:test')
})

test('findPhantomImports skips a runtime whose types cannot be loaded (never flag unverifiable)', async () => {
    const phantoms = await findPhantomImports('use bun:sql', '/irrelevant', () => null)
    expect(phantoms).toEqual([])
})

test('formatApiCorrections renders a section, or empty string when clean', () => {
    expect(formatApiCorrections([])).toBe('')
    const block = formatApiCorrections([
        {spec: 'bun:sql', realModules: [], suggestion: 'X is not a module', baseSymbol: 'sql'}
    ])
    expect(block.startsWith('API CORRECTIONS\n')).toBe(true)
    expect(block).toContain('  - X is not a module')
})

test('formatApiOverrideBanner: top banner that supersedes the doc, or empty when clean', () => {
    expect(formatApiOverrideBanner([])).toBe('')
    const banner = formatApiOverrideBanner([
        {
            spec: 'bun:sql',
            realModules: [],
            suggestion: '`bun:sql` is NOT a module — use `import { SQL } from "bun"`',
            baseSymbol: 'SQL'
        }
    ])
    expect(banner.startsWith('VERIFIED API OVERRIDES')).toBe(true)
    expect(banner).toContain('SUPERSEDE the spec')
    expect(banner).toContain('import { SQL } from "bun"')
    expect(banner).toContain('declare module') // the explicit "never add a shim" clause
})

// Lay down a resolvable `bun` types stub so the REAL loader flags bun:sql as phantom.
async function withStubbedBun(fn: (dir: string) => void | Promise<void>): Promise<void> {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'phantom-deliv-'))
    const pkg = nodePath.join(dir, 'node_modules', 'bun')
    fs.mkdirSync(pkg, {recursive: true})
    fs.writeFileSync(
        nodePath.join(pkg, 'package.json'),
        JSON.stringify({name: 'bun', version: '1.0.0', types: 'index.d.ts'})
    )
    fs.writeFileSync(
        nodePath.join(pkg, 'index.d.ts'),
        'export class SQL {}\nexport const sql: SQL\ndeclare module "bun:test" {}\n'
    )
    try {
        await fn(dir)
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

test('findDeliveryPhantoms: flags an affirmative bun:sql in the spec text itself', async () => {
    await withStubbedBun(async dir => {
        const phantoms = await findDeliveryPhantoms('Connect using the `bun:sql` driver.', dir)
        expect(phantoms.map(p => p.spec)).toEqual(['bun:sql'])
    })
})

test('findDeliveryPhantoms: flags bun:sql reached only via an @-referenced design doc', async () => {
    await withStubbedBun(async dir => {
        fs.writeFileSync(
            nodePath.join(dir, 'DESIGN.md'),
            '# Design\nDB access via `bun:sql` built-in driver.'
        )
        // The spec itself is clean — the phantom lives only in the doc pi re-expands.
        const phantoms = await findDeliveryPhantoms('Implement the DB layer per @DESIGN.md', dir)
        expect(phantoms.map(p => p.spec)).toEqual(['bun:sql'])
    })
})

test('findDeliveryPhantoms: clean spec + no phantom doc -> empty', async () => {
    await withStubbedBun(async dir => {
        expect(
            await findDeliveryPhantoms('Use `import { SQL } from "bun"` for the DB.', dir)
        ).toEqual([])
    })
})

test('rewritePhantomSpecifiers strikes all four syntactic forms', async () => {
    const phantoms = await findPhantomImports('bun:sql', '/x', () => TYPES)
    const text = [
        'import { x } from "bun:sql"',
        'const c = require("bun:sql")',
        'declare module "bun:sql" {}',
        'the `bun:sql` driver',
        '| PostgreSQL driver | bun:sql | pg |'
    ].join('\n')
    const out = rewritePhantomSpecifiers(text, phantoms)
    expect(out).not.toContain('"bun:sql"') // import/require/declare quotes rewritten
    expect(out).not.toContain('`bun:sql`') // backticked mention rewritten
    expect(out).toContain('from "bun"')
    expect(out).toContain('require("bun")')
    expect(out).toContain('/* not a module — use') // declare-module → comment
    expect(out).toContain('`import { sql } from "bun"`') // backtick → canonical
    expect(out).toContain('| import { sql } from "bun" | pg |') // bare word in table cell
})

test('rewritePhantomSpecifiers is idempotent and a no-op when nothing is flagged', async () => {
    const phantoms = await findPhantomImports('use bun:sql', '/x', () => TYPES)
    const once = rewritePhantomSpecifiers('use bun:sql now', phantoms)
    expect(rewritePhantomSpecifiers(once, phantoms)).toBe(once)
    expect(rewritePhantomSpecifiers('use zod and react', [])).toBe('use zod and react')
})
