import {describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {
    findAppConstructions,
    findBindEvidence,
    findServeExpectation,
    findMissingServeEntry,
    opaqueLauncher,
    planExpectsServing,
    scanServeEntry,
    serveEntryGateFailureText
} from '../../src/task/serve-entry.js'

/** The shipped entry, verbatim in shape. */
const RUN18_ENTRY =
    "import {Hono} from 'hono'\n"
    + "import {admin} from './routes/admin'\n"
    + 'const app = new Hono<AuthEnv>()\n'
    + "const _routes = app.route('/api/admin', admin)\n"
    + "app.get('*', async c => {\n"
    + "    const indexHtml = Bun.file('dist/index.html')\n"
    + '    const body = new Uint8Array(await indexHtml.arrayBuffer())\n'
    + "    return c.body(body, 200, {'Content-Type': 'text/html'})\n"
    + '})\n'
    + 'export {app}\n'
    + 'export type AppType = typeof _routes\n'

function makeTree(files: Record<string, string>, pkg?: object): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-serve-entry-'))
    if (pkg) writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
        writeFileSync(path.join(dir, rel), body)
    }
    return dir
}

describe('findAppConstructions', () => {
    test('recognises the frameworks and the variable each app is bound to', () => {
        expect(findAppConstructions('const app = new Hono<Env>()')).toEqual([
            {construct: 'new Hono()', name: 'app'}
        ])
        expect(findAppConstructions('const srv = express()\n')[0]).toEqual({
            construct: 'express()',
            name: 'srv'
        })
        expect(findAppConstructions('new Elysia().get("/", () => "x")')[0].construct).toBe(
            'new Elysia()'
        )
    })

    test('a construct NAMED in a string is not a construct', () => {
        // pi-task scanned itself and found seven "server apps" — all of them the
        // human-readable labels in this module's own pattern table.
        expect(findAppConstructions("const label = 'new Hono()'")).toEqual([])
        expect(findAppConstructions('describe("express()", () => {})')).toEqual([])
    })

    test('a method call is not a construction', () => {
        expect(findAppConstructions('router.express()')).toEqual([])
    })
})

describe('findBindEvidence', () => {
    test('the real binds', () => {
        expect(findBindEvidence('Bun.serve({port, fetch})')).toBe('Bun.serve(')
        expect(findBindEvidence('httpServer.listen({port: PORT}, resolve)')).toBe('.listen(')
        expect(findBindEvidence('app.listen(3000)')).toBe('.listen(')
        expect(findBindEvidence('export default {port: 3000, fetch: app.fetch}')).toBe(
            'export default {fetch…}'
        )
        expect(
            findBindEvidence("import {serve} from '@hono/node-server'\nserve({fetch: app.fetch})")
        ).toBe('serve() from a server adapter')
    })

    test('`export default X` binds only when X is an app the tree constructed', () => {
        expect(findBindEvidence('export default app', new Set(['app']))).toBe('export default app')
        // aiz-client's `export default App` is a React component, not a listener.
        expect(findBindEvidence('export default App', new Set())).toBeNull()
        expect(findBindEvidence('export default defineConfig({plugins: []})')).toBeNull()
    })

    test('the run-18 entry has no bind at all', () => {
        expect(findBindEvidence(RUN18_ENTRY, new Set(['app']))).toBeNull()
    })
})

describe('findServeExpectation', () => {
    test('the serving surfaces', () => {
        expect(findServeExpectation("app.get('*', c => c.html(x))")).toContain('catch-all')
        expect(findServeExpectation("Bun.file('dist/index.html')")).toContain('built asset')
        expect(findServeExpectation("app.use(express.static('dist'))")).toContain('express.static')
        expect(findServeExpectation("app.use('/static', serveStatic({root: './'}))")).toContain(
            'serveStatic'
        )
    })

    test('a mountable router alone says nothing about serving', () => {
        expect(findServeExpectation("admin.get('/users', c => c.json([]))")).toBeNull()
    })
})

describe('planExpectsServing', () => {
    test("mx5's own design clause", () => {
        expect(
            planExpectsServing(
                '**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.'
            )
        ).toContain('served path')
        expect(planExpectsServing('A CLI that prints a report.')).toBeNull()
        expect(planExpectsServing(undefined)).toBeNull()
    })
})

