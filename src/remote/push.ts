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

/** Where the VAPID keypair is persisted. Follows the repo's XDG convention
 *  (see workers/docs-core.ts), but under data-home so it survives cache clears —
 *  losing these keys invalidates every existing browser subscription. */
export function vapidStorePath(): string {
    const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
    return path.join(base, 'pi-task', 'vapid.json')
}

/** Diagnostic log file. Defaults to /tmp for easy tailing; override with
 *  PI_REMOTE_PUSH_LOG. (The VAPID key stays in its durable XDG location.) */
export function pushLogPath(): string {
    return process.env.PI_REMOTE_PUSH_LOG?.trim() || '/tmp/pi-task-push.log'
}

/** VAPID JWT `sub` claim. Apple (unlike Chrome/FCM) validates this and rejects
 *  tokens with an unroutable subject like `mailto:...@localhost` as BadJwtToken,
 *  so the default is a real https URL. Override with PI_REMOTE_PUSH_SUBJECT
 *  (e.g. your own `mailto:you@domain.com`). */
export function pushSubject(): string {
    return process.env.PI_REMOTE_PUSH_SUBJECT?.trim() || 'https://github.com/mjasnikovs/pi-task'
}

/** Append a timestamped diagnostic line — but only when PI_REMOTE_PUSH_DEBUG is
 *  set, so it stays silent (and test-safe) by default. Push failures are
 *  otherwise swallowed, so this is the way to see Apple's HTTP status codes. */
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

/** Short host label for an endpoint, for readable logs (full endpoints are long
 *  and contain device tokens). */
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
// survives jiti re-evaluation on session switches (same pattern as broadcast.ts).
// Subscriptions themselves are not written to disk: the browser re-subscribes on
// every page load, so an in-memory set is sufficient and self-healing.
const g = globalThis as unknown as {__piRemoteSubs?: Map<string, PushSubscriptionJSON>}
if (!g.__piRemoteSubs) g.__piRemoteSubs = new Map<string, PushSubscriptionJSON>()
const subs = g.__piRemoteSubs

export function addSubscription(sub: PushSubscriptionJSON): void {
    if (!sub.endpoint) return
    subs.set(sub.endpoint, sub)
}

export function removeSubscription(endpoint: string): void {
    subs.delete(endpoint)
}

export function getSubscriptions(): PushSubscriptionJSON[] {
    return [...subs.values()]
}

export function clearSubscriptions(): void {
    subs.clear()
}

/** True when the push service says the subscription is permanently gone and
 *  should be dropped (404 Not Found, 410 Gone). */
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

/** Send a notification to all subscribed devices. Best-effort: delivery is
 *  server→push-service→device, so it reaches a suspended iOS PWA that the
 *  in-page Notification API never could. */
export async function pushNotify(title: string, body: string, tag?: string): Promise<void> {
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
