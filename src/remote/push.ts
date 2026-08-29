import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import webpush from 'web-push'

/** Minimal shape of a browser PushSubscription serialized to JSON. */
export interface PushSubscriptionJSON {
    endpoint?: string
    expirationTime?: number | null
    keys?: {p256dh: string; auth: string}
}

export interface VapidKeys {
    publicKey: string
    privateKey: string
}

/** Resolve the XDG data-home base. Same env-or-homedir shape the docs cache uses
 *  (workers/docs-core.ts), but rooted at data-home rather than cache-home: what
 *  lives under here is not reconstructible by re-fetching. */
function dataHome(): string {
    return process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
}

/** Where the VAPID keypair is persisted. The browser subscribes with this
 *  public key as its applicationServerKey (see ui-script.ts), so the pair has to
 *  outlive the process that created it. */
export function vapidStorePath(): string {
    return path.join(dataHome(), 'pi-task', 'vapid.json')
}

/** Where browser push subscriptions are mirrored to disk (next to vapid.json).
 *  Without this a server restart starts with an empty store and reaches nobody
 *  until every device happens to re-register. The in-memory store stays
 *  authoritative within a process; this is its durable mirror. */
export function subscriptionsStorePath(): string {
    return path.join(dataHome(), 'pi-task', 'subscriptions.json')
}

/** Diagnostic log file. Defaults to /tmp for easy tailing; override with
 *  PI_REMOTE_PUSH_LOG. (The VAPID key stays in its durable XDG location.) */
export function pushLogPath(): string {
    return process.env.PI_REMOTE_PUSH_LOG?.trim() || '/tmp/pi-task-push.log'
}

/** VAPID JWT `sub` claim. web-push's validateSubject requires a parseable URL
 *  whose protocol is `https:` or `mailto:` and throws otherwise, so the default
 *  is a real https URL. Override with PI_REMOTE_PUSH_SUBJECT (e.g. your own
 *  `mailto:you@domain.com`). */
export function pushSubject(): string {
    return process.env.PI_REMOTE_PUSH_SUBJECT?.trim() || 'https://github.com/mjasnikovs/pi-task'
}

/** Append a timestamped diagnostic line — but only when PI_REMOTE_PUSH_DEBUG is
 *  set, so it stays silent (and test-safe) by default. deliver() swallows every
 *  send failure, so this is the only way to see the push service's status
 *  codes. */
export function logPush(line: string): void {
    if (!process.env.PI_REMOTE_PUSH_DEBUG) return
    try {
        const file = pushLogPath()
        mkdirSync(path.dirname(file), {recursive: true})
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
        // diagnostics are best-effort; never let logging break a push
    }
}

/** Short host label for an endpoint, for readable logs — a push endpoint's path
 *  carries the device's own subscription id and does not belong in a log. */
function endpointHost(sub: PushSubscriptionJSON): string {
    try {
        return new URL(sub.endpoint ?? '').host
    } catch {
        return '?'
    }
}

function isVapidKeys(x: unknown): x is VapidKeys {
    if (typeof x !== 'object' || x === null) return false
    const k = x as Record<string, unknown>
    return typeof k.publicKey === 'string' && typeof k.privateKey === 'string'
}

/** Load the persisted VAPID keypair, generating and saving one on first use or
 *  if the stored file is missing/corrupt. Stable across restarts. */
export function loadOrCreateVapidKeys(file = vapidStorePath()): VapidKeys {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (isVapidKeys(parsed)) return {publicKey: parsed.publicKey, privateKey: parsed.privateKey}
    } catch {
        // missing or corrupt — fall through and regenerate
    }
    const keys = webpush.generateVAPIDKeys()
    mkdirSync(path.dirname(file), {recursive: true})
    writeFileSync(file, JSON.stringify(keys), 'utf8')
    return keys
}

// In-memory subscription store, keyed by endpoint. Persisted on globalThis so it
// survives the module being re-evaluated (same pattern as broadcast.ts), and
// mirrored to disk (subscriptionsStorePath) so it also survives a full process
// restart — a re-subscribe on page load only helps devices whose page is open.
const g = globalThis as unknown as {__piRemoteSubs?: Map<string, PushSubscriptionJSON>}
const freshStore = !g.__piRemoteSubs
if (!g.__piRemoteSubs) g.__piRemoteSubs = new Map<string, PushSubscriptionJSON>()
const subs = g.__piRemoteSubs
// Hydrate once per process: a restarted server reloads the devices it knew so it
// can keep reaching them without waiting for each to re-register.
if (freshStore) loadSubscriptions()

