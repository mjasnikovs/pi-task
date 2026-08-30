import {describe, expect, test} from 'bun:test'
import {
    relativeImports,
    moduleIdOf,
    findTestRebuiltAssemblies,
    testAssemblyVerifyFindings,
    type RepoFile
} from '../../src/task/test-assembly.js'

// The fixture, in import shape. The production entry composes five route leaves;
// test/photos.test.ts imports two of them (auth + photos) and mounts its OWN app at
// a different prefix than production — so it can be wholly green while the shipped
// path is never exercised. Its siblings do the same; auth.test imports one leaf;
// the page test shares only utilities; the source-grep test asserts on strings.
const ENTRY: RepoFile = {
    path: 'src/server/index.ts',
    text: [
        "import {Hono} from 'hono'",
        "import {authRoutes} from './routes/auth'",
        "import {invitesRoutes} from './routes/invites'",
        "import {listingsRoutes} from './routes/listings'",
        "import {photosRoutes} from './routes/photos'",
        "import {adminRoutes} from './routes/admin'",
        "import {sessionMiddleware} from './auth'",
        "app.route('/api/auth', authRoutes)",
        "app.route('/api/photos', photosRoutes)"
    ].join('\n')
}

// Each route leaf pulls the shared auth helper (so `src/server/auth` has many importers
// — a utility, NOT an entry-exclusive leaf).
const routeLeaf = (name: string): RepoFile => ({
    path: `src/server/routes/${name}.ts`,
    text: ["import {Hono} from 'hono'", "import {sessionMiddleware} from '../auth'"].join('\n')
})
const AUTH_HELPER: RepoFile = {
    path: 'src/server/auth.ts',
    text: 'export const sessionMiddleware = 0'
}
const PRODUCTION: RepoFile[] = [
    ENTRY,
    AUTH_HELPER,
    routeLeaf('auth'),
    routeLeaf('invites'),
    routeLeaf('listings'),
    routeLeaf('photos'),
    routeLeaf('admin')
]

const photosTest: RepoFile = {
    path: 'test/photos.test.ts',
    text: [
        "import {describe, it, expect} from 'bun:test'",
        "import {Hono} from 'hono'",
        "import {authRoutes} from '../src/server/routes/auth'",
        "import {photosRoutes} from '../src/server/routes/photos'",
        "const app = new Hono().route('/api/auth', authRoutes).route('/api', photosRoutes)"
    ].join('\n')
}

describe('relativeImports', () => {
    test('resolves relative specifiers to repo-relative extensionless module ids', () => {
        expect(relativeImports('test/photos.test.ts', photosTest.text).sort()).toEqual([
            'src/server/routes/auth',
            'src/server/routes/photos'
        ])
    })

    test('ignores bare/external specifiers (no repo file)', () => {
        const text = [
            "import x from 'hono'",
            "import fs from 'node:fs'",
            "import y from './a'"
        ].join('\n')
        expect(relativeImports('src/b.ts', text)).toEqual(['src/a'])
    })

    test('collapses ./a, ./a.ts and ./a/index.ts to one id', () => {
        expect(relativeImports('src/b.ts', "import a from './a'")).toEqual(['src/a'])
        expect(relativeImports('src/b.ts', "import a from './a.ts'")).toEqual(['src/a'])
        expect(relativeImports('src/b.ts', "import a from './a/index.ts'")).toEqual(['src/a'])
    })

    test('does NOT match import-shaped strings inside assertions (source-grep tests)', () => {
        // STATIC_IMPORT_RE anchors `import`/`export` as the first non-whitespace token
        // on a line — indentation alone does not stop it. Inside an assertion the
        // string sits after `expect(`, so nothing on that line matches.
        const text = [
            "import {expect} from 'bun:test'",
            '        expect(source).toContain("import {Link} from \'../wouter\'")',
            '        expect(source).not.toContain("from \'../api\'")'
        ].join('\n')
        expect(relativeImports('src/x.test.ts', text)).toEqual([])
    })

    test('resolves require() and dynamic import() calls', () => {
        expect(relativeImports('src/b.ts', "const a = require('./a')")).toEqual(['src/a'])
        expect(relativeImports('src/b.ts', "const a = await import('./a')")).toEqual(['src/a'])
    })
})

describe('moduleIdOf', () => {
    test('strips extension and /index', () => {
        expect(moduleIdOf('src/server/index.ts')).toBe('src/server')
        expect(moduleIdOf('src/server/routes/photos.ts')).toBe('src/server/routes/photos')
    })
})

