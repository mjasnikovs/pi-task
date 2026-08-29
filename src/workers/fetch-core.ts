import {fetchAndClean as defaultFetchAndClean, type CleanResult} from './html-clean.js'
import type {SpawnFn} from '../shared/child-process.js'
import {runFocusedExtraction} from './focused-extractor.js'
import {abstentionSentence} from './abstention.js'
import {type ExcerptVerification} from '../shared/child-output.js'
import {groupThinkingArgs} from '../config/reasoning-args.js'

const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

/** The exact non-answers the child is instructed to emit, matched at the tool layer. */
export const UNCLEAR_ANSWER = abstentionSentence('page')
export const NOT_COVERED_ANSWER = 'not covered by this page'
/**
 * Rule 6 asks the child to write the sentinel and NOTHING else, so the sentinel is the whole
 * answer — anchored, not a substring search. A substring search misreads the opposite case:
 * rule 5 tells the child to answer partially and say what is missing, and it says it in the
 * prompt's own words ("… `obs_add_raw_audio_callback` and `obs_remove_raw_audio_callback`
 * are not covered by this page"). That is a sourced answer, and the loose match filed it as
 * a coverage miss. Observed twice in 5 reps of scripts/fetch-url-normalise-ab.ts once the
 * rewrite started delivering pages that could half-answer; never in the 84 recorded corpus
 * fetches, where 11 of 11 sentinel answers are the bare sentinel — so tightening it changes
 * no recorded verdict.
 */
const NOT_COVERED_RE = /^not covered by this page[.\s]*$/i

/**
 * `github.com/{owner}/{repo}/blob/{ref}/{path}` renders the file through a client-side
 * viewer, so the HTML we clean carries GitHub chrome ("Sign in", "Appearance settings")
 * and none of the file. Every one of the 8 blob URLs in the three-project research-cache
 * corpus came back a non-answer for that reason. `raw.githubusercontent.com` serves the
 * same bytes as text/plain.
 *
 * Only the URL handed to the fetcher is rewritten — the caller's URL still keys the cache
 * and still supplies the #fragment — so a worker that retries the raw URL by hand hits the
 * cache, and a run's own recorded URLs stay what the run asked for.
 *
 * The query string is dropped: every blob query param (`?plain=1`, `?w=1`, …) is a viewer
 * setting with no meaning on raw. The #fragment is dropped from the request too (it never
 * reaches a server) but is preserved for {@link selectContent} via the original URL.
 */
