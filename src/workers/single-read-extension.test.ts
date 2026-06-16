import {describe, expect, test} from 'bun:test'
import singleReadExtension from './single-read-extension.js'

type Handler = (event: {toolName: string; input: unknown}) => unknown

/** Minimal ExtensionAPI stand-in that captures the registered tool_call handler. */
function fakePi(): {handler: Handler | null} {
    const cap: {handler: Handler | null} = {handler: null}
    const pi = {
        on(event: string, handler: Handler) {
            if (event === 'tool_call') cap.handler = handler
        }
    }
    // The factory only touches pi.on — cast through unknown to satisfy the type.
    singleReadExtension(pi as unknown as Parameters<typeof singleReadExtension>[0])
    return cap
}

describe('single-read-extension', () => {
    test('registers a tool_call handler', () => {
        expect(fakePi().handler).toBeTypeOf('function')
    })

    test('allows the first read, blocks the second read of the same file', () => {
        const {handler} = fakePi()
        const ev = {toolName: 'read', input: {path: '/tmp/x.ts'}}
        expect(handler!(ev)).toBeUndefined()
        const blocked = handler!(ev) as {block?: boolean; reason?: string}
        expect(blocked.block).toBe(true)
        expect(blocked.reason).toContain('/tmp/x.ts')
    })

    test('does not interfere with non-read tools', () => {
        const {handler} = fakePi()
        const grep = {toolName: 'grep', input: {path: '/tmp/x.ts', pattern: 'foo'}}
        expect(handler!(grep)).toBeUndefined()
        expect(handler!(grep)).toBeUndefined()
    })

    test('ignores a read whose path is not a string', () => {
        const {handler} = fakePi()
        expect(handler!({toolName: 'read', input: {}})).toBeUndefined()
    })

    test('resolves relative and absolute forms of the same path to one entry', () => {
        const {handler} = fakePi()
        const abs = process.cwd() + '/a.ts'
        expect(handler!({toolName: 'read', input: {path: abs}})).toBeUndefined()
        const blocked = handler!({toolName: 'read', input: {path: 'a.ts'}}) as {block?: boolean}
        expect(blocked.block).toBe(true)
    })
})
