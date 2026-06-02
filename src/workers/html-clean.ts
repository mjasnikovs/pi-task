import {JSDOM} from 'jsdom'
import {Readability} from '@mozilla/readability'
import TurndownService from 'turndown'

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

export function cleanHtml(html: string, baseUrl: string): CleanResult {
    const dom = new JSDOM(html, {url: baseUrl})
    const reader = new Readability(dom.window.document)
    const parsed = reader.parse()

    if (parsed && parsed.content) {
        return {
            title: parsed.title || dom.window.document.title || new URL(baseUrl).hostname,
            markdown: turndown.turndown(parsed.content).trim(),
            finalUrl: baseUrl
        }
    }

    // Fallback: turndown the body
    const body = dom.window.document.body
    const bodyHtml = body ? body.innerHTML : ''
    const markdown = turndown.turndown(bodyHtml).trim()
    return {
        title: dom.window.document.title || new URL(baseUrl).hostname,
        markdown,
        finalUrl: baseUrl
    }
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 // 2 MB

const PKG_VERSION = '0.2.0' // bump in lockstep with package.json on release
const USER_AGENT = `pi-worker/${PKG_VERSION} (+https://npmjs.com/package/@mjasnikovs/pi-worker)`

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
        if (!contentType.toLowerCase().includes('text/html')) {
            throw new FetchAndCleanError(
                `${url} is ${contentType || 'unknown content type'}, not HTML. pi-worker-fetch only reads HTML pages.`,
                'not-html'
            )
        }

        const reader = response.body?.getReader()
        if (!reader) {
            throw new FetchAndCleanError(`Could not fetch ${url}: empty response body`, 'network')
        }

        const decoder = new TextDecoder('utf-8', {fatal: false})
        let html = ''
        let bytesRead = 0
        try {
            while (true) {
                const {value, done} = await reader.read()
                if (done) break
                if (value) {
                    bytesRead += value.byteLength
                    if (bytesRead > maxBytes) {
                        sizeExceeded = true
                        internalController.abort()
                        break
                    }
                    html += decoder.decode(value, {stream: true})
                }
            }
            html += decoder.decode()
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
        const cleaned = cleanHtml(html, finalUrl)
        return cleaned
    } finally {
        clearTimeout(timeoutHandle)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
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
