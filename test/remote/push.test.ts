import {describe, it, expect, beforeEach, afterEach} from 'bun:test'
import {mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {
    loadOrCreateVapidKeys,
    addSubscription,
    getSubscriptions,
    clearSubscriptions,
    loadSubscriptions,
    subscriptionsStorePath,
    deliver,
    logPush,
    pushLogPath,
    pushSubject
} from '../../src/remote/push.js'
import type {PushSubscriptionJSON} from '../../src/remote/push.js'

function sub(endpoint: string): PushSubscriptionJSON {
    return {endpoint, keys: {p256dh: 'p', auth: 'a'}}
}

describe('loadOrCreateVapidKeys', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'vapid-'))
    })
    afterEach(() => {
        rmSync(dir, {recursive: true, force: true})
    })

    it('generates a keypair and persists it to the given file', () => {
        const file = path.join(dir, 'vapid.json')
        const keys = loadOrCreateVapidKeys(file)
        expect(typeof keys.publicKey).toBe('string')
        expect(keys.publicKey.length).toBeGreaterThan(20)
        expect(typeof keys.privateKey).toBe('string')
        expect(existsSync(file)).toBe(true)
    })

    it('returns the same keys on a second call (stable across restarts)', () => {
        const file = path.join(dir, 'vapid.json')
        const first = loadOrCreateVapidKeys(file)
        const second = loadOrCreateVapidKeys(file)
        expect(second).toEqual(first)
    })

    it('creates parent directories as needed', () => {
        const file = path.join(dir, 'nested', 'deep', 'vapid.json')
        loadOrCreateVapidKeys(file)
        expect(existsSync(file)).toBe(true)
    })

    it('regenerates if the stored file is corrupt', () => {
        const file = path.join(dir, 'vapid.json')
        writeFileSync(file, 'not json{')
        const keys = loadOrCreateVapidKeys(file)
        expect(typeof keys.publicKey).toBe('string')
        const stored = JSON.parse(readFileSync(file, 'utf8')) as {publicKey: string}
        expect(stored.publicKey).toBe(keys.publicKey)
    })
})

describe('subscription store', () => {
    // addSubscription/clearSubscriptions now mirror to disk under data-home;
    // point that at a temp dir so the suite never touches the real store.
    let dir: string
    let prevXdg: string | undefined
    beforeEach(() => {
        prevXdg = process.env.XDG_DATA_HOME
        dir = mkdtempSync(path.join(tmpdir(), 'subs-'))
        process.env.XDG_DATA_HOME = dir
        clearSubscriptions()
    })
    afterEach(() => {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = prevXdg
        rmSync(dir, {recursive: true, force: true})
    })

    it('stores an added subscription', () => {
        addSubscription(sub('https://push/1'))
        expect(getSubscriptions().map(s => s.endpoint)).toEqual(['https://push/1'])
    })

    it('dedupes by endpoint', () => {
        addSubscription(sub('https://push/1'))
        addSubscription(sub('https://push/1'))
        expect(getSubscriptions()).toHaveLength(1)
    })

    it('keeps distinct endpoints', () => {
        addSubscription(sub('https://push/1'))
        addSubscription(sub('https://push/2'))
        expect(getSubscriptions()).toHaveLength(2)
    })
})

describe('pushSubject', () => {
    let prev: string | undefined
    beforeEach(() => {
        prev = process.env.PI_REMOTE_PUSH_SUBJECT
    })
    afterEach(() => {
        if (prev === undefined) delete process.env.PI_REMOTE_PUSH_SUBJECT
        else process.env.PI_REMOTE_PUSH_SUBJECT = prev
    })

    it('defaults to a valid https URL (Apple rejects mailto:...@localhost)', () => {
        delete process.env.PI_REMOTE_PUSH_SUBJECT
        const s = pushSubject()
        expect(s).toMatch(/^https:\/\//)
        expect(s).not.toContain('localhost')
    })

    it('honors PI_REMOTE_PUSH_SUBJECT override', () => {
        process.env.PI_REMOTE_PUSH_SUBJECT = 'mailto:me@example.com'
        expect(pushSubject()).toBe('mailto:me@example.com')
    })
})

describe('logPush', () => {
    let dir: string
    let prevLog: string | undefined
    let prevDebug: string | undefined
    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'pushlog-'))
        prevLog = process.env.PI_REMOTE_PUSH_LOG
        prevDebug = process.env.PI_REMOTE_PUSH_DEBUG
        process.env.PI_REMOTE_PUSH_LOG = path.join(dir, 'push.log')
    })
    afterEach(() => {
        if (prevLog === undefined) delete process.env.PI_REMOTE_PUSH_LOG
        else process.env.PI_REMOTE_PUSH_LOG = prevLog
        if (prevDebug === undefined) delete process.env.PI_REMOTE_PUSH_DEBUG
        else process.env.PI_REMOTE_PUSH_DEBUG = prevDebug
        rmSync(dir, {recursive: true, force: true})
    })

    it('defaults to a /tmp path when PI_REMOTE_PUSH_LOG is unset', () => {
        delete process.env.PI_REMOTE_PUSH_LOG
        expect(pushLogPath()).toBe('/tmp/pi-task-push.log')
    })

    it('writes nothing when PI_REMOTE_PUSH_DEBUG is unset', () => {
        delete process.env.PI_REMOTE_PUSH_DEBUG
        logPush('hello')
        expect(existsSync(pushLogPath())).toBe(false)
    })

    it('appends a timestamped line when PI_REMOTE_PUSH_DEBUG is set', () => {
        process.env.PI_REMOTE_PUSH_DEBUG = '1'
        logPush('subscribe foo')
        logPush('push bar')
        const body = readFileSync(pushLogPath(), 'utf8')
        expect(body).toContain('subscribe foo')
        expect(body).toContain('push bar')
        // ISO-8601 timestamp prefix on each line
        expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
})

