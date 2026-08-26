/**
 * STIMULI FOR THE EXTRACTION GROUP — production's own prompt, over production's
 * own material.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other group's A/B replays a real recorded input through a PRODUCTION
 * prompt builder. `extraction` was the last one that did not: the harness
 * hand-wrote a prompt ("Answer ONLY from the content below…") and fed it a
 * recorded `## research` section as the content block.
 *
 * That was written down rather than quietly fixed, for a good reason. The two
 * production builders are `docs-core.buildPrompt(pkg, query, content)` and
 * fetch-core's private one, and both frame the content as a named npm package's
 * docs or an anchored web page. A `## research` section is neither, so importing
 * either builder would have put a FALSE FRAME around the material — synthesising
 * a prompt by a longer route, which is worse than admitting to one.
 *
 * THE FIX IS NOT A BETTER FRAME, IT IS THE RIGHT MATERIAL. The corpus records
 * what the docs worker was really asked: `.pi-tasks/research-cache.json` keys
 * are `pi-worker-docs<NUL><pkg>::<query>`, 190 of them over 31 packages, and
 * those packages are installed in the corpus copy's `node_modules`. So the whole
 * production path replays with no model and no network:
 *
 *     docsRaw(pkg, query, cwd)  ->  the real chunks the retriever picked
 *     buildPrompt(pkg, query, content)  ->  the real prompt, real frame
 *
 * Nothing is synthesised, and `docsFocused` is the function this mirrors line
 * for line — including `verifyAgainst`, which must be exactly the text that went
 * into the prompt or the excerpt check becomes a different check.
 *
 * WHAT THIS FILE DOES *NOT* SETTLE
 * --------------------------------
 * The SCORER. `GROUP_SCORERS.extraction` is "the child returned ok and a
 * non-empty answer", which is production's own gate and is also a SHAPE check —
 * the same class that returned 10/10 in both arms for gate, research and
 * planning. Settling the prompt removes the reason not to measure this group; it
 * does not supply an axis with headroom. See the research cell's comment in
 * src/config/reasoning.ts for what happens when a ceiling is mistaken for a tie.
 *
 * The nearest candidate with headroom is already carried through this path:
 * `excerptVerified`, which asks whether the quote is really in the content the
 * child was shown. Production records it as metadata and does not gate on it, so
 * scoring it would be a HARDER bar than production's own — legitimate for an
 * A/B, but it must be screened for headroom before a cell is written from it.
 */
import fs from 'node:fs'
import path from 'node:path'
import {buildPrompt, docsRaw} from '../src/workers/docs-core.js'

/** The NUL the worker cache uses between the tool name and its key. */
const NUL = String.fromCharCode(0)

export interface ExtractionStimulus {
    /** `<pkg>::<query>`, the ledger's `source`. */
    id: string
    pkg: string
    query: string
    /** Production's prompt, from production's builder. */
    prompt: string
    /** Exactly what went into the prompt — the excerpt check's target. */
    content: string
    chunks: number
}

export interface ExtractionScreenOutcome {
    id: string
    usable: boolean
    detail: string
}

/**
 * Every distinct `(package, query)` the recorded run really asked the docs
 * worker, oldest-first in cache order.
 *
 * Deduplicated because the cache is keyed by the pair: a query asked by two
 * tasks is one stimulus, and counting it twice would weight it twice in an arm.
 */
export function recordedDocsQueries(cacheFile: string): Array<{pkg: string; query: string}> {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {
        entries?: Record<string, unknown>
    }
    const entries = raw.entries ?? {}
    const prefix = 'pi-worker-docs' + NUL
    const seen = new Set<string>()
    const out: Array<{pkg: string; query: string}> = []
    for (const key of Object.keys(entries)) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        // `::` separates the package from the question. A package name can
        // contain a slash (`hono/cookie`) but not a colon pair, so the FIRST
        // occurrence is the separator.
        const at = rest.indexOf('::')
        if (at < 0) continue
        const pkg = rest.slice(0, at)
        const query = rest.slice(at + 2)
        if (pkg === '' || query === '') continue
        const id = `${pkg}::${query}`
        if (seen.has(id)) continue
        seen.add(id)
        out.push({pkg, query})
    }
    return out
}

/**
 * Replay each recorded query through production's retrieval and prompt builder,
 * keeping the ones that produce a real prompt.
 *
 * NO NETWORK. `autoInstall` is off and `npmVersionLookup` is stubbed to null:
 * the version banner is part of the ANSWER path, not the prompt, so removing it
 * changes no byte of what the child is asked, and leaving it in would make a
 * screen that needs the registry to be up.
 *
 * A package that is not installed in the corpus copy, or that yields no chunks,
 * is DROPPED and named. Do not substitute a nearby package — the recorded query
 * is about the one it names.
 */
export async function extractionStimuli(opts: {
    /** The corpus copy — its `node_modules` is what gets indexed. */
    cwd: string
    /** Defaults to `<cwd>/.pi-tasks/research-cache.json`. */
    cacheFile?: string
    limitTasks?: number
    log?: (line: string) => void
}): Promise<{stimuli: ExtractionStimulus[]; screened: ExtractionScreenOutcome[]}> {
    const log = opts.log ?? ((l: string) => console.log(l))
    const cacheFile = opts.cacheFile ?? path.join(opts.cwd, '.pi-tasks', 'research-cache.json')
    const screened: ExtractionScreenOutcome[] = []
    const stimuli: ExtractionStimulus[] = []
    for (const q of recordedDocsQueries(cacheFile)) {
        if (opts.limitTasks !== undefined && stimuli.length >= opts.limitTasks) break
        const id = `${q.pkg}::${q.query}`
        let raw
        try {
            raw = await docsRaw({
                pkg: q.pkg,
                query: q.query,
                cwd: opts.cwd,
                autoInstall: false,
                // Not `async () => null`: there is nothing to await when the
                // answer is "do not ask the registry", and an async arrow with
                // no await is a lint warning the baseline does not carry.
                npmVersionLookup: () => Promise.resolve(null)
            })
        } catch (e) {
            screened.push({id, usable: false, detail: `docsRaw threw: ${String(e).slice(0, 80)}`})
            continue
        }
        if (raw.kind !== 'ok') {
            screened.push({id, usable: false, detail: raw.kind})
            continue
        }
        // The same concatenation `docsFocused` prompts with. Both the prompt and
        // the verify target come from this one string, which is the contract
        // that makes `excerptVerified` mean "quoted from what it was shown".
        const content = raw.chunks.map(c => c.content).join('\n\n')
        if (content.trim() === '') {
            screened.push({id, usable: false, detail: 'chunks concatenated to nothing'})
            continue
        }
        screened.push({id, usable: true, detail: `${raw.chunks.length} chunk(s)`})
        stimuli.push({
            id,
            pkg: q.pkg,
            query: q.query,
            prompt: buildPrompt(raw.pkg, q.query, content),
            content,
            chunks: raw.chunks.length
        })
    }
    log(
        `extraction screen: ${stimuli.length}/${screened.length} recorded docs query(ies)`
            + ' replay into a real production prompt'
    )
    return {stimuli, screened}
}
