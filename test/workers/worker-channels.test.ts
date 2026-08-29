/**
 * The table is the single statement of what a worker tool is.
 *
 * These names used to be four literals in three directories — a tools string
 * paired by eye with an `-e` path list, a grounding set, and a debug-log
 * summariser that also re-stated each tool's parameter shape. A rename was five
 * edits with no compile error linking them.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import {
    channelSet,
    isGroundingRetrieval,
    workerChannel,
    WORKER_CHANNELS
} from '../../src/workers/worker-channels.js'
import {summarizeToolArgs} from '../../src/shared/child-process.js'
import {isGroundingRetrieval as fromCore} from '../../src/workers/pi-worker-core.js'

describe('WORKER_CHANNELS', () => {
    test('every row names an entry file that exists', () => {
        // The `-e` path is what actually registers the tool into a child pi. A row
        // whose entry is missing registers nothing, and the child then has a tools
        // string naming a tool it does not have — the STRUCTURAL failure that made
        // three audited runs issue 0 search calls.
        //
        // The path is resolved against the MODULE, so it is `.js` under `dist/` and
        // has a `.ts` sibling in the source tree; accept either.
        for (const c of WORKER_CHANNELS) {
            const source = c.entryPath.replace(/\.js$/, '.ts')
            expect(fs.existsSync(c.entryPath) || fs.existsSync(source)).toBe(true)
        }
    })

    test('channelSet derives the tools string and the -e paths from the same rows', () => {
        const set = channelSet(['pi-worker-docs', 'pi-worker-search', 'pi-worker-fetch'])
        expect(set.tools).toBe('pi-worker-docs,pi-worker-search,pi-worker-fetch')
        // search + fetch ship in ONE extension file — the paths are de-duplicated,
        // which the hand-written literal did by the author remembering to.
        expect(set.extensions).toHaveLength(2)
        expect(new Set(set.extensions).size).toBe(2)
    })

    test('dropping a channel drops its tool AND its entry together', () => {
        const withSearch = channelSet(['pi-worker-docs', 'pi-worker-search', 'pi-worker-fetch'])
        const withoutSearch = channelSet(['pi-worker-docs'])
        expect(withoutSearch.tools).toBe('pi-worker-docs')
        expect(withoutSearch.extensions).toHaveLength(1)
        expect(withSearch.extensions).toContain(withoutSearch.extensions[0])
    })

    // REGRESSION — the FLIP of "an unknown name contributes nothing". Dropping it
    // silently is the exact failure this table was built to eliminate: a typo or a
    // half-finished rename yields a shorter tools string AND a shorter `-e` list
    // with no compile error and no runtime error, and the child just quietly loses
    // a tool. That is indistinguishable, at every call site, from asking for fewer
    // channels on purpose.
    test('an unknown name is refused, not silently dropped', () => {
        expect(() => channelSet(['pi-worker-docs', 'not-a-tool'])).toThrow(/not-a-tool/)
        // A known set still resolves untouched.
        expect(channelSet(['pi-worker-docs'])).toEqual({
            tools: 'pi-worker-docs',
            extensions: [workerChannel('pi-worker-docs')!.entryPath]
        })
    })
})

describe('the three former copies now read the table', () => {
    test('the grounding set is derived, not hand-kept', () => {
        for (const c of WORKER_CHANNELS.filter(x => x.grounding)) {
            expect(isGroundingRetrieval(c.name)).toBe(true)
        }
        // pi's own retrieval built-ins are grounding too — grounding is about
        // RETRIEVAL, not about which extension supplies the tool.
        expect(isGroundingRetrieval('read')).toBe(true)
        expect(isGroundingRetrieval('grep')).toBe(true)
        expect(isGroundingRetrieval('bash')).toBe(false)
        // pi-worker-core re-exports the same function, not a second copy.
        expect(fromCore).toBe(isGroundingRetrieval)
    })

    test('summarizeToolArgs asks the row for each worker tool', () => {
        expect(
            summarizeToolArgs('pi-worker-docs', {module: 'hono', query: 'how  does hc work'})
        ).toBe('hono "how does hc work"')
        expect(summarizeToolArgs('pi-worker-search', {query: 'bun sqlite'})).toBe('"bun sqlite"')
        expect(summarizeToolArgs('pi-worker-fetch', {url: 'https://hono.dev/docs'})).toBe(
            'https://hono.dev/docs'
        )
        // A row with nothing to say falls through to the generic keys, unchanged.
        expect(summarizeToolArgs('pi-worker-docs', {path: 'src/x.ts'})).toBe('src/x.ts')
        expect(summarizeToolArgs('bash', {command: 'bun  test'})).toBe('bun test')
    })

    test('the project-source predicate belongs to the docs row, not to runWorker', () => {
        const docs = workerChannel('pi-worker-docs')!
        expect(docs.isProjectSourceLookup!({module: '.'})).toBe(true)
        expect(docs.isProjectSourceLookup!({module: 'hono'})).toBe(false)
        expect(docs.isProjectSourceLookup!({})).toBe(false)
        // No other channel claims one — the generic child runner asks the row and
        // gets `undefined` rather than matching a tool name it should not know.
        expect(workerChannel('pi-worker-search')?.isProjectSourceLookup).toBeUndefined()
        expect(workerChannel('read')).toBeUndefined()
    })
})
