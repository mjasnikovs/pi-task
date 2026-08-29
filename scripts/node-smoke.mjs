// Node runtime smoke test for the remote server, guarding the failure mode in
// issue #7: an EADDRINUSE on the optional remote server escaped the caller's
// try/catch as an uncaughtException and took pi down with it.
//
// WHY a separate .mjs and not a bun:test file: every file under test/ imports
// `bun:test`, so the suite only ever runs under Bun. The shipped bin runs under
// Node — @earendil-works/pi-coding-agent's `bin.pi` starts `#!/usr/bin/env node`
// and its package.json declares a node engines range. This script imports the
// built dist/remote/server.js, runs under plain Node, and exits nonzero on
// failure. No test framework.
//
// It is a guard, not a reproduction. The bind race needs a runtime that lags on
// port release. A green run here says the retry path runs clean and nothing
// escapes on this Node and this OS.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {listenWithRetry} from '../dist/remote/server.js'

// Any uncaughtException or unhandledRejection here is the failure mode itself:
// an error escaping the caller's catch.
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

{
    let ok = true
    for (let i = 0; i < 50; i++) {
        const server = createServer()
        const port = await listenWithRetry(server, 8800, 100)
        if (port < 8800 || port >= 8900) ok = false
        server.close()
        await new Promise(r => setImmediate(r))
    }
    check('50x rapid bind/close cycles stay in range', ok)
}

// Let any late async error surface before asserting the run was clean.
await new Promise(r => setTimeout(r, 30))
check('no uncaught / unhandled errors', escaped.length === 0)
if (escaped.length) for (const e of escaped) console.log(`  ${e}`)

console.log(`\nNode ${process.version} — ${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
