import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {
    resolvePackage,
    ResolveError,
    isDtsFile,
    typesPackageName,
    hasTypeFiles,
    detectTypesRedirect,
    countEntryDeclarations,
    splitRuntimeNamespace,
    resolveTypeSource,
    type ResolvedPackage
} from './docs-resolve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

// resolvePackage returns native filesystem paths (backslashes on Windows). These
// suffix assertions are written POSIX-style, so normalize separators first.
const norm = (s: string | null | undefined): string => (s ?? '').replace(/\\/g, '/')

test('resolvePackage returns name, version, root, entryDts, readme for tiny-pkg', () => {
    const r = resolvePackage('tiny-pkg', FIXTURES)
    expect(r.name).toBe('tiny-pkg')
    expect(r.version).toBe('1.0.0')
    expect(norm(r.root).endsWith('node_modules/tiny-pkg')).toBe(true)
    expect(norm(r.entryDts).endsWith('node_modules/tiny-pkg/index.d.ts')).toBe(true)
    expect(norm(r.readme).endsWith('node_modules/tiny-pkg/README.md')).toBe(true)
})

test('resolvePackage handles scoped packages', () => {
    const r = resolvePackage('@scope/scoped-pkg', FIXTURES)
    expect(r.name).toBe('@scope/scoped-pkg')
    expect(r.version).toBe('0.2.1')
    expect(norm(r.entryDts).endsWith('node_modules/@scope/scoped-pkg/index.d.ts')).toBe(true)
    expect(r.readme).toBeNull()
})

test('resolvePackage handles subpath but preserves parent name', () => {
    const r = resolvePackage('tiny-pkg/sub', FIXTURES)
    expect(r.name).toBe('tiny-pkg')
    expect(r.version).toBe('1.0.0')
    // entryDts should resolve to the subpath file
    expect(norm(r.entryDts).endsWith('node_modules/tiny-pkg/sub.d.ts')).toBe(true)
})

test('resolvePackage handles modern exports field', () => {
    const r = resolvePackage('modern-pkg', FIXTURES)
    expect(r.name).toBe('modern-pkg')
    expect(r.version).toBe('2.0.0')
    expect(norm(r.entryDts).endsWith('node_modules/modern-pkg/dist/index.d.ts')).toBe(true)
})

test('resolvePackage falls back to <root>/index.d.ts when types field absent', () => {
    const r = resolvePackage('legacy-pkg', FIXTURES)
    expect(norm(r.entryDts).endsWith('node_modules/legacy-pkg/index.d.ts')).toBe(true)
})

