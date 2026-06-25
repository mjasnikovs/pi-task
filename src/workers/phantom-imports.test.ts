import {test, expect} from 'bun:test'
import {
    extractRuntimeSpecifiers,
    classifyRuntimeImport,
    findPhantomImports,
    formatApiCorrections,
    rewritePhantomSpecifiers
} from './phantom-imports.js'

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

test('findPhantomImports flags only the unverifiable specifiers (injected loader)', () => {
    const text = 'Use bun:sql for the DB, bun:sqlite for tests, bun:nope for nothing.'
    const phantoms = findPhantomImports(text, '/irrelevant', () => TYPES)
    expect(phantoms.map(p => p.spec)).toEqual(['bun:sql', 'bun:nope'])
    expect(phantoms[0].suggestion).toContain('import { sql } from "bun"')
    expect(phantoms[1].suggestion).toContain('bun:ffi, bun:sqlite, bun:test')
})

test('findPhantomImports skips a runtime whose types cannot be loaded (never flag unverifiable)', () => {
    const phantoms = findPhantomImports('use bun:sql', '/irrelevant', () => null)
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

test('rewritePhantomSpecifiers strikes all four syntactic forms', () => {
    const phantoms = findPhantomImports('bun:sql', '/x', () => TYPES)
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

test('rewritePhantomSpecifiers is idempotent and a no-op when nothing is flagged', () => {
    const phantoms = findPhantomImports('use bun:sql', '/x', () => TYPES)
    const once = rewritePhantomSpecifiers('use bun:sql now', phantoms)
    expect(rewritePhantomSpecifiers(once, phantoms)).toBe(once)
    expect(rewritePhantomSpecifiers('use zod and react', [])).toBe('use zod and react')
})
