// Node runtime smoke test for the remote server (issue #7).
//
// WHY a separate .mjs and not a bun:test file: the whole test suite imports
// `bun:test`, so it only ever runs under Bun. But `pi` itself runs under NODE
// (@earendil-works/pi-coding-agent ships `#!/usr/bin/env node`, engines
// node>=22.19.0), which is the runtime that actually executes this extension's
// dist/ in the field — and where issue #7 (an EADDRINUSE escaping as an
// uncaughtException that crashed pi) was reported. Nothing in CI exercised Node
// before this. This script runs the SHIPPED build (dist/remote/server.js) under
// real Node and asserts the bind/retry contract holds with zero out-of-band
// errors. Plain node:assert + a nonzero exit on failure — no test framework.
//
// SCOPE / honest limits: this is a regression guard, not a reproduction of the
// original crash. The race needs a runtime/OS that lags on port release; GH
// runners (both ubuntu and windows) release fast enough that even the OLD buggy
// code stayed green there. So a green here means "the fix runs correctly and
// nothing escapes on this Node/OS", not "we reproduced #7".
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {listenWithRetry} from '../dist/remote/server.js'

// Any uncaughtException/unhandledRejection IS the issue-#7 failure mode (an
// error escaping the caller's catch). Record every one; assert none at the end.
const escaped = []
process.on('uncaughtException', e => escaped.push(`uncaught: ${e}`))
process.on('unhandledRejection', e => escaped.push(`unhandledRejection: ${e}`))

/** Genuinely hold `port` for the duration; resolves to a closer. */
function occupy(port) {
    return new Promise((resolve, reject) => {
        const s = createServer()
        s.once('error', reject)
        s.listen(port, '0.0.0.0', () => resolve(() => s.close()))
    })
}

let failures = 0
function check(name, ok) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) failures++
}

// 1) Retries past an in-use first port and resolves on the next free one.
{
    const base = 8850
    const free = await occupy(base)
    const server = createServer()
    try {
        const port = await listenWithRetry(server, base, 10)
        check('retries past an in-use port', port === base + 1)
    } finally {
        server.close()
        free()
    }
}

// 2) REJECTS (never throws uncaught) when the whole range is in use — the exact
//    escape mode of #7 must come back as a rejection, not out-of-band.
{
    const base = 8870
    const closers = await Promise.all([occupy(base), occupy(base + 1)])
    const server = createServer()
    let rejected = false
    try {
        await listenWithRetry(server, base, 2)
    } catch (err) {
        rejected = /No free port found in range/.test(err.message)
    } finally {
        server.close()
        for (const c of closers) c()
    }
    check('rejects (no throw) when range exhausted', rejected)
}

// 3) Stress: many rapid bind/close cycles re-create the "bind a just-freed
//    port" pressure the bug lived in. Every cycle must land in range.
{
    let ok = true
    for (let i = 0; i < 50; i++) {
        const server = createServer()
        const port = await listenWithRetry(server, 8800, 100)
        if (port < 8800 || port >= 8900) ok = false
        server.close()
        await new Promise(r => setImmediate(r)) // let close() progress before reuse
    }
    check('50x rapid bind/close cycles stay in range', ok)
}

// Let any late async error surface before asserting the run was clean.
await new Promise(r => setTimeout(r, 30))
check('no uncaught / unhandled errors', escaped.length === 0)
if (escaped.length) for (const e of escaped) console.log(`  ${e}`)

console.log(`\nNode ${process.version} — ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
