/**
 * The docs TAIL — concatenate the chunks, extract against them, verify the
 * citation, format the answer — written once, with the corpus as a row.
 *
 * WHY. This sequence existed three times: the project-source arm of
 * `pi-worker-docs`, its package arm, and `docsFocused` in `docs-core`. The fetch
 * channel proves the shape is avoidable — `fetchFocused` is one core and
 * `pi-worker-fetch`'s `run` is 60 lines, while the docs registration was 293 for
 * the same job over two corpora.
 *
 * The copies had drifted, in the place hand-flattening always drifts: the
 * package arm's ERROR path dropped `autoInstallPin`, which both of its sibling
 * paths keep — so a package that was auto-installed and then failed to re-resolve
 * lost the `versionSource`/`declaredRange` provenance the last defect in this
 * area was about.
 *
 * A CORPUS is what genuinely varies: the prompt, the header the answer is
 * introduced by, and what an abort of it is called. Everything a corpus does NOT
 * vary — where the content comes from, the version banner, the type-only
 * detector, the details bag — stays with its caller, because those differ in kind
 * and not in value.
 */

import type {SpawnFn} from '../shared/child-process.js'
import {formatResultText} from '../shared/child-output.js'
import {runFocusedExtraction, type FocusedAnswer, type FocusedFailure} from './focused-extractor.js'

/** The two corpora a docs lookup can read. A third (`page`) already has a prompt. */
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
     * The `extraction` group's `--thinking` fragment. Resolved by the CALLER so
     * this module — like the extractor it wraps — never reads ambient config.
     */
    thinking: readonly string[]
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
 * The citation is verified against exactly the text that was prompted with — the
 * concatenation, not a superset. (`fetch` is the one site that verifies against a
 * superset; see `FocusedRequest.verifyAgainst`.)
 */
export async function docsLookup(input: DocsLookupInput): Promise<DocsLookup> {
    const content = input.chunks.map(c => c.content).join('\n\n')
    const extraction = await runFocusedExtraction({
        prompt: input.corpus.buildPrompt(input.query, content),
        verifyAgainst: content,
        cwd: input.cwd,
        signal: input.signal,
        spawn: input.spawn,
        thinking: input.thinking,
        abortedMessage: input.corpus.abortedMessage
    })
    if (!extraction.ok) return {kind: 'failed', extraction}

    const excerptVerified = extraction.excerptVerified
    return {
        kind: 'answer',
        body: formatResultText(input.corpus.header, extraction, excerptVerified),
        content,
        extraction,
        excerptVerified
    }
}