test('resolvePackage returns entryDts=null for package with no types', () => {
    const r = resolvePackage('no-types-pkg', FIXTURES)
    expect(r.entryDts).toBeNull()
    expect(norm(r.readme).endsWith('node_modules/no-types-pkg/README.md')).toBe(true)
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
    expect(norm(r.entryDts).endsWith('node_modules/mts-pkg/dist/lib.d.mts')).toBe(true)
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

// --- the empty-entry rule (nexttask 1) ---------------------------------------
// `sharp` ships ONE 1971-line .d.ts whose line 28 is `/// <reference types="node" />`.
// The file-count guard cannot tell that apart from `@types/bun`'s one-line stub, so
// every sharp question in mx5 run 19 was answered out of @types/node (tty.d.ts,
// zlib.d.ts). The discriminator is what is IN the entry file, not how many there are.

test('detectTypesRedirect does not follow an ambient `reference types` in a package that declares its own API', () => {
    expect(detectTypesRedirect(resolvePackage('ambient-pkg', FIXTURES))).toBeNull()
})

test('detectTypesRedirect still follows a pointer-only `export * from` stub', () => {
    expect(detectTypesRedirect(resolvePackage('reexport-stub', FIXTURES))).toBe('target-types')
})

test('detectTypesRedirect does not follow `export * from` when the entry also declares', () => {
    expect(detectTypesRedirect(resolvePackage('reexport-decl-pkg', FIXTURES))).toBeNull()
})

test('detectTypesRedirect leaves the typeless -> @types branch alone', () => {
    // launcher-pkg ships no declarations at all: no entry file, so no redirect
    // decision to make here — docs-core's `!hasTypeFiles` branch owns it.
    const launcher = resolvePackage('launcher-pkg', FIXTURES)
    expect(detectTypesRedirect(launcher)).toBeNull()
    expect(hasTypeFiles(launcher.root)).toBe(false)
})

test('detectTypesRedirect degrades to null on an absent or unreadable entry file', () => {
    const absent = {
        name: 'ghost',
        version: '0.0.0',
        root: path.join(FIXTURES, 'node_modules', 'no-such-pkg'),
        entryDts: path.join(FIXTURES, 'node_modules', 'no-such-pkg', 'index.d.ts'),
        readme: null
    }
    expect(detectTypesRedirect(absent)).toBeNull()
    // A directory where the entry file should be: readFileSync throws EISDIR.
    // stub-pkg is used because it has ONE .d.ts, so the file-count guard does not
    // short-circuit and the read really is what has to degrade.
    const asDir = {
        ...absent,
        root: path.join(FIXTURES, 'node_modules', 'stub-pkg'),
        entryDts: path.join(FIXTURES, 'node_modules', 'stub-pkg')
    }
    expect(detectTypesRedirect(asDir)).toBeNull()
})

test('countEntryDeclarations counts declarations, not lines, comments, or pointers', () => {
    expect(countEntryDeclarations('/// <reference types="bun-types" />\n')).toBe(0)
    expect(countEntryDeclarations('export * from "x";\n')).toBe(0)
    expect(
        countEntryDeclarations(
            '/// <reference types="react" />\nimport * as R from "react";\nexport = R;\n'
        )
    ).toBe(0)
    expect(
        countEntryDeclarations('/* declare function fake(): void */\n// declare const nope: 1\n')
    ).toBe(0)
    expect(
        countEntryDeclarations(
            '/// <reference types="node" />\ndeclare function f(): void\ninterface I {\n  m(): void\n}\nexport type T = string\n'
        )
    ).toBe(3)
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

// ─── the redirect WALK, which had no test in either of its two former copies ──
//
// `detectTypesRedirect`, `hasTypeFiles`, `typesPackageName` and
// `countEntryDeclarations` were exported and covered by 35 references between
// them — but the loop they exist to serve lived in docs-core.ts and
// phantom-imports.ts as two byte-identical copies, and NEITHER was exercised:
// both of their tests pin the zero-hop case only. So `bun → @types/bun →
// bun-types`, cited by name in five doc comments, was asserted nowhere.
const pkg = (name: string, root = `/fake/${name}`): ResolvedPackage =>
    ({name, root, version: '1.0.0'}) as ResolvedPackage

/** Walk a scripted graph: `hops[name]` is what resolving `name` returns. */
const walk = (
    start: ResolvedPackage,
    seed: string,
    hops: Record<string, ResolvedPackage | null>,
    seen: string[] = []
): Promise<ResolvedPackage> =>
    resolveTypeSource(start, seed, next => {
        seen.push(next)
        return Promise.resolve(hops[next] ?? null)
    })

test('resolveTypeSource: a package that ships its own types follows no redirect', async () => {
    // hasTypeFiles is true for a real directory containing .d.ts; use this file's
    // own fixture tree, which docs-resolve.test already relies on.
    const self = pkg('tiny-pkg', path.join(FIXTURES, 'node_modules', 'tiny-pkg'))
    const seen: string[] = []
    const out = await walk(self, 'tiny-pkg', {}, seen)
    expect(out.name).toBe('tiny-pkg')
    expect(seen).toEqual([])
})

test('resolveTypeSource: a typeless package hops to its @types/ twin', async () => {
    const seen: string[] = []
    const out = await walk(
        pkg('left-pad'),
        'left-pad',
        {'@types/left-pad': pkg('@types/left-pad')},
        seen
    )
    expect(seen).toEqual(['@types/left-pad'])
    expect(out.name).toBe('@types/left-pad')
})

test('resolveTypeSource: an unresolvable hop stops the walk at the last good package', async () => {
    const seen: string[] = []
    const out = await walk(pkg('left-pad'), 'left-pad', {}, seen)
    expect(seen).toEqual(['@types/left-pad'])
    // The hop returned null, so the walk keeps what it had rather than failing.
    expect(out.name).toBe('left-pad')
})

test('resolveTypeSource: the seed name is pre-visited, so a redirect cannot loop back', async () => {
    // Asking about `@types/foo` must not hop to `@types/foo` again.
    const seen: string[] = []
    const out = await walk(pkg('foo'), '@types/foo', {'@types/foo': pkg('@types/foo')}, seen)
    expect(seen).toEqual([])
    expect(out.name).toBe('foo')
})

test('resolveTypeSource: the walk is bounded to three hops', async () => {
    // A cycle-free chain longer than the bound must stop, not run away. Each hop is
    // a fresh typeless package whose @types/ twin exists.
    const seen: string[] = []
    const hops: Record<string, ResolvedPackage> = {}
    let name = 'a'
    for (let i = 0; i < 8; i++) {
        const twin = `@types/${name}`
        hops[twin] = pkg(twin.replace('@types/', '') + 'x')
        name = hops[twin]!.name
    }
    await walk(pkg('a'), 'a', hops, seen)
    expect(seen.length).toBeLessThanOrEqual(3)
})