function isSubscription(x: unknown): x is PushSubscriptionJSON {
    return (
        typeof x === 'object'
        && x !== null
        && typeof (x as {endpoint?: unknown}).endpoint === 'string'
    )
}

/** Load persisted subscriptions into the in-memory store. Best-effort: a missing
 *  or corrupt file just leaves the store as-is. Returns the resulting count. */
export function loadSubscriptions(file = subscriptionsStorePath()): number {
    try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) {
            for (const s of parsed) if (isSubscription(s)) subs.set(s.endpoint as string, s)
        }
    } catch {
        // missing or corrupt — keep whatever is already in memory
    }
    return subs.size
}

/** Mirror the current store to disk. Best-effort; never throws, so a failed write
 *  can't break a subscribe request or a push. */
function saveSubscriptions(file = subscriptionsStorePath()): void {
    try {
        mkdirSync(path.dirname(file), {recursive: true})
        writeFileSync(file, JSON.stringify([...subs.values()]), 'utf8')
    } catch {
        // persistence is best-effort; the in-memory store remains authoritative
    }
}

export function addSubscription(sub: PushSubscriptionJSON): void {
    if (!sub.endpoint) return
    subs.set(sub.endpoint, sub)
    saveSubscriptions()
}

export function removeSubscription(endpoint: string): void {
    if (subs.delete(endpoint)) saveSubscriptions()
}

export function getSubscriptions(): PushSubscriptionJSON[] {
    return [...subs.values()]
}

export function clearSubscriptions(): void {
    subs.clear()
    saveSubscriptions()
}

/** True when the push service's status says the subscription is permanently
 *  gone (404, 410) rather than transiently failing. web-push rejects with the
 *  `statusCode` on any non-2xx, which is what this reads. */
function isGone(err: unknown): boolean {
    const code = (err as {statusCode?: number} | null)?.statusCode
    return code === 404 || code === 410
}

type SendFn = (sub: PushSubscriptionJSON, payload: string) => Promise<{statusCode: number}>

/** Fan a payload out to every subscription via `send`, pruning any the push
 *  service reports as permanently gone. Network-free and fully testable; the
 *  real web-push call is injected by pushNotify. */
export async function deliver(
    targets: PushSubscriptionJSON[],
    payload: string,
    send: SendFn
): Promise<{removed: string[]}> {
    const removed: string[] = []
    await Promise.all(
        targets.map(async sub => {
            try {
                await send(sub, payload)
            } catch (err) {
                if (sub.endpoint && isGone(err)) {
                    removeSubscription(sub.endpoint)
                    removed.push(sub.endpoint)
                }
                // transient errors: keep the subscription, drop this push
            }
        })
    )
    return {removed}
}

let configured = false
function ensureConfigured(): VapidKeys {
    const keys = loadOrCreateVapidKeys()
    if (!configured) {
        webpush.setVapidDetails(pushSubject(), keys.publicKey, keys.privateKey)
        configured = true
    }
    return keys
}

/** The VAPID public key the browser needs as its applicationServerKey. */
export function publicKey(): string {
    return ensureConfigured().publicKey
}

/** Send a notification to all subscribed devices. Best-effort, and the route is
 *  server→push-service→device, so it does not need the page to be open the way
 *  the in-page Notification API does. */
export async function pushNotify(title: string, body: string, tag?: string): Promise<void> {
    if (process.env.NODE_ENV === 'test') return
    const targets = getSubscriptions()
    logPush(`event "${title}" -> ${targets.length} subscription(s)`)
    if (targets.length === 0) return // nobody subscribed — skip all VAPID/disk work
    ensureConfigured()
    const payload = JSON.stringify({title, body, tag})
    const {removed} = await deliver(targets, payload, async (sub, p) => {
        try {
            const res = await webpush.sendNotification(sub as webpush.PushSubscription, p)
            logPush(`send ${endpointHost(sub)} -> ${res.statusCode}`)
            return res
        } catch (err) {
            const e = err as {statusCode?: number; body?: string; message?: string}
            logPush(
                `send ${endpointHost(sub)} -> ERROR ${e.statusCode ?? '?'} `
                    + `${(e.body || e.message || '').toString().trim().slice(0, 200)}`
            )
            throw err // rethrow so deliver can prune permanently-gone subscriptions
        }
    })
    if (removed.length > 0) logPush(`pruned ${removed.length} gone subscription(s)`)
}