describe('findTestRebuiltAssemblies', () => {
    test('flags a test that re-composes ≥2 entry-exclusive leaves it never imports (F4)', () => {
        const f = findTestRebuiltAssemblies([photosTest], PRODUCTION)
        expect(f).toHaveLength(1)
        expect(f[0].testFile).toBe('test/photos.test.ts')
        expect(f[0].assemblyFile).toBe('src/server/index.ts')
        expect(f[0].leaves).toEqual(['src/server/routes/auth', 'src/server/routes/photos'])
    })

    test('does NOT flag a single-leaf direct unit test (<2 leaves is not re-assembly)', () => {
        const authTest: RepoFile = {
            path: 'test/auth.test.ts',
            text: [
                "import {authRoutes} from '../src/server/routes/auth'",
                "import {sessionMiddleware} from '../src/server/auth'",
                "const app = new Hono().route('/api/auth', authRoutes)"
            ].join('\n')
        }
        // Shares two modules with the entry, but only routes/auth is entry-exclusive;
        // src/server/auth is a shared utility (every route imports it), so leaves < 2.
        expect(findTestRebuiltAssemblies([authTest], PRODUCTION)).toEqual([])
    })

    test('does NOT flag a test that shares only ubiquitous utilities (no entry-exclusive leaf)', () => {
        const page = (n: string): RepoFile => ({
            path: `src/client/pages/${n}.tsx`,
            text: ["import {api} from '../api'", "import {schema} from '../../shared/schema'"].join(
                '\n'
            )
        })
        const prod = [page('LoginPage'), page('JoinPage'), page('AdminPage')]
        const pageTest: RepoFile = {
            path: 'src/client/pages/JoinPage.test.tsx',
            text: [
                "import {JoinPage} from './JoinPage'",
                "import {api} from '../api'",
                "import {schema} from '../../shared/schema'"
            ].join('\n')
        }
        // api + schema have many production importers → not entry-exclusive → clean.
        expect(findTestRebuiltAssemblies([pageTest], prod)).toEqual([])
    })

    test('does NOT flag a test that imports the real assembly (good citizen)', () => {
        const goodTest: RepoFile = {
            path: 'test/app.test.ts',
            text: [
                "import app from '../src/server/index'",
                "import {authRoutes} from '../src/server/routes/auth'",
                "import {photosRoutes} from '../src/server/routes/photos'"
            ].join('\n')
        }
        expect(findTestRebuiltAssemblies([goodTest], PRODUCTION)).toEqual([])
    })

    test('non-test changed files are ignored', () => {
        const notATest: RepoFile = {path: 'src/server/index.ts', text: ENTRY.text}
        expect(findTestRebuiltAssemblies([notATest], PRODUCTION)).toEqual([])
    })

    test('flags all four sibling backend tests, one finding each (whole house pattern)', () => {
        const sibling = (name: string): RepoFile => ({
            path: `test/${name}.test.ts`,
            text: [
                "import {authRoutes} from '../src/server/routes/auth'",
                `import {${name}Routes} from '../src/server/routes/${name}'`,
                'const app = new Hono()'
            ].join('\n')
        })
        const tests = [sibling('photos'), sibling('admin'), sibling('invites'), sibling('listings')]
        const f = findTestRebuiltAssemblies(tests, PRODUCTION)
        expect(f).toHaveLength(4)
        expect(f.map(x => x.testFile).sort()).toEqual([
            'test/admin.test.ts',
            'test/invites.test.ts',
            'test/listings.test.ts',
            'test/photos.test.ts'
        ])
        for (const x of f) expect(x.assemblyFile).toBe('src/server/index.ts')
    })

    test('empty when there are no changed test files', () => {
        expect(findTestRebuiltAssemblies([], PRODUCTION)).toEqual([])
    })

    test('deterministic across production-file ordering', () => {
        const a = findTestRebuiltAssemblies([photosTest], PRODUCTION)
        const b = findTestRebuiltAssemblies([photosTest], [...PRODUCTION].reverse())
        expect(a).toEqual(b)
    })
})

describe('testAssemblyVerifyFindings', () => {
    test('renders one line naming the test, assembly and leaves', () => {
        const lines = testAssemblyVerifyFindings(
            findTestRebuiltAssemblies([photosTest], PRODUCTION)
        )
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('test/photos.test.ts')
        expect(lines[0]).toContain('src/server/index.ts')
        expect(lines[0]).toContain('src/server/routes/photos')
    })

    test('empty findings → empty array (no block emitted)', () => {
        expect(testAssemblyVerifyFindings([])).toEqual([])
    })
})
