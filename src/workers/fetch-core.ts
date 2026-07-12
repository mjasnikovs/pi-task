import {spawn as defaultSpawn} from 'node:child_process'
import {fetchAndClean as defaultFetchAndClean, type CleanResult} from './html-clean.js'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {runChild, type SpawnFn} from '../shared/child-process.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {
    parseChildOutput,
    isExcerptInContent,
    formatResultText as formatResultTextShared
} from '../shared/child-output.js'

const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

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

export interface FetchFocusedInput {
    url: string
    query: string
    cwd: string
    signal?: AbortSignal
    fetchAndClean?: typeof defaultFetchAndClean
    spawn?: SpawnFn
}

export interface FetchFocusedResult {
    answer: string
    excerpt?: string
    excerptVerified?: boolean
    childExitCode: number
    aborted: boolean
    stderr: string
    stdout: string
}

export async function fetchFocused(input: FetchFocusedInput): Promise<FetchFocusedResult> {
    const fetchAndCleanFn = input.fetchAndClean ?? defaultFetchAndClean
    const spawnFn = input.spawn ?? (defaultSpawn as unknown as SpawnFn)

    const cleaned = await fetchAndCleanFn(input.url, {signal: input.signal})

    const truncated = truncate(cleaned.markdown)
    const prompt = buildPrompt({
        query: input.query,
        url: cleaned.finalUrl,
        title: cleaned.title,
        content: truncated
    })

    const invocation = getPiInvocation(childArgs(), prompt)
    const childResult = await runChild(spawnFn, invocation, input.cwd, input.signal)

    if (childResult.aborted) {
        return {
            answer: '',
            childExitCode: childResult.exitCode,
            aborted: true,
            stderr: childResult.stderr,
            stdout: childResult.stdout
        }
    }

    if (childResult.exitCode !== 0) {
        return {
            answer: '',
            childExitCode: childResult.exitCode,
            aborted: false,
            stderr: childResult.stderr,
            stdout: childResult.stdout
        }
    }

    const parsed = parseChildOutput(childResult.stdout)
    const excerptVerified =
        parsed.excerpt ? isExcerptInContent(parsed.excerpt, cleaned.markdown) : undefined

    return {
        answer: parsed.answer,
        excerpt: parsed.excerpt,
        excerptVerified,
        childExitCode: 0,
        aborted: false,
        stderr: childResult.stderr,
        stdout: childResult.stdout
    }
}

function truncate(md: string): string {
    if (md.length <= CONTENT_BUDGET) return md
    return md.slice(0, HEAD_CHARS) + TRUNCATION_MARKER + md.slice(md.length - TAIL_CHARS)
}

function buildPrompt(args: {query: string; url: string; title: string; content: string}): string {
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
        + `5. If the answer is unclear, ambiguous, or absent from <page-content>, write\n`
        + `   exactly: <answer>unclear from this page</answer> and put the closest related\n`
        + `   text in <excerpt>. Do not guess.\n`
        + `6. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<question>${args.query}</question>\n`
        + `<url>${args.url}</url>\n`
        + `<page-title>${args.title}</page-title>\n`
        + `<page-content>\n${args.content}\n</page-content>\n`
    )
}

// ─── Thin wrapper: fetch-core formatResultText (no header) ───────────────────

export function formatResultText(
    parsed: {answer: string; excerpt?: string},
    verified: boolean | undefined
): string {
    return formatResultTextShared('', parsed, verified)
}
