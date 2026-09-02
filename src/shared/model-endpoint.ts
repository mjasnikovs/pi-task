/**
 * model-endpoint — which backend a child pi process talks to, and whether it
 * still answers.
 *
 * The failure this serves: the model server dies mid-child and the child hangs
 * mute. pi's own connection-error handling cannot help, because it runs from a
 * catch — a request that FAILS reaches it, a request that simply never answers
 * does not. The stall guard in runChild uses this module to tell the two apart:
 * silence alone could be honest long work, since prompt processing emits nothing
 * while it runs, so only "no output AND the endpoint does not answer" counts as
 * a dead backend.
 *
 * WHERE THE URL COMES FROM. The registry, snapshotted at session_start by
 * workers/model-warning.ts into config/group-args.ts — the guards run where no
 * `ctx` exists. It used to be re-parsed out of pi's `models.json` and
 * `models-store.json`, which answer `undefined` for every one of pi-ai's 39
 * built-in providers, so the guard was blind exactly where the registry knew
 * the URL. It is now ARMED for those. The other direction is unchanged: no
 * snapshot yet, or a model with no URL, means nothing to probe, and the guard
 * then NEVER kills — a child on a backend we cannot see gets the benefit of the
 * doubt.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {modelEndpoint} from '../config/group-args.js'
import {specOf} from './model-resolve.js'

/**
 * The provider/id a child pi process will actually resolve.
 *
 * Children carry no `-m` (CHILD_BASE_ARGS), so they fall back to pi's saved
 * default — which is this, not the host session's model. `undefined` means we
 * could not read it, and every caller here treats that as "do not guess".
 */
export interface ModelRef {
    provider: string
    id: string
}

/**
 * Still read from settings.json rather than the session snapshot: pi persists a
 * `/model` switch there, and a child with no `--model` resolves it fresh, so the
 * file is the one source that is right after a mid-session switch.
 */
export function defaultModelRef(
    agentDir = path.join(os.homedir(), '.pi', 'agent')
): ModelRef | undefined {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8')) as {
            defaultProvider?: unknown
            defaultModel?: unknown
        }
        const provider = j.defaultProvider
        const id = j.defaultModel
        if (typeof provider !== 'string' || provider === '') return undefined
        if (typeof id !== 'string' || id === '') return undefined
        return {provider, id}
    } catch {
        return undefined
    }
}

/**
 * What to probe on behalf of one child — the endpoint that child's own model
 * uses, not every endpoint on the machine.
 *
 * The bug this closes is `probeModelEndpoints`'s `.some(Boolean)`: with a live
 * cloud provider and a dead local one, the OR answers "reachable" and the stall
 * guard is disarmed for a child that will never speak again. Handing it ONE url
 * makes the OR a no-op and the verdict exact.
 *
 * `spec` is the child's OWN `provider/id`, as carried by its argv. `undefined`
 * means the child carries no `--model` and will resolve pi's saved default,
 * which is then the right thing to probe. Reading the saved default for a child
 * that IS pinned asks about the wrong server in BOTH directions: it can kill a
 * child whose own backend is healthy, and it can leave the guard disarmed for
 * one whose backend is dead.
 *
 * Every escape is toward never killing: an unknown model, a model with no URL,
 * an unreadable default and a session that has not started all answer `[]`,
 * which `probeModelEndpoints` reads as reachable. Probing some OTHER model's
 * url instead would import a false positive, which is the one thing a blind
 * guard never does.
 *
 * `agentDir` locates settings.json for the unpinned case only. The URL always
 * comes from this session's registry snapshot, never from a file under it.
 */
export function childModelEndpoints(
    spec?: string,
    agentDir = path.join(os.homedir(), '.pi', 'agent')
): string[] {
    let ref = spec
    if (ref === undefined) {
        const saved = defaultModelRef(agentDir)
        ref = saved && specOf(saved)
    }
    const url = ref === undefined ? undefined : modelEndpoint(ref)
    return url === undefined ? [] : [url]
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
