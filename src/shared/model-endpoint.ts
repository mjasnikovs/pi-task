/**
 * model-endpoint — discovery + reachability probe for the model backend(s) a
 * child pi process talks to.
 *
 * The failure this serves: the model server went down
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

/**
 * What a llama.cpp server's own chat template can actually do about reasoning,
 * as reported by `GET /props`.
 *
 * This is the only source of truth that does NOT come from models.json. It
 * answers the one question the host-side clamp cannot: *is models.json lying
 * about the server?* — the case that matters being pi's built-in llama.cpp
 * provider, which hardcodes `reasoning: false`, so anyone who reached their
 * server through `/login llama.cpp` rather than a hand-written provider entry
 * has a dead knob and nothing to tell them so.
 */
export interface ChatTemplateCaps {
    /** The template reads `reasoning_effort` — i.e. levels, not just on/off. */
    supportsReasoningEffort: boolean
    /** The template reads `preserve_thinking` / `preserve_reasoning`. */
    supportsPreserveReasoning: boolean
    /** The template mentions `enable_thinking` at all — i.e. thinking can be switched. */
    mentionsEnableThinking: boolean
}

/**
 * Probe one base URL for its chat-template capabilities, or `null` for "no
 * answer worth having" — not a llama.cpp server, unreachable, or a body in a
 * shape this does not recognise.
 *
 * `null` is a first-class result, not an error: every non-llama.cpp backend
 * returns it, and the caller must degrade to the models.json view rather than
 * warn about a server it could not read. Never throws.
 *
 * The LEADING SLASH in `/props` is load-bearing. A configured baseUrl normally
 * ends in `/v1` (llama-server's OpenAI-compatible prefix) while `/props` lives at
 * the server root, so a relative `'props'` would resolve to `/v1/props` and 404 —
 * which this would report as `null`, i.e. as a silent loss of the better signal.
 */
export async function probeChatTemplateCaps(
    baseUrl: string,
    timeoutMs = 2_000
): Promise<ChatTemplateCaps | null> {
    try {
        const res = await fetch(new URL('/props', baseUrl), {
            signal: AbortSignal.timeout(timeoutMs)
        })
        if (!res.ok) return null
        const body = (await res.json()) as {
            chat_template?: unknown
            chat_template_caps?: Record<string, unknown>
        }
        const caps = body.chat_template_caps
        if (typeof caps !== 'object' || caps === null) return null
        const template = typeof body.chat_template === 'string' ? body.chat_template : ''
        return {
            supportsReasoningEffort: caps.supports_reasoning_effort === true,
            supportsPreserveReasoning: caps.supports_preserve_reasoning === true,
            mentionsEnableThinking: template.includes('enable_thinking')
        }
    } catch {
        return null
    }
}
