/**
 * Zero-FP suite for the serve-entry checker (nexttask 2 part B) — run BEFORE
 * wiring, and any time the patterns change. Modelled on
 * scripts/dangling-artifact-fp-suite.ts: real trees, an expected count, and any hit
 * in a zero arm is a bug in the checker rather than something to excuse.
 *
 *   arm 1  pi-task + aiz-server + aiz-client + gofer   → expected ZERO findings
 *   arm 2  ~/hub/mx5 @ a9c6145 and @ 4880e79           → expected EXACTLY ONE finding
 *                                                        each, naming src/server/index.ts
 *   arm 3  synthetic negatives (Workers default export, adapter serve(), a
 *          framework launcher, a route module with no serving surface) → ZERO
 *
 * `aiz-server` is the load-bearing negative: it is a real Express server that DOES
 * bind (`http.createServer(app)` + `httpServer.listen(…)` in src/bootServer.ts). If
 * the checker cannot tell it apart from mx5, the checker is wrong.
 *
 * Everything is static and read-only. The two mx5 revisions are materialised into
 * throwaway CoW clones — the evidence tree is never checked out, written to, or
 * otherwise disturbed.
 *
 *   PASS     arm 1 = 0 findings AND arm 2 = the expected finding on both revisions. exit 0
 *   FAIL     any arm-1/arm-3 finding, or arm 2 misses it.                           exit 1
 *   ABSTAIN  arm 2 trees unavailable — cannot run.                                  exit 2
 *
 * Run: bun run scripts/serve-entry-fp-suite.ts
 */
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import * as path from 'node:path'
import {findMissingServeEntry, serveEntryGateFailureText} from '../src/task/serve-entry.js'
import {HUB, REPO, makeWorkRoot} from './boot-skip-corpus.js'

let failures = 0
let armTwoTrees = 0

function scan(label: string, dir: string, expectFile: string | null): void {
    if (!existsSync(dir)) {
        console.log(`${label}: SKIP (missing)`)
        return
    }
    const t0 = Date.now()
    const f = findMissingServeEntry(dir)
    const ok = (f?.file ?? null) === expectFile
    console.log(
        `\n${label} (${Date.now() - t0}ms): ${f ? 1 : 0} finding(s) — ${ok ? 'OK' : 'MISMATCH'}`
    )
    if (f) console.log(`  - ${serveEntryGateFailureText(f)}`)
    if (!ok) {
        console.log(`  expected: ${expectFile ?? 'no finding'}`)
        failures++
    }
}

const work = makeWorkRoot('serve-entry-fp')

/** A throwaway clone at a pinned revision; untracked files survive, as in a real run. */
function cloneAt(src: string, commit: string, dest: string): string {
    rmSync(dest, {recursive: true, force: true})
    const cp = spawnSync('cp', ['-a', '--reflink=auto', src, dest], {encoding: 'utf8'})
    if (cp.status !== 0) throw new Error(`cp failed: ${cp.stderr}`)
    const co = spawnSync('git', ['-c', 'advice.detachedHead=false', 'checkout', '--force', commit], {
        cwd: dest,
        encoding: 'utf8'
    })
    if (co.status !== 0) throw new Error(`checkout ${commit} failed: ${co.stderr}`)
    return dest
}

/** Synthetic negatives: shapes that MUST NOT fire, each isolating one step-aside. */
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

try {
    console.log('arm 1 — real trees, expected ZERO findings')
    scan('pi-task (self)', REPO, null)
    scan('aiz-server (binds — the load-bearing negative)', path.join(HUB, 'aiz-server'), null)
    scan('aiz-client', path.join(HUB, 'aiz-client'), null)
    scan('gofer', path.join(HUB, 'gofer'), null)

    console.log('\n\narm 2 — mx5 run 18, expected ONE finding naming src/server/index.ts')
    const mx5 = path.join(HUB, 'mx5')
    for (const commit of ['a9c6145', '4880e79']) {
        if (!existsSync(path.join(mx5, '.git'))) break
        const dir = cloneAt(mx5, commit, path.join(work, `mx5-${commit}`))
        armTwoTrees++
        scan(`mx5@${commit}`, dir, 'src/server/index.ts')
        rmSync(dir, {recursive: true, force: true})
    }

    console.log('\n\narm 3 — synthetic negatives, expected ZERO findings')
    for (const n of NEGATIVES) {
        const dir = path.join(work, n.key)
        mkdirSync(dir, {recursive: true})
        writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(n.pkg, null, 4)}\n`)
        for (const [rel, body] of Object.entries(n.files)) {
            mkdirSync(path.join(dir, path.dirname(rel)), {recursive: true})
            writeFileSync(path.join(dir, rel), body)
        }
        scan(`${n.key} — ${n.why}`, dir, null)
    }

    if (armTwoTrees < 2) {
        console.log('\nABSTAIN — the mx5 run-18 revisions are unavailable, so the true-positive')
        console.log('arm never ran. A clean arm 1 alone proves only that the checker is silent.')
        process.exitCode = 2
    } else {
        console.log(failures === 0 ? '\nFP SUITE: PASS' : `\nFP SUITE: FAIL (${failures})`)
        process.exitCode = failures === 0 ? 0 : 1
    }
} finally {
    rmSync(work, {recursive: true, force: true})
}
