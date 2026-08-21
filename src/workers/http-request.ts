/**
 * http-request — the one bounded HTTP request in this codebase.
 *
 * Five modules used to hand-roll the same ~12 lines: an internal
 * `AbortController`, a `setTimeout` that aborts it, a `userAborted` flag set
 * from the caller's signal, and a `finally` that clears the timer and removes
 * the listener. Five copies of a rule is five chances to drift, and it HAD
 * drifted — `npm-version.ts` never grew the `userAborted` flag, so a user cancel
 * came back as `null`, indistinguishable from a registry that is down.
 *
 * What is shared is the BOUNDING, not the interpretation. Each caller still owns
 * its own status-code policy (DDG treats 429/403 as rate-limiting, Brave splits
 * auth from rate-limit, npm treats every non-OK as "no answer") and its own error
 * type, because those genuinely differ. What they cannot differ on is whether the
 * request was cancelled by the user, killed by the clock, or refused by the
 * network — so that verdict is made once, here.
 *
 * The handler runs INSIDE the timeout. `fetch` resolves as soon as the headers
 * arrive, so a seam that returned the `Response` and cleared its own timer would
 * leave the body read unbounded — a hung stream would hang forever. Passing a
 * handler keeps the clock over the whole operation, which is what every copy of
 * the ritual already did.
 */

/** Injectable fetch — the narrow signature keeps test fakes free of Bun's extras. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Why the request never produced a response. Deliberately only two kinds: a
 * status code is not a failure of the REQUEST, and what a given status means is
 * the caller's policy.
 */
export class HttpRequestError extends Error {
    constructor(
        readonly kind: 'aborted' | 'network',
        /** The underlying cause, already rendered — callers put it in their own message. */
        readonly detail: string,
        readonly cause?: unknown
    ) {
        super(detail)
        this.name = 'HttpRequestError'
    }
}

export interface HttpRequestOpts {
    method?: string
    headers?: Record<string, string>
    body?: string
    redirect?: 'follow' | 'error' | 'manual'
    /** Wall clock over the request AND the handler. Required — no silent default. */
    timeoutMs: number
    /** The caller's cancel. Its firing is what makes `userAborted()` true. */
    signal?: AbortSignal
    fetchImpl?: FetchLike
}

/** What a handler can ask about, and do to, the request it is reading. */
export interface HttpRequestControl {
    /** The request's own signal, so a handler can pass it further down. */
    readonly signal: AbortSignal
    /**
     * Abort the in-flight request from inside the handler — a size cap hit, an
     * early stop. Distinct from both a user cancel and the timeout, so a handler
     * that calls this can tell its own abort apart from the other two.
     */
    abort(): void
    /** The CALLER cancelled. Not the timeout, not `abort()`. */
    userAborted(): boolean
    /** The wall clock fired. */
    timedOut(): boolean
}

/**
 * Run one bounded HTTP request and hand the response to `handle`.
 *
 * Throws {@link HttpRequestError} when the request itself failed. Anything
 * `handle` throws propagates untouched — that is the caller's own policy talking.
 */
export async function httpRequest<T>(
    url: string,
    opts: HttpRequestOpts,
    handle: (response: Response, ctl: HttpRequestControl) => Promise<T>
): Promise<T> {
    const fetchImpl = opts.fetchImpl ?? fetch
    const controller = new AbortController()
    let userAborted = false
    let timedOut = false

    const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
    }, opts.timeoutMs)
    const onUserAbort = (): void => {
        userAborted = true
        controller.abort()
    }
    if (opts.signal) {
        if (opts.signal.aborted) onUserAbort()
        else opts.signal.addEventListener('abort', onUserAbort, {once: true})
    }

    const ctl: HttpRequestControl = {
        signal: controller.signal,
        abort: () => controller.abort(),
        userAborted: () => userAborted,
        timedOut: () => timedOut
    }

    try {
        let response: Response
        try {
            response = await fetchImpl(url, {
                ...(opts.method === undefined ? {} : {method: opts.method}),
                ...(opts.headers === undefined ? {} : {headers: opts.headers}),
                ...(opts.body === undefined ? {} : {body: opts.body}),
                ...(opts.redirect === undefined ? {} : {redirect: opts.redirect}),
                signal: controller.signal
            })
        } catch (err) {
            if (userAborted) throw new HttpRequestError('aborted', 'Request aborted.', err)
            throw new HttpRequestError('network', describeError(err), err)
        }
        return await handle(response, ctl)
    } finally {
        clearTimeout(timer)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
    }
}

/** A readable one-liner for an unknown thrown value. Four byte-identical copies. */
export function describeError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
