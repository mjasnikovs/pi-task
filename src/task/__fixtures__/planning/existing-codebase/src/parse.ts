/** Parser for nginx combined-format access-log lines (existing, working). */

export interface LogEntry {
    ip: string
    time: Date
    method: string
    path: string
    status: number
    bytes: number
}

const LINE_RE =
    /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+) [^"]*" (\d{3}) (\d+|-)/

/** Parse one combined-format line; null when the line doesn't match. */
export function parseLine(line: string): LogEntry | null {
    const m = LINE_RE.exec(line)
    if (!m) return null
    const time = parseClfDate(m[2])
    if (time === null) return null
    return {
        ip: m[1],
        time,
        method: m[3],
        path: m[4],
        status: Number(m[5]),
        bytes: m[6] === '-' ? 0 : Number(m[6])
    }
}

const MONTHS: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
}

/** Parse CLF timestamps like `12/Jul/2026:14:03:22 +0000`. */
function parseClfDate(raw: string): Date | null {
    const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(raw)
    if (!m) return null
    const month = MONTHS[m[2]]
    if (month === undefined) return null
    const offsetMin =
        (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3)))
    const utc = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]))
    return new Date(utc - offsetMin * 60_000)
}
