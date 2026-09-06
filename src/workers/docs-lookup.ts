/**
 * The docs TAIL — concatenate the chunks, extract against them, verify the
 * citation, format the answer — written once, with the corpus as a row. Its three
 * callers are pi-worker-docs' project arm, its package arm, and `docsFocused` in
 * docs-core.
 *
 * A CORPUS is exactly what varies between them, and it is three fields: the
 * prompt, the header the answer is introduced by, and what an abort is called.
 * Everything a corpus does NOT vary — where the content comes from, the version
 * banner, the type-only detector, the details bag — stays with the caller,
 * because those differ in kind rather than in value.
 */

import type {SpawnFn} from '../shared/child-process.js'
import {formatResultText} from '../shared/child-output.js'
import {runFocusedExtraction, type FocusedAnswer, type FocusedFailure} from './focused-extractor.js'

/** The two corpora a docs lookup can read. A fetched `page` is a third corpus in
 *  spirit, but it lives on the fetch channel: fetch-core builds its own prompt and
 *  never comes through here. */
export type DocsCorpusId = 'package' | 'project'

export interface DocsCorpus {
    id: DocsCorpusId
    /** The extraction prompt for this corpus, over the concatenated content. */
    buildPrompt: (query: string, content: string) => string
    /** The line the formatted answer is introduced by. */
    header: string
    /** What an abort of this corpus's lookup is called, in the failure text. */
    abortedMessage: string
}

export interface DocsLookupInput {
    corpus: DocsCorpus
    /** The retrieved chunks, in retrieval order. */
    chunks: ReadonlyArray<{content: string}>
    query: string
    cwd: string
    signal?: AbortSignal
    spawn?: SpawnFn
    /**
     * The `extraction` group's argv fragment — its model and its thinking level.
     * Resolved by the CALLER so this module, like the extractor it wraps, never
     * reads ambient config.
     */
    groupArgs: readonly string[]
}

export type DocsLookup =
    | {
          kind: 'answer'
          /** The formatted answer: header, answer, and the verified excerpt. */
          body: string
          /** Exactly what was prompted with, and what the citation was verified against. */
          content: string
          extraction: FocusedAnswer
          /** Undefined when there was no excerpt to check. */
          excerptVerified?: boolean
      }
    | {kind: 'failed'; extraction: FocusedFailure}

/**
 * Run one docs lookup over already-retrieved chunks.
 *
 * The citation is verified against exactly the text that was prompted with: the
 * `\n\n`-joined chunks are passed as BOTH the prompt content and `verifyAgainst`.
 * fetch-core is the only call site in this repo that passes a superset instead —
 * see `FocusedRequest.verifyAgainst`.
 */
export async function docsLookup(input: DocsLookupInput): Promise<DocsLookup> {
    const content = input.chunks.map(c => c.content).join('\n\n')
    const extraction = await runFocusedExtraction({
        prompt: input.corpus.buildPrompt(input.query, content),
        verifyAgainst: content,
        cwd: input.cwd,
        signal: input.signal,
        spawn: input.spawn,
        groupArgs: input.groupArgs,
        abortedMessage: input.corpus.abortedMessage
    })
    if (!extraction.ok) return {kind: 'failed', extraction}

    const excerptVerified = extraction.excerptVerified
    return {
        kind: 'answer',
        body: formatResultText(input.corpus.header, extraction, extraction.excerptCheck),
        content,
        extraction,
        excerptVerified
    }
}
