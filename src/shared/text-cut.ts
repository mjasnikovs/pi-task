/** Bounded cuts of a string that never split a surrogate pair into half a character. */

export function keepHead(text: string, limit: number): string {
    const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit
    return text.slice(0, end)
}

export function keepTail(text: string, limit: number): string {
    const start = Math.max(0, text.length - limit)
    return text.slice(isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start)
}

function isHighSurrogate(code: number): boolean {
    return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
    return code >= 0xdc00 && code <= 0xdfff
}
