/**
 * model-endpoint — discovery + reachability probe for the model backend(s) a
 * child pi process talks to.
 *
 * The failure this serves: the model server dies mid-child and the child hangs
 * mute. pi's own connection-error handling cannot help, because it runs from a
 * catch — a request that FAILS reaches it, a request that simply never answers
 * does not. The stall guard in runChild uses this module to tell the two apart:
 * silence alone could be honest long work, since prompt processing emits nothing
 * while it runs, so only "no output AND the endpoint does not answer" counts as
 * a dead backend.
 *
 * Discovery is generic — the custom providers pi is configured with, read from
 * models.json `providers.*.baseUrl`, with no provider or server name hardcoded.
 * No discoverable endpoint means nothing to probe, and the guard then NEVER
 * kills: a child on a backend we cannot see gets the benefit of the doubt.
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
 * true → at least one endpoint ANSWERED. Any HTTP status counts, because the
 * question is liveness, not correctness: probing a path that 404s still returns
 * true, while a closed port returns false. Both confirmed against a live server.
 * An empty list is true — nothing to probe means never kill.
 *
 * `models` is joined RELATIVELY here, and deliberately: it lives under the
 * OpenAI-compatible prefix a baseUrl already carries. Contrast `/props` below.
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
 * This is the only source of truth that does NOT come from models.json, and it
 * answers the question the host-side clamp cannot: is models.json lying about
 * the server? The case that matters is pi's built-in llama.cpp provider, which
 * really does hardcode `reasoning: false` — the literal line is in
 * `extensions/llama/provider.js`, under `LLAMA_PROVIDER_ID = "llama.cpp"`. So
 * anyone who reached their server through `/login llama.cpp` rather than a
 * hand-written provider entry has a dead knob and nothing to tell them so.
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
 * `null` is a first-class result, not an error: a backend that does not serve
 * this shape returns it, and the caller must degrade to the models.json view
 * rather than warn about a server it could not read. Never throws — a closed
 * port answers `null`, confirmed.
 *
 * The LEADING SLASH in `/props` is load-bearing, because `/props` lives at the
 * server ROOT while a configured baseUrl carries an OpenAI-compatible prefix.
 * How a relative `'props'` resolves depends on whether that prefix ends in a
 * slash, which is not something this can rely on:
 *
 *     new URL('props',  'http://host/v1')   →  /props
 *     new URL('props',  'http://host/v1/')  →  /v1/props     ← 404
 *     new URL('/props', either)             →  /props
 *
 * A 404 would come back from here as `null`, silently losing the better signal.
 * The absolute form is right for both.
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