const GH_BLOB_RE =
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/blob\/([^?#]+?)\/*(?:[?#].*)?$/i

export function normaliseSourceUrl(url: string): string {
    const m = GH_BLOB_RE.exec(url.trim())
    if (!m) return url
    const [, owner, repo, refAndPath] = m
    // `/blob/{ref}/{path}` — a bare `/blob/{ref}` with no path names no file.
    if (!refAndPath.includes('/')) return url
    return `https://raw.githubusercontent.com/${owner}/${repo}/${refAndPath}`
}

export interface FetchRawInput {
    url: string
    signal?: AbortSignal
    fetchAndClean?: typeof defaultFetchAndClean
}

export interface FetchRawResult {
    markdown: string
    finalUrl: string
    title: string
}

export async function fetchRaw(input: FetchRawInput): Promise<FetchRawResult> {
    const fetchAndCleanFn = input.fetchAndClean ?? defaultFetchAndClean
    const cleaned: CleanResult = await fetchAndCleanFn(normaliseSourceUrl(input.url), {
        signal: input.signal
    })
    return {markdown: cleaned.markdown, finalUrl: cleaned.finalUrl, title: cleaned.title}
}

/**
 * How the page content is turned into the child's prompt. Injectable so an A/B harness can
 * run the shipped strategy against a frozen legacy one in the SAME process, and assert per
 * rep that the two arms differ by exactly the lever.
 * Production always uses {@link shippedStrategy}.
 */
export interface PromptStrategy {
    selectContent(markdown: string, requestedUrl: string): SelectedContent
    buildPrompt(args: {
        query: string
        url: string
        title: string
        content: string
        section?: string
    }): string
}

export interface FetchFocusedInput {
    url: string
    query: string
    cwd: string
    signal?: AbortSignal
    fetchAndClean?: typeof defaultFetchAndClean
    spawn?: SpawnFn
    /** Defaults to {@link shippedStrategy}; overridden only by the A/B harness. */
    strategy?: PromptStrategy
}

export interface FetchFocusedResult {
    answer: string
    excerpt?: string
    excerptVerified?: boolean
    /**
     * The page did not cover the asked-about version/topic — a DISTINCT outcome from
     * `unclear from this page`, so the caller can pick a different URL instead of treating
     * "page has no answer" and "answer is ambiguous" as the same thing (PROMPT-3 item 3).
     */
    coverageMiss: boolean
    /**
     * What to do INSTEAD, present only on a coverage miss. `coverageMiss` was computed and
     * stored and read nowhere, so the distinct channel it exists to provide never reached the
     * worker: all it ever saw was the bare sentence "not covered by this page", which reads
     * as "ask again, differently". It did — 9 of the 84 corpus fetches re-read a URL that had
     * already returned a non-answer, one release-notes page three times with near-identical
     * questions.
     */
    nextStep?: string
    /** The #fragment slug that was anchored, when the URL carried one and it was located. */
    anchoredSection?: string
    /** Retained evidence for a false `excerptVerified`, so it is diagnosable without re-fetch. */
    excerptCheck?: ExcerptVerification
    /** The prompt actually handed to the child — the A/B asserts surgery against this per rep. */
    assembledPrompt: string
    /**
     * Set exactly when the child failed (aborted, or non-zero exit): the standard
     * child-failure message, already formatted. Present ⇒ `answer` is empty and means nothing.
     */
    failure?: string
    childExitCode: number
    aborted: boolean
    stderr: string
    stdout: string
}

export async function fetchFocused(input: FetchFocusedInput): Promise<FetchFocusedResult> {
    const fetchAndCleanFn = input.fetchAndClean ?? defaultFetchAndClean
    const strategy = input.strategy ?? shippedStrategy

    const fetchedUrl = normaliseSourceUrl(input.url)
    const cleaned = await fetchAndCleanFn(fetchedUrl, {signal: input.signal})

    // The #fragment is a client-side concern the server never sees, so anchor from the
    // ORIGINALLY REQUESTED url, not the post-redirect finalUrl (which will have dropped it).
    const selected = strategy.selectContent(cleaned.markdown, input.url)
    const prompt = strategy.buildPrompt({
        query: input.query,
        url: cleaned.finalUrl,
        title: cleaned.title,
        content: selected.content,
        section: selected.section
    })

    const extraction = await runFocusedExtraction({
        prompt,
        // Verify against the FULL page, not the anchored slice we prompted with: the slice is
        // a substring of it, so a genuine excerpt still verifies, and an excerpt the child
        // pulled from memory still fails — the detector's discrimination is unchanged by
        // fragment anchoring. This is the one call site that verifies against a SUPERSET of
        // the prompt content, which is why the extractor takes the target by name.
        verifyAgainst: cleaned.markdown,
        cwd: input.cwd,
        signal: input.signal,
        spawn: input.spawn,
        // The `extraction` group's level. Resolved at the call site so the
        // extractor itself never reads ambient config.
        thinking: groupThinkingArgs('extraction'),
        abortedMessage: 'Fetch aborted.'
    })

    const base = {
        anchoredSection: selected.section,
        assembledPrompt: prompt,
        stderr: extraction.stderr,
        stdout: extraction.stdout
    }

    if (!extraction.ok) {
        return {
            answer: '',
            coverageMiss: false,
            failure: extraction.failure,
            childExitCode: extraction.exitCode,
            aborted: extraction.aborted,
            ...base
        }
    }

    const coverageMiss = NOT_COVERED_RE.test(extraction.answer.trim())

    return {
        answer: extraction.answer,
        excerpt: extraction.excerpt,
        excerptVerified: extraction.excerptVerified,
        excerptCheck: extraction.excerptCheck,
        coverageMiss,
        nextStep: coverageMiss ? coverageMissNextStep(input.url, fetchedUrl) : undefined,
        childExitCode: 0,
        aborted: false,
        ...base
    }
}

/**
 * The instruction that goes with a coverage miss. It says two things the bare sentinel does
 * not: WHICH page was actually read (after the blob rewrite these differ, and a worker that
 * cannot see that would "retry" the raw URL it already got), and that re-reading this page
 * with a reworded question returns the same answer — so the next move is a different URL.
 *
 * Deliberately not a suggestion of WHICH other URL. Nothing at this layer knows one, and
 * naming a guess is how a dead end becomes two dead ends.
 */
export function coverageMissNextStep(requestedUrl: string, fetchedUrl: string): string {
    const rewritten =
        fetchedUrl !== requestedUrl ?
            ` ${requestedUrl} is a GitHub file viewer whose HTML does not carry the file, so the`
            + ` file itself was already read from ${fetchedUrl} — fetching that raw URL by hand`
            + ` returns exactly this.`
        :   ''
    return (
        `NEXT STEP: this page does not contain the answer.${rewritten}`
        + ` Asking ${fetchedUrl} the same question a different way returns this same result —`
        + ` do not re-read it. Try a different URL, or search for one.`
    )
}

export interface SelectedContent {
    content: string
    /** The #fragment slug that was anchored, if the URL carried one AND it was located. */
    section?: string
}

/** Read the #fragment from a URL. Empty string when there is none. */
function fragmentOf(url: string): string {
    const h = url.indexOf('#')
    return h === -1 ? '' : url.slice(h + 1).trim()
}

/**
 * Slice a markdown page down to the section its heading-anchor #fragment names — the deep
 * link the caller actually asked for — instead of head-truncating the whole page and losing
 * a section that sits past the head window (PROMPT-3 item 2). Falls back to {@link truncate}
 * when the URL has no fragment, or the fragment names no heading in THIS content (e.g. the
 * page changed since the link was captured), so a fragment we cannot honour never degrades a
 * page we could otherwise read.
 */
export function selectContent(markdown: string, requestedUrl: string): SelectedContent {
    const frag = fragmentOf(requestedUrl)
    if (frag) {
        const section = sliceSection(markdown, frag)
        if (section) return {content: truncate(section), section: frag}
    }
    return {content: truncate(markdown)}
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Find the heading whose anchor is `#<frag>` and return that heading's section: from the
 *  heading line up to the next heading of the same or higher level. Anchors are matched on
 *  the heading line in both the Docusaurus (`### Title[](#slug "…")`) and GitHub
 *  (`## [Title](#slug)`) shapes; `#foo` must not match `#foobar`. */
function sliceSection(markdown: string, frag: string): string | undefined {
    const lines = markdown.split('\n')
    const anchor = new RegExp('#' + escapeRegExp(frag) + '(?![a-z0-9-])', 'i')
    let start = -1
    let level = 0
    for (let i = 0; i < lines.length; i++) {
        const h = /^(#{1,6})\s/.exec(lines[i])
        if (h && anchor.test(lines[i])) {
            start = i
            level = h[1].length
            break
        }
    }
    if (start === -1) return undefined
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
        const h = /^(#{1,6})\s/.exec(lines[i])
        if (h && h[1].length <= level) {
            end = i
            break
        }
    }
    const section = lines.slice(start, end).join('\n').trim()
    return section.length > 0 ? section : undefined
}

function truncate(md: string): string {
    if (md.length <= CONTENT_BUDGET) return md
    return md.slice(0, HEAD_CHARS) + TRUNCATION_MARKER + md.slice(md.length - TAIL_CHARS)
}

/**
 * The shipped extraction prompt. Rule 5 was recalibrated for PROMPT 3: the pre-change rule
 * sent the child to `unclear from this page` on ANY ambiguity, which threw away answers that
 * were on the page (measured: 5 of fetch's 10 failures were deterministic false-"unclear").
 * It now (5) answers from the content whenever the content supports one, even partially;
 * (6) reports a page-coverage MISS distinctly, so it is not conflated with ambiguity; and
 * (7) reserves `unclear` for genuinely-ambiguous content — never for absence, and never as
 * licence to invent. The abstention was relaxed WITHOUT relaxing rules 1-2 (verbatim
 * excerpt) — the fabrication guard the A/B scores is untouched.
 */
function buildPrompt(args: {
    query: string
    url: string
    title: string
    content: string
    section?: string
}): string {
    const sectionNote =
        args.section ?
            `<page-section>The content below has been narrowed to the "#${args.section}" section of\n`
            + `the page — the section the URL points to. Treat it as the relevant part of the page.</page-section>\n`
        :   ''
    return (
        `You extract a single piece of information from a web page to answer one question.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <page-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <page-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Distinguish content from UI: button labels, player widgets, status indicators,\n`
        + `   navigation, breadcrumbs, and footers are NOT the answer unless the question is\n`
        + `   specifically about page UI.\n`
        + `4. If the page is not in English, write the <answer> in English (translate key\n`
        + `   non-English terms) and keep the original-language text in <excerpt>.\n`
        + `5. Answer from <page-content> whenever it supports an answer — INCLUDING a partial\n`
        + `   one. If the content states only part of what is asked, give the part that IS\n`
        + `   present and note what is missing; do NOT fall back to "unclear" merely because\n`
        + `   the coverage is incomplete. When <page-content> plainly contains the asked-for\n`
        + `   thing (e.g. it lists the methods, fields, or signature asked about), you MUST\n`
        + `   answer it — "unclear" is the wrong response in that case.\n`
        + `6. If <page-content> is about a DIFFERENT version, topic, or page than the question\n`
        + `   asks about — the asked-about thing is simply not on this page — write exactly:\n`
        + `   <answer>${NOT_COVERED_ANSWER}</answer> and quote in <excerpt> the text that\n`
        + `   shows what this page IS about. Use this, not "unclear", so the caller can try a\n`
        + `   different page.\n`
        + `7. Only when the answer is genuinely present but ambiguous or self-contradictory,\n`
        + `   write exactly: <answer>${UNCLEAR_ANSWER}</answer> with the closest text in\n`
        + `   <excerpt>. Never invent an answer or state anything not supported by\n`
        + `   <page-content>.\n`
        + `8. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<question>${args.query}</question>\n`
        + `<url>${args.url}</url>\n`
        + `<page-title>${args.title}</page-title>\n`
        + sectionNote
        + `<page-content>\n${args.content}\n</page-content>\n`
    )
}

/** The shipped strategy: fragment-aware selection + the recalibrated prompt. */
export const shippedStrategy: PromptStrategy = {selectContent, buildPrompt}

// A fetch answer carries no package header, so the shared formatter is bound with an
// empty one at the single call site rather than behind a wrapper of its own.
