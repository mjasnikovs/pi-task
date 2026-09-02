/**
 * Which model errors are worth another attempt.
 *
 * A connection-class model error is transient: a single dropped fetch to a live
 * endpoint, not a repeatable mistake. On a local single-slot server (e.g.
 * llama-server with `--parallel 1`) pi-task's own concurrent fan-out can briefly
 * saturate the slot, and one request fails to connect even though the model is
 * up and the next request succeeds. pi already retries internally, but those
 * retries don't always absorb it on a saturated local server — and a fail-fast
 * then kills the whole task for a single blip.
 *
 * A NON-connection model error (bad request, context-length overflow, auth,
 * provider 5xx that names a real fault) still fails fast: re-spawning against
 * the same request won't fix it, so burning the budget only delays the report.
 *
 * SCOPE, and it is deliberate: connection classes only. pi's own
 * `isRetryableAssistantError` (@earendil-works/pi-ai, `dist/utils/retry.js`) also
 * retries the provider-LOAD family — `429`, `5xx`, `rate limit`, `overloaded` —
 * which `does NOT match real, non-transient faults` in child-runner.test.ts
 * explicitly rejects. That disagreement is real and OPEN; it is not settled here,
 * because this backoff starts at 500ms and a 429 answered that fast is a retry
 * storm, not a recovery.
 *
 * MEASURED against pi before widening: the transport entries here — a bare
 * `timed out`, `getaddrinfo ENOTFOUND`, `upstream connect`, `reset before
 * headers`, a truncated Anthropic stream and a closed websocket — were all
 * MISSES. Every one is a REMOTE-provider failure, which is why a local llama.cpp
 * setup never surfaced the gap. The errno spellings are pi-task's own: a child
 * reports them through stderr, and pi never sees them.
 *
 * pi's bare `timeout` is deliberately NOT reproduced. It matched a provider 400
 * that merely echoed a `timeout` field back, turning a fail-fast into a full
 * retry budget, and it caught nothing the `timed out` spellings above miss.
 */
const CONNECTION_ERROR_RE =
    /\b(?:connection error|connection (?:lost|closed|reset|refused|aborted)|econnreset|econnrefused|econnaborted|epipe|etimedout|enetunreach|enetdown|eai_again|socket hang up|socket connection was closed|fetch failed|network (?:error|timeout)|premature close|terminated|unreachable|getaddrinfo|enotfound|upstream.?connect|reset before headers|timed? out|ended without|stream ended before message_stop|websocket.?(?:closed|error))\b/i

/**
 * Provider LOAD, which is transient in a different way: the server is up and
 * saying "not now". pi retries all of these; 53f0488 did not, but its own message
 * names only "context overflow, bad request, auth" as the fail-fast set — a
 * throttle was never argued for, it just rode along in a list written for a LOCAL
 * server, where none of these can occur.
 *
 * Words carry no trailing \b (`overloaded_error` joins on `_`, which is a word
 * character); the bare status codes carry one, or `500` matches inside `15000`.
 */
const PROVIDER_LOAD_RE =
    /(?:overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|internal.?error|provider.?returned.?error)|\b(?:429|500|502|503|504|524)\b/i

/**
 * Account facts, not liveness: a budget does not refill on a retry. Checked FIRST,
 * because these arrive worded as a throttle — `429 GoUsageLimitError` is a
 * subscription limit, not a queue.
 */
const NON_RETRYABLE_RE =
    /\b(?:insufficient_quota|quota exceeded|out of budget|billing|usage limit reached|available balance|GoUsageLimitError|FreeUsageLimitError)\b/i

export function isConnectionError(cause: string): boolean {
    if (NON_RETRYABLE_RE.test(cause)) return false
    return CONNECTION_ERROR_RE.test(cause) || PROVIDER_LOAD_RE.test(cause)
}

/**
 * Exponential backoff before a connection-error retry: 500ms, 1s, 2s — three
 * requests over 3.5s, which is not a storm even against a throttle. pi's own
 * ladder is three at 2s/4s/8s.
 */
export function connectionRetryBackoffMs(attempt: number): number {
    return 500 * 2 ** attempt
}
