import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {
    resolvePackage,
    ResolveError,
    isDtsFile,
    typesPackageName,
    hasTypeFiles,
    detectTypesRedirect,
    splitRuntimeNamespace
} from './docs-resolve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

test('resolvePackage returns name, version, root, entryDts, readme for tiny-pkg', () => {
    const r = resolvePackage('tiny-pkg', FIXTURES)
    expect(r.name).toBe('tiny-pkg')
    expect(r.version).toBe('1.0.0')
    expect(r.root.endsWith('node_modules/tiny-pkg')).toBe(true)
    expect(r.entryDts?.endsWith('node_modules/tiny-pkg/index.d.ts')).toBe(true)
    expect(r.readme?.endsWith('node_modules/tiny-pkg/README.md')).toBe(true)
})

test('resolvePackage handles scoped packages', () => {
    const r = resolvePackage('@scope/scoped-pkg', FIXTURES)
    expect(r.name).toBe('@scope/scoped-pkg')
    expect(r.version).toBe('0.2.1')
    expect(r.entryDts?.endsWith('node_modules/@scope/scoped-pkg/index.d.ts')).toBe(true)
    expect(r.readme).toBeNull()
})

test('resolvePackage handles subpath but preserves parent name', () => {
    const r = resolvePackage('tiny-pkg/sub', FIXTURES)
    expect(r.name).toBe('tiny-pkg')
    expect(r.version).toBe('1.0.0')
    // entryDts should resolve to the subpath file
    expect(r.entryDts?.endsWith('node_modules/tiny-pkg/sub.d.ts')).toBe(true)
})

test('resolvePackage handles modern exports field', () => {
    const r = resolvePackage('modern-pkg', FIXTURES)
    expect(r.name).toBe('modern-pkg')
    expect(r.version).toBe('2.0.0')
    expect(r.entryDts?.endsWith('node_modules/modern-pkg/dist/index.d.ts')).toBe(true)
})

test('resolvePackage falls back to <root>/index.d.ts when types field absent', () => {
    const r = resolvePackage('legacy-pkg', FIXTURES)
    expect(r.entryDts?.endsWith('node_modules/legacy-pkg/index.d.ts')).toBe(true)
})

test('resolvePackage returns entryDts=null for package with no types', () => {
    const r = resolvePackage('no-types-pkg', FIXTURES)
    expect(r.entryDts).toBeNull()
    expect(r.readme?.endsWith('node_modules/no-types-pkg/README.md')).toBe(true)
})

test('resolvePackage returns both null for empty-pkg', () => {
    const r = resolvePackage('empty-pkg', FIXTURES)
    expect(r.entryDts).toBeNull()
    expect(r.readme).toBeNull()
})

test('resolvePackage throws ResolveError(not_installed) for missing package', () => {
    try {
        resolvePackage('does-not-exist', FIXTURES)
        throw new Error('expected throw')
    } catch (err) {
        expect(err).toBeInstanceOf(ResolveError)
        expect((err as ResolveError).kind).toBe('not_installed')
    }
})

test('isDtsFile matches .d.ts, .d.mts, .d.cts only', () => {
    expect(isDtsFile('foo.d.ts')).toBe(true)
    expect(isDtsFile('foo.d.mts')).toBe(true)
    expect(isDtsFile('foo.d.cts')).toBe(true)
    expect(isDtsFile('foo.ts')).toBe(false)
    expect(isDtsFile('foo.mts')).toBe(false)
    expect(isDtsFile('foo.d.ts.map')).toBe(false)
})

test('splitRuntimeNamespace splits bun:/node: builtin specifiers to their runtime', () => {
    expect(splitRuntimeNamespace('bun:sql')).toEqual({runtime: 'bun', sub: 'sql'})
    expect(splitRuntimeNamespace('bun:sqlite')).toEqual({runtime: 'bun', sub: 'sqlite'})
    expect(splitRuntimeNamespace('node:fs/promises')).toEqual({runtime: 'node', sub: 'fs/promises'})
})

test('splitRuntimeNamespace returns null for ordinary and scoped package names', () => {
    expect(splitRuntimeNamespace('bun')).toBeNull()
    expect(splitRuntimeNamespace('zod')).toBeNull()
    expect(splitRuntimeNamespace('@hono/zod-validator')).toBeNull()
    expect(splitRuntimeNamespace('react/jsx-runtime')).toBeNull()
    // A colon-prefix from an unknown runtime is not treated as a builtin namespace.
    expect(splitRuntimeNamespace('http:foo')).toBeNull()
})

test('typesPackageName maps to DefinitelyTyped convention', () => {
    expect(typesPackageName('bun')).toBe('@types/bun')
    expect(typesPackageName('react/jsx-runtime')).toBe('@types/react')
    expect(typesPackageName('@radix-ui/react-dialog')).toBe('@types/radix-ui__react-dialog')
    expect(typesPackageName('@types/bun')).toBeNull()
})

test('resolvePackage picks a .d.mts types entry (tailwindcss shape)', () => {
    const r = resolvePackage('mts-pkg', FIXTURES)
    expect(r.entryDts?.endsWith('node_modules/mts-pkg/dist/lib.d.mts')).toBe(true)
})

test('hasTypeFiles is false for a launcher package with no declarations', () => {
    expect(hasTypeFiles(resolvePackage('launcher-pkg', FIXTURES).root)).toBe(false)
    expect(hasTypeFiles(resolvePackage('mts-pkg', FIXTURES).root)).toBe(true)
})

test('detectTypesRedirect follows a pure @types redirect stub', () => {
    // stub-pkg is `/// <reference types="target-types" />` only
    expect(detectTypesRedirect(resolvePackage('stub-pkg', FIXTURES))).toBe('target-types')
})

test('detectTypesRedirect returns null for an aggregator package', () => {
    // target-types references node + local paths and ships its own .d.ts files
    expect(detectTypesRedirect(resolvePackage('target-types', FIXTURES))).toBeNull()
})

test.each(['../etc/passwd', '/abs/path', 'pkg with spaces', '', '@scope/', '@/name'])(
    'resolvePackage throws ResolveError(invalid_name) for %p',
    bad => {
        try {
            resolvePackage(bad, FIXTURES)
            throw new Error('expected throw')
        } catch (err) {
            expect(err).toBeInstanceOf(ResolveError)
            expect((err as ResolveError).kind).toBe('invalid_name')
        }
    }
)
