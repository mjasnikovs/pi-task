/**
 * worker-channels — what a worker TOOL is, as data.
 *
 * `makeWorkerTool` gives every worker tool one registration adapter, but
 * `spec.name` never leaves that closure. Without this table the three tool names
 * are re-typed as literals wherever anything else needs them: the tools string
 * and its matching `-e` path list, the grounding set, the debug-log summary and
 * its per-tool parameter shape, and — worst for locality — the GENERIC child
 * runner, which would have to name one tool AND one of its parameters to decide a
 * fan-out deadline extension. Nothing links those edits at compile time. Here
 * each tool is one row.
 *
 * What is NOT a row: pi's own built-ins. `read` and `grep` are listed in
 * {@link GROUNDING_RETRIEVAL_TOOLS} because grounding is about RETRIEVAL rather
 * than about which extension supplies it, while `find` and `ls` return names only
 * and are excluded from it.
 */

import {fileURLToPath} from 'node:url'

/** One worker tool, and everything the rest of the codebase knows about it. */
export interface WorkerChannel {
    /** The tool name the model calls. The same string `WorkerToolSpec.name` declares. */
    name: string
    /** The `-e` entry that registers it into a child pi. */
    entryPath: string
    /** Does a call to this tool retrieve content a claim could be grounded in? */
    grounding: boolean
    /** One line naming WHAT this call was about, for the debug log. */
    summarize: (args: Record<string, unknown>) => string
    /**
     * A call this tool's own consumers branch on. Only the docs channel has one:
     * a `.` module is a PROJECT-SOURCE lookup, which reads the working tree
     * rather than a package, and is what the fan-out deadline extends for.
     *
     * A property, not a method: it is read off the row and called on its own, so
     * a method signature would invite an unbound `this`.
     */
    isProjectSourceLookup?: (args: Record<string, unknown>) => boolean
}

const DOCS_ENTRY = fileURLToPath(new URL('./docs-extension.js', import.meta.url))
const SEARCH_ENTRY = fileURLToPath(new URL('./search-extension.js', import.meta.url))

/** Clip an argument to one readable line. Shared by every row's `summarize`. */
function clip(s: string): string {
    const one = s.replace(/\s+/g, ' ').trim()
    return one.length > 60 ? one.slice(0, 59) + '…' : one
}

export const WORKER_CHANNELS: readonly WorkerChannel[] = [
    {
        name: 'pi-worker-docs',
        entryPath: DOCS_ENTRY,
        grounding: true,
        summarize: a =>
            typeof a.module === 'string' && typeof a.query === 'string' ?
                `${a.module} "${clip(a.query)}"`
            :   '',
        isProjectSourceLookup: a => a.module === '.'
    },
    {
        name: 'pi-worker-search',
        entryPath: SEARCH_ENTRY,
        grounding: true,
        // Without this the debug log shows a bare tool name and a run audit
        // cannot tell WHAT was searched.
        summarize: a => (typeof a.query === 'string' ? `"${clip(a.query)}"` : '')
    },
    {
        name: 'pi-worker-fetch',
        entryPath: SEARCH_ENTRY,
        grounding: true,
        summarize: a => (typeof a.url === 'string' ? clip(a.url) : '')
    }
]

const BY_NAME = new Map(WORKER_CHANNELS.map(c => [c.name, c]))

/** The row for a tool call, or `undefined` when the tool is not a worker channel. */
export function workerChannel(toolName: string): WorkerChannel | undefined {
    return BY_NAME.get(toolName)
}

/**
 * The tools string and the `-e` paths for a set of channels, together — they are
 * one fact, and two literals would drift. The tools string preserves the order it
 * was asked for; entry paths are de-duplicated, so asking for search AND fetch
 * yields ONE path, since both ship in search-extension.js.
 */
export function channelSet(names: readonly string[]): {tools: string; extensions: string[]} {
    // REFUSED, not dropped. Silently skipping an unrecognised name is the exact
    // failure this table was built to eliminate: a typo or a half-finished rename
    // yields a shorter tools string AND a shorter `-e` list, with no compile error
    // and no runtime error, and the child just quietly loses a tool. At every call
    // site that is indistinguishable from asking for fewer channels on purpose.
    const unknown = names.filter(n => !BY_NAME.has(n))
    if (unknown.length > 0) {
        throw new Error(`channelSet: unknown worker channel(s): ${unknown.join(', ')}`)
    }
    const rows = names.map(n => BY_NAME.get(n)).filter((c): c is WorkerChannel => c !== undefined)
    return {
        tools: rows.map(c => c.name).join(','),
        extensions: [...new Set(rows.map(c => c.entryPath))]
    }
}

/**
 * Tool calls that retrieve content an APIS entry could be grounded in — the
 * worker channels that say so, plus pi's own read/grep.
 */
const GROUNDING_RETRIEVAL_TOOLS = new Set<string>([
    'read',
    'grep',
    ...WORKER_CHANNELS.filter(c => c.grounding).map(c => c.name)
])

/** True when a tool call retrieves content an APIS entry could be grounded in. */
export function isGroundingRetrieval(toolName: string): boolean {
    return GROUNDING_RETRIEVAL_TOOLS.has(toolName)
}
