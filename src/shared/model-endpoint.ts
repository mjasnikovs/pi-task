/**
 * model-endpoint — discovery + reachability probe for the model backend(s) a
 * child pi process talks to.
 *
 * The failure this serves (mx5 run 7, validated): the model server went down
 * mid-gate-child and the child hung MUTE for 64 minutes — pi's own
 * connection-error handling only fires when a request FAILS, not when the
 * backend freezes and the open request simply never answers. The stall guard in
 * runChild uses this module to tell the two apart: no output could be honest
 * long work (prompt processing emits nothing for minutes), so only "no output
 * AND the endpoint does not answer" is treated as a dead backend.
 *
 * Discovery is generic: the custom providers pi itself is configured with
 * (models.json `providers.*.baseUrl`), no provider or server names hardcoded.
 * No discoverable endpoint → nothing to probe → the guard NEVER kills (a child
 * on a backend we cannot see must get the benefit of the doubt).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Base URLs of every custom provider pi is configured with (possibly none). */
export function discoverModelEndpoints(
    agentDir = path.join(os.homedir(), '.pi', 'agent')
): string[] {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(agentDir, 'models.json'), 'utf8')) as {
            providers?: Record<string, {baseUrl?: unknown}>
        }
        const urls: string[] = []
        for (const p of Object.values(j.providers ?? {})) {
            if (typeof p?.baseUrl === 'string' && p.baseUrl.length > 0) urls.push(p.baseUrl)
        }
        return [...new Set(urls)]
    } catch {
        return []
    }
}

/**
 * true → at least one endpoint ANSWERED (any HTTP status counts — a 404 still
 * proves the server is alive); false → every probe was refused or hung past the
 * timeout. An empty list is true: nothing to probe means never kill.
 */
export async function probeModelEndpoints(urls: string[], timeoutMs = 5_000): Promise<boolean> {
    if (urls.length === 0) return true
    const results = await Promise.all(
        urls.map(async u => {
            try {
                await fetch(new URL('models', u.endsWith('/') ? u : `${u}/`), {
                    signal: AbortSignal.timeout(timeoutMs)
                })
                return true
            } catch {
                return false
            }
        })
    )
    return results.some(Boolean)
}
