import {parseHTML} from 'linkedom'
import {Readability} from '@mozilla/readability'
import TurndownService from 'turndown'
import {readPkgVersion} from '../shared/pkg-version.js'
import {httpRequest, HttpRequestError, describeError} from './http-request.js'

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

// A hand-written narrowing to the two fields this module reads off the parsed
// document, so it does not depend on linkedom's exported DOM types. The raw
// document still goes to Readability untouched. ddg-search.ts narrows the same way.
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

    // Readability found no article — turndown the raw body instead. An empty body
    // yields empty markdown, and the title falls back to the URL's hostname.
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

// Read at runtime — `readPkgVersion` re-reads package.json on every call — so the
// User-Agent never drifts out of sync with releases and no build step bakes it in.
const PKG_VERSION = readPkgVersion()
const USER_AGENT = `pi-worker/${PKG_VERSION} (+https://npmjs.com/package/@mjasnikovs/pi-worker)`

type ContentKind = 'html' | 'text' | 'reject'

// Decide how to handle a response based on its content-type, case-insensitively
// and ignoring any `; charset=…` tail. HTML and XHTML run through the
// readability/turndown pipeline; text-ish formats (any `text/*`, JSON and `+json`,
// XML and `+xml`, javascript) are already clean and pass through verbatim; anything
// else — PDF, images, octet-stream — is rejected as `not-html`. A missing
// content-type is treated as text: many plain-text endpoints (llms.txt,
// robots.txt) omit the header.
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
// Quotes around the label are stripped, and an unsupported label decodes exactly
// as UTF-8 would rather than throwing.
function decoderFor(contentType: string): TextDecoder {
    const match = /charset=([^;]+)/i.exec(contentType)
    const charset = match?.[1]?.trim().replace(/^["']|["']$/g, '')
    if (charset) {
        try {
            // The runtime accepts any charset label string, but the type here is the
            // narrow `Encoding` union — passing a plain `string` is TS2345,
            // "not assignable to parameter of type 'Encoding | undefined'". Cast to
            // the actual param type rather than widening the guard.
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
            'invalid-url' | 'http-error' | 'not-html' | 'too-large' | 'network' | 'aborted',
        public override readonly cause?: unknown
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
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
    let sizeExceeded = false

    try {
        return await httpRequest(
            url,
            {
                timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                ...(opts.signal === undefined ? {} : {signal: opts.signal}),
                headers: {'user-agent': USER_AGENT},
                redirect: 'follow'
            },
            async (response, ctl) => {
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
                    throw new FetchAndCleanError(
                        `Could not fetch ${url}: empty response body`,
                        'network'
                    )
                }

                const decoder = decoderFor(contentType)
                let text = ''
                let bytesRead = 0
                try {
                    while (true) {
                        // `reader.read()` resolves to `any` under this tsconfig — assigning
                        // its `value` to a `number` raises no error — so the destructure is
                        // pinned to the Uint8Array the reader actually yields.
                        const {value, done} = (await reader.read()) as {
                            value?: Uint8Array
                            done: boolean
                        }
                        if (done) break
                        if (value) {
                            bytesRead += value.byteLength
                            if (bytesRead > maxBytes) {
                                // OUR abort. All three cancels fire the same signal, so the
                                // seam is what tells them apart: `ctl.abort()` here,
                                // `ctl.userAborted()` for the caller's, `ctl.timedOut()` for
                                // the clock. Only the local `sizeExceeded` flag says it was us.
                                sizeExceeded = true
                                ctl.abort()
                                break
                            }
                            text += decoder.decode(value, {stream: true})
                        }
                    }
                    text += decoder.decode()
                } catch (err) {
                    if (sizeExceeded) {
                        // fall through to throw outside the catch
                    } else if (ctl.userAborted()) {
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
                if (kind === 'html') return cleanHtml(text, finalUrl)
                // text-ish formats are already clean — return them verbatim.
                return {
                    title: hostnameOf(finalUrl),
                    markdown: text.trim(),
                    finalUrl
                }
            }
        )
    } catch (err) {
        if (err instanceof HttpRequestError) {
            throw err.kind === 'aborted' ?
                    new FetchAndCleanError('Fetch aborted.', 'aborted', err.cause)
                :   new FetchAndCleanError(
                        `Could not fetch ${url}: ${err.detail}`,
                        'network',
                        err.cause
                    )
        }
        throw err
    }
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}

function formatBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
    if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
    return `${n} B`
}
