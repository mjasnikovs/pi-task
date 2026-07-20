import {parseHTML} from 'linkedom'
import {Readability} from '@mozilla/readability'
import TurndownService from 'turndown'
import {readPkgVersion} from '../shared/pkg-version.js'

export interface CleanResult {
    title: string
    markdown: string
    finalUrl: string
}

const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    headingStyle: 'atx',
    bulletListMarker: '-'
})

// linkedom's parseHTML returns a DOM whose types don't resolve under this
// tsconfig, so member access lands on an unresolved type. Narrow to the handful
// of fields we touch; the raw document still goes to Readability untouched.
interface ParsedDocument {
    title: string
    body: {innerHTML: string} | null
}

export function cleanHtml(html: string, baseUrl: string): CleanResult {
    const {document} = parseHTML(html)
    const doc = document as unknown as ParsedDocument
    const reader = new Readability(document)
    const parsed = reader.parse()

    if (parsed && parsed.content) {
        return {
            title: parsed.title || doc.title || new URL(baseUrl).hostname,
            markdown: turndown.turndown(parsed.content).trim(),
            finalUrl: baseUrl
        }
    }

    // Fallback: turndown the body
    const body = doc.body
    const bodyHtml = body ? body.innerHTML : ''
    const markdown = turndown.turndown(bodyHtml).trim()
    return {
        title: doc.title || new URL(baseUrl).hostname,
        markdown,
        finalUrl: baseUrl
    }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

// Read at runtime so the User-Agent never drifts out of sync with releases.
const PKG_VERSION = readPkgVersion()
const USER_AGENT = `pi-worker/${PKG_VERSION} (+https://npmjs.com/package/@mjasnikovs/pi-worker)`

type ContentKind = 'html' | 'text' | 'reject'

// Decide how to handle a response based on its content-type. HTML is run through
// the readability/turndown pipeline; text-ish formats (markdown, plain text,
// JSON, XML/feeds) are already clean and pass through verbatim; binary formats
// (PDF, images, octet-stream, …) are rejected. A missing content-type is treated
// as text — many plain-text endpoints (llms.txt, robots.txt) omit the header.
function classifyContentType(contentType: string): ContentKind {
    const mime = contentType.split(';')[0].trim().toLowerCase()
    if (mime === '') return 'text'
    if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
    if (mime.startsWith('text/')) return 'text'
    if (mime === 'application/json' || mime.endsWith('+json')) return 'text'
    if (mime === 'application/xml' || mime.endsWith('+xml')) return 'text'
    if (mime === 'application/javascript' || mime === 'application/ecmascript') return 'text'
    return 'reject'
}

// Extract the charset from a content-type header, if present and supported by
// TextDecoder; otherwise fall back to UTF-8 so non-UTF-8 pages aren't mangled.
function decoderFor(contentType: string): TextDecoder {
    const match = /charset=([^;]+)/i.exec(contentType)
    const charset = match?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (charset) {
        try {
            // The runtime accepts any charset label string; the type is narrowed
            // to a known-encoding union by Bun/Node's lib (DOM's looser signature
            // is no longer pulled in transitively). Cast to the actual param type.
            return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0], {
                fatal: false
            })
        } catch {
            // Unknown/unsupported label — fall through to UTF-8.
        }
    }
    return new TextDecoder('utf-8', {fatal: false})
}

export class FetchAndCleanError extends Error {
    constructor(
        message: string,
        public readonly kind:
            | 'invalid-url'
            | 'http-error'
            | 'not-html'
            | 'too-large'
            | 'network'
            | 'aborted',
        public readonly cause?: unknown
    ) {
        super(message)
        this.name = 'FetchAndCleanError'
    }
}

export interface FetchAndCleanOpts {
    timeoutMs?: number
    maxBytes?: number
    signal?: AbortSignal
}

export async function fetchAndClean(
    url: string,
    opts: FetchAndCleanOpts = {}
): Promise<CleanResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES

    const internalController = new AbortController()
    let sizeExceeded = false
    let userAborted = false

    const timeoutHandle = setTimeout(() => internalController.abort(), timeoutMs)
    const onUserAbort = () => {
        userAborted = true
        internalController.abort()
    }
    if (opts.signal) {
        if (opts.signal.aborted) onUserAbort()
        else opts.signal.addEventListener('abort', onUserAbort, {once: true})
    }

    try {
        let response: Response
        try {
            response = await fetch(url, {
                headers: {'user-agent': USER_AGENT},
                redirect: 'follow',
                signal: internalController.signal
            })
        } catch (err) {
            if (userAborted) {
                throw new FetchAndCleanError('Fetch aborted.', 'aborted', err)
            }
            throw new FetchAndCleanError(
                `Could not fetch ${url}: ${describeError(err)}`,
                'network',
                err
            )
        }

        if (!response.ok) {
            throw new FetchAndCleanError(
                `Fetch failed: HTTP ${response.status} ${response.statusText} for ${url}`,
                'http-error'
            )
        }

        const contentType = response.headers.get('content-type') ?? ''
        const kind = classifyContentType(contentType)
        if (kind === 'reject') {
            throw new FetchAndCleanError(
                `${url} is ${contentType || 'unknown content type'}, not a text or HTML page that pi-worker-fetch can read.`,
                'not-html'
            )
        }

        const reader = response.body?.getReader()
        if (!reader) {
            throw new FetchAndCleanError(`Could not fetch ${url}: empty response body`, 'network')
        }

        const decoder = decoderFor(contentType)
        let text = ''
        let bytesRead = 0
        try {
            while (true) {
                // response.body's stream type doesn't resolve here, so the chunk
                // surfaces as `any`; pin it to the Uint8Array the reader yields.
                const {value, done} = (await reader.read()) as {
                    value?: Uint8Array
                    done: boolean
                }
                if (done) break
                if (value) {
                    bytesRead += value.byteLength
                    if (bytesRead > maxBytes) {
                        sizeExceeded = true
                        internalController.abort()
                        break
                    }
                    text += decoder.decode(value, {stream: true})
                }
            }
            text += decoder.decode()
        } catch (err) {
            if (sizeExceeded) {
                // fall through to throw outside the catch
            } else if (userAborted) {
                throw new FetchAndCleanError('Fetch aborted.', 'aborted', err)
            } else {
                throw new FetchAndCleanError(
                    `Could not fetch ${url}: ${describeError(err)}`,
                    'network',
                    err
                )
            }
        }

        if (sizeExceeded) {
            throw new FetchAndCleanError(
                `${url} exceeds ${formatBytes(maxBytes)} size cap. Try a more specific URL.`,
                'too-large'
            )
        }

        const finalUrl = response.url || url
        if (kind === 'html') {
            return cleanHtml(text, finalUrl)
        }
        // text-ish formats are already clean — return them verbatim.
        return {
            title: hostnameOf(finalUrl),
            markdown: text.trim(),
            finalUrl
        }
    } finally {
        clearTimeout(timeoutHandle)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
    }
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}

function formatBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${n} B`
}