describe('opaqueLauncher', () => {
    test('a framework that binds for you stands the check down', () => {
        expect(opaqueLauncher(makeTree({}, {dependencies: {next: '15'}}))).toContain('next')
        expect(opaqueLauncher(makeTree({}, {scripts: {start: 'nest start'}}))).toContain('launcher')
        expect(opaqueLauncher(makeTree({}, {dependencies: {hono: '4'}}))).toBeNull()
    })
})

describe('findMissingServeEntry', () => {
    test('run 18: builds an app, expects to serve, nothing binds → the finding', () => {
        const dir = makeTree(
            {
                'src/server/index.ts': RUN18_ENTRY,
                'src/server/routes/admin.ts':
                    "import {Hono} from 'hono'\nconst admin = new Hono()\nexport {admin}\n"
            },
            {name: 'x', dependencies: {hono: '4'}, scripts: {dev: 'docker compose up'}}
        )
        const f = findMissingServeEntry(dir)
        expect(f?.file).toBe('src/server/index.ts')
        expect(f?.construct).toBe('new Hono()')
        expect(f?.appFiles).toEqual(['src/server/index.ts', 'src/server/routes/admin.ts'])
        expect(serveEntryGateFailureText(f!)).toContain(
            'NOTHING in the tree ever starts a listener'
        )
    })

    test('the SAME tree with a listener → silent', () => {
        const dir = makeTree(
            {'src/server/index.ts': `${RUN18_ENTRY}Bun.serve({port: 3000, fetch: app.fetch})\n`},
            {name: 'x', dependencies: {hono: '4'}}
        )
        expect(findMissingServeEntry(dir)).toBeNull()
    })

    test('a bind ANYWHERE in the tree counts, not just in the entry', () => {
        const dir = makeTree(
            {
                'src/server/index.ts': RUN18_ENTRY,
                'src/main.ts': "import {app} from './server/index'\nBun.serve({fetch: app.fetch})\n"
            },
            {name: 'x', dependencies: {hono: '4'}}
        )
        expect(findMissingServeEntry(dir)).toBeNull()
    })

    test('a bind in a TEST is not the app’s launch — the finding stands', () => {
        const dir = makeTree(
            {
                'src/server/index.ts': RUN18_ENTRY,
                'src/server/index.test.ts': 'Bun.serve({port: 0, fetch: app.fetch})\n'
            },
            {name: 'x', dependencies: {hono: '4'}}
        )
        expect(findMissingServeEntry(dir)?.file).toBe('src/server/index.ts')
    })

    test('no serve expectation in code, but the DESIGN declares one', () => {
        const files = {
            'src/server/index.ts':
                "import {Hono} from 'hono'\nconst app = new Hono()\n"
                + "app.route('/api/admin', admin)\nexport {app}\n"
        }
        const dir = makeTree(files, {name: 'x', dependencies: {hono: '4'}})
        expect(findMissingServeEntry(dir)).toBeNull()
        expect(
            findMissingServeEntry(dir, '**Server:** serves `/api` + static `dist/`.')?.file
        ).toBe('src/server/index.ts')
    })

    test('no app construction at all → nothing to say', () => {
        const dir = makeTree(
            {'src/App.tsx': 'export default function App() {\n return <div/>\n}\n'},
            {name: 'x', dependencies: {react: '19'}}
        )
        expect(findMissingServeEntry(dir)).toBeNull()
    })

    test('a framework launcher stands the whole check down', () => {
        const dir = makeTree(
            {'src/api.ts': `${RUN18_ENTRY}`},
            {name: 'x', dependencies: {hono: '4', next: '15'}}
        )
        expect(findMissingServeEntry(dir)).toBeNull()
    })
})

describe('scanServeEntry', () => {
    test('reports all three questions independently', () => {
        const dir = makeTree(
            {'src/server/index.ts': RUN18_ENTRY},
            {name: 'x', dependencies: {hono: '4'}}
        )
        const s = scanServeEntry(dir)
        expect(s.apps.map(a => a.file)).toEqual(['src/server/index.ts'])
        expect(s.bind).toBeNull()
        expect(s.expectation?.source).toBe('src/server/index.ts')
        expect(s.launcher).toBeNull()
        expect(s.filesScanned).toBe(1)
    })
})
