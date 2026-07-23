import {spawn as defaultSpawn} from 'node:child_process'
import {fetchAndClean as defaultFetchAndClean, type CleanResult} from './html-clean.js'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {runChild, type SpawnFn} from '../shared/child-process.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {
    parseChildOutput,
    verifyExcerpt,
    type ExcerptVerification,
    formatResultText as formatResultTextShared
} from '../shared/child-output.js'

const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

/** The exact non-answers the child is instructed to emit, matched at the tool layer. */
export const UNCLEAR_ANSWER = 'unclear from this page'
export const NOT_COVERED_ANSWER = 'not covered by this page'
const NOT_COVERED_RE = /not covered by this page/i

const childArgs = (): string[] => [...childBaseArgs(), '--no-tools']

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
    const cleaned: CleanResult = await fetchAndCleanFn(input.url, {signal: input.signal})
    return {markdown: cleaned.markdown, finalUrl: cleaned.finalUrl, title: cleaned.title}
}

/**
 * How the page content is turned into the child's prompt. Injectable so an A/B harness can
 * run the shipped strategy against a frozen legacy one in the SAME process, and assert per
 * rep that the two arms differ by exactly the lever (see scripts/live-fetch-abstention-ab.ts).
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
    /** The #fragment slug that was anchored, when the URL carried one and it was located. */
    anchoredSection?: string
    /** Retained evidence for a false `excerptVerified`, so it is diagnosable without re-fetch. */
    excerptCheck?: ExcerptVerification
    /** The prompt actually handed to the child — the A/B asserts surgery against this per rep. */
    assembledPrompt: string
    childExitCode: number
    aborted: boolean
    stderr: string
    stdout: string
}

export async function fetchFocused(input: FetchFocusedInput): Promise<FetchFocusedResult> {
    const fetchAndCleanFn = input.fetchAndClean ?? defaultFetchAndClean
    const spawnFn = input.spawn ?? (defaultSpawn as unknown as SpawnFn)
    const strategy = input.strategy ?? shippedStrategy

    const cleaned = await fetchAndCleanFn(input.url, {signal: input.signal})

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

    const invocation = getPiInvocation(childArgs(), prompt)
    const childResult = await runChild(spawnFn, invocation, input.cwd, input.signal)

    const base = {
        anchoredSection: selected.section,
        assembledPrompt: prompt,
        stderr: childResult.stderr,
        stdout: childResult.stdout
    }

    if (childResult.aborted) {
        return {
            answer: '',
            coverageMiss: false,
            childExitCode: childResult.exitCode,
            aborted: true,
            ...base
        }
    }
    if (childResult.exitCode !== 0) {
        return {
            answer: '',
            coverageMiss: false,
            childExitCode: childResult.exitCode,
            aborted: false,
            ...base
        }
    }

    const parsed = parseChildOutput(childResult.stdout)
    // Verify against the FULL page, not the anchored slice: the slice is a substring of it,
    // so a genuine excerpt still verifies, and an excerpt the child pulled from memory still
    // fails — the detector's discrimination is unchanged by fragment anchoring.
    const check = parsed.excerpt ? verifyExcerpt(parsed.excerpt, cleaned.markdown) : undefined

    return {
        answer: parsed.answer,
        excerpt: parsed.excerpt,
        excerptVerified: check?.verified,
        excerptCheck: check,
        coverageMiss: NOT_COVERED_RE.test(parsed.answer),
        childExitCode: 0,
        aborted: false,
        ...base
    }
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

// ─── Thin wrapper: fetch-core formatResultText (no header) ───────────────────

export function formatResultText(
    parsed: {answer: string; excerpt?: string},
    verified: boolean | undefined
): string {
    return formatResultTextShared('', parsed, verified)
}
