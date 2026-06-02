import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {resolvePackage, ResolveError} from './docs-resolve.js'

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
