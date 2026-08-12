/**
 * Synthetic negatives for the serve-entry checker (`findMissingServeEntry`).
 *
 * Each fixture isolates ONE reason a tree can define an app and never bind a
 * port and still be correct — the step-asides that separate "nothing serves
 * this" from "the runtime, an adapter or a framework does the serving". A false
 * positive here is a gate FAIL on a tree that was never broken.
 *
 * These are throwaway trees in a temp dir: no corpus, no git, no model, which is
 * why they run on every `bun test`. The two arms that need real trees — the
 * zero-finding sweep over pi-task/aiz-server/aiz-client/gofer, and the mx5
 * run-18 true positive at two pinned commits — stay in
 * `scripts/serve-entry-fp-suite.ts`.
 *
 * A clean negatives arm alone proves only that the checker is silent, so the
 * true-positive arm is the one that must not be skipped; the script abstains
 * when it cannot run it.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {findMissingServeEntry} from '../src/task/serve-entry.js'

let work = ''

beforeAll(() => {
    work = mkdtempSync(path.join(os.tmpdir(), 'serve-entry-fp-'))
})
afterAll(() => {
    if (work !== '') rmSync(work, {recursive: true, force: true})
})

/** Materialise a throwaway project tree and return its root. */
function tree(key: string, pkg: object, files: Record<string, string>): string {
    const dir = path.join(work, key)
    mkdirSync(dir, {recursive: true})
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 4)}\n`)
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
        writeFileSync(path.join(dir, rel), body)
    }
    return dir
}

const NEGATIVES: Array<{key: string; files: Record<string, string>; pkg: object; why: string}> = [
    {
        key: 'workers-default-export',
        why: 'Cloudflare/Bun protocol — the runtime starts what is default-exported',
        pkg: {name: 'n1', private: true, dependencies: {hono: '4'}},
        files: {
            'src/index.ts':
                "import {Hono} from 'hono'\nconst app = new Hono()\n"
                + "app.get('*', c => c.html('<h1>hi</h1>'))\nexport default app\n"
        }
    },
    {
        key: 'node-server-adapter',
        why: '@hono/node-server binds on the app’s behalf',
        pkg: {name: 'n2', private: true, dependencies: {hono: '4', '@hono/node-server': '1'}},
        files: {
            'src/index.ts':
                "import {serve} from '@hono/node-server'\nimport {Hono} from 'hono'\n"
                + "const app = new Hono()\napp.get('*', c => c.text('ok'))\nserve({fetch: app.fetch})\n"
        }
    },
    {
        key: 'framework-launcher',
        why: 'next owns the listener; an app module with no bind is correct there',
        pkg: {name: 'n3', private: true, dependencies: {next: '15', hono: '4'}, scripts: {start: 'next start'}},
        files: {
            'src/app/api/route.ts':
                "import {Hono} from 'hono'\nconst app = new Hono()\napp.get('*', c => c.text('ok'))\nexport {app}\n"
        }
    },
    {
        key: 'route-module-only',
        why: 'a mountable router with no serving surface — nothing says this tree serves',
        pkg: {name: 'n4', private: true, dependencies: {hono: '4'}},
        files: {
            'src/routes/admin.ts':
                "import {Hono} from 'hono'\nconst admin = new Hono()\n"
                + "admin.get('/users', c => c.json([]))\nexport {admin}\n"
        }
    },
    {
        key: 'express-listen',
        why: 'the classic express bind',
        pkg: {name: 'n5', private: true, dependencies: {express: '4'}},
        files: {
            'src/server.js':
                "const express = require('express')\nconst app = express()\n"
                + "app.use(express.static('dist'))\napp.listen(3000)\n"
        }
    }
]

describe('synthetic negatives — each isolates one step-aside, none may fire', () => {
    for (const n of NEGATIVES) {
        test(`${n.key} — ${n.why}`, () => {
            const found = findMissingServeEntry(tree(n.key, n.pkg, n.files))
            expect(found?.file ?? null).toBeNull()
        })
    }
})