describe('deliver', () => {
    let dir: string
    let prevXdg: string | undefined
    beforeEach(() => {
        prevXdg = process.env.XDG_DATA_HOME
        dir = mkdtempSync(path.join(tmpdir(), 'subs-'))
        process.env.XDG_DATA_HOME = dir
        clearSubscriptions()
    })
    afterEach(() => {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = prevXdg
        rmSync(dir, {recursive: true, force: true})
    })

    it('sends the payload to every subscription', async () => {
        addSubscription(sub('https://push/1'))
        addSubscription(sub('https://push/2'))
        const calls: Array<{endpoint: string; payload: string}> = []
        const send = async (s: PushSubscriptionJSON, payload: string) => {
            calls.push({endpoint: s.endpoint!, payload})
            return {statusCode: 201}
        }
        await deliver(getSubscriptions(), 'hello', send)
        expect(calls.map(c => c.endpoint).sort()).toEqual(['https://push/1', 'https://push/2'])
        expect(calls[0].payload).toBe('hello')
    })

    it('removes subscriptions that the push service reports as gone (410)', async () => {
        addSubscription(sub('https://push/gone'))
        addSubscription(sub('https://push/ok'))
        const send = async (s: PushSubscriptionJSON) => {
            if (s.endpoint === 'https://push/gone') {
                throw Object.assign(new Error('gone'), {statusCode: 410})
            }
            return {statusCode: 201}
        }
        const result = await deliver(getSubscriptions(), 'x', send)
        expect(result.removed).toEqual(['https://push/gone'])
        expect(getSubscriptions().map(s => s.endpoint)).toEqual(['https://push/ok'])
    })

    it('keeps subscriptions on transient (non-gone) errors', async () => {
        addSubscription(sub('https://push/1'))
        const send = async () => {
            throw Object.assign(new Error('boom'), {statusCode: 500})
        }
        const result = await deliver(getSubscriptions(), 'x', send)
        expect(result.removed).toEqual([])
        expect(getSubscriptions()).toHaveLength(1)
    })
})

describe('subscription persistence', () => {
    let dir: string
    let prevXdg: string | undefined
    beforeEach(() => {
        prevXdg = process.env.XDG_DATA_HOME
        dir = mkdtempSync(path.join(tmpdir(), 'subs-'))
        process.env.XDG_DATA_HOME = dir
        clearSubscriptions()
    })
    afterEach(() => {
        if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = prevXdg
        rmSync(dir, {recursive: true, force: true})
    })

    it('mirrors added subscriptions to disk under data-home', () => {
        addSubscription(sub('https://push/keep'))
        const file = subscriptionsStorePath()
        expect(file).toBe(path.join(dir, 'pi-task', 'subscriptions.json'))
        expect(existsSync(file)).toBe(true)
        const stored = JSON.parse(readFileSync(file, 'utf8')) as PushSubscriptionJSON[]
        expect(stored.map(s => s.endpoint)).toEqual(['https://push/keep'])
    })

    it('reloads persisted subscriptions on a fresh process (survives a restart)', () => {
        // Simulate what a rebuilt server sees on boot: an empty in-memory store
        // and a subscriptions file left by the previous process.
        const file = subscriptionsStorePath()
        mkdirSync(path.dirname(file), {recursive: true})
        writeFileSync(file, JSON.stringify([sub('https://push/a'), sub('https://push/b')]))
        expect(loadSubscriptions()).toBe(2)
        expect(
            getSubscriptions()
                .map(s => s.endpoint)
                .sort()
        ).toEqual(['https://push/a', 'https://push/b'])
    })

    it('ignores a corrupt subscriptions file (best-effort)', () => {
        const file = subscriptionsStorePath()
        mkdirSync(path.dirname(file), {recursive: true})
        writeFileSync(file, 'not json{')
        expect(loadSubscriptions()).toBe(0)
        expect(getSubscriptions()).toHaveLength(0)
    })
})
