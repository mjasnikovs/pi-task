/**
 * Pi invalidates every captured ctx (and the extension's own `pi` handle) when a
 * session is replaced or reloaded — AgentSession.dispose → ExtensionRunner.invalidate
 * — and the guard throws from the next use. Code that fires from a TIMER rather than
 * an event handler therefore has to expect it: the throw would otherwise escape the
 * callback and take the host down as an uncaughtException.
 *
 * Matched on the message because the runtime throws a plain Error with no code or
 * class to test. Only that one guard is swallowed; every other failure still throws.
 */
export function isStaleCtxError(err: unknown): boolean {
    return err instanceof Error && err.message.includes('stale after session')
}
