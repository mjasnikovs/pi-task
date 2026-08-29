/**
 * worker-channels — what a worker TOOL is, as data.
 *
 * `makeWorkerTool` already gives every worker tool one registration adapter, but
 * `spec.name` never left the registration closure. So the same four name strings
 * were re-typed as literals in three directories and had to agree by hand:
 *
 *   • `phases.ts` paired `'…,pi-worker-docs'` with `DOCS_EXTENSION_PATH`, and
 *     `',pi-worker-search,pi-worker-fetch'` with `SEARCH_EXTENSION_PATH` — a tools
 *     string and an `-e` path list that mean the same thing, written twice and
 *     kept in step by eye.
 *   • `GROUNDING_RETRIEVAL_TOOLS` was a second copy of the names.
 *   • `summarizeToolArgs` was a third, and also re-stated each tool's parameter
 *     shape (`module`/`query`, `query`, `url`).
 *   • Worst for locality: `runWorker` — the GENERIC child runner — hardcoded one
 *     tool's identity AND its parameter, `call.name === 'pi-worker-docs' &&
 *     args.module === '.'`, to decide a fan-out deadline extension.
 *
 * A rename or a new tool was five edits in three directories with no compile
 * error linking them. It is one row here now.
 *
 * What is NOT in a row: the tools string's non-worker members (`read`, `grep`,
 * `find`, `ls`) are pi's own built-ins, not channels — they appear in
 * {@link GROUNDING_RETRIEVAL_TOOLS} because grounding is about RETRIEVAL, not
 * about which extension supplies it.
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
 * one fact, and two literals would drift. Entry paths are de-duplicated: search and
 * fetch ship in one extension file.
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
