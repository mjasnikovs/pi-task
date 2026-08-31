import {describe, expect, test} from 'bun:test'
import {resolve} from 'node:path'
import singleReadExtension from '../../src/workers/single-read-extension.js'

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
        // The guard keys on `resolve(process.cwd(), path)`, so the reason names the
        // absolute path, not the string the caller passed.
        expect(blocked.reason).toContain(resolve(process.cwd(), '/tmp/x.ts'))
    })

    test('allows the first grep, blocks an identical repeat', () => {
        const {handler} = fakePi()
        const grep = {toolName: 'grep', input: {path: '/tmp/x.ts', pattern: 'foo'}}
        expect(handler!(grep)).toBeUndefined()
        const blocked = handler!(grep) as {block?: boolean; reason?: string}
        expect(blocked.block).toBe(true)
        expect(blocked.reason).toContain('grep')
    })

    test('allows a different grep pattern on the same file', () => {
        const {handler} = fakePi()
        expect(
            handler!({toolName: 'grep', input: {path: '/tmp/x.ts', pattern: 'foo'}})
        ).toBeUndefined()
        expect(
            handler!({toolName: 'grep', input: {path: '/tmp/x.ts', pattern: 'bar'}})
        ).toBeUndefined()
    })

    test('blocks identical find and ls repeats too', () => {
        const {handler} = fakePi()
        expect(handler!({toolName: 'find', input: {path: '/tmp'}})).toBeUndefined()
        expect(
            (handler!({toolName: 'find', input: {path: '/tmp'}}) as {block?: boolean}).block
        ).toBe(true)
        expect(handler!({toolName: 'ls', input: {path: '/tmp'}})).toBeUndefined()
        expect((handler!({toolName: 'ls', input: {path: '/tmp'}}) as {block?: boolean}).block).toBe(
            true
        )
    })

    test('leaves other tools (e.g. bash) untouched', () => {
        const {handler} = fakePi()
        const bash = {toolName: 'bash', input: {command: 'echo hi'}}
        expect(handler!(bash)).toBeUndefined()
        expect(handler!(bash)).toBeUndefined()
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
