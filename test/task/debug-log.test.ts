import {describe, expect, test} from 'bun:test'
import {
    DEBUG_LINE_LIMIT,
    DEBUG_LOG_ENV,
    debugLogLevel,
    gateDebugWriter,
    makeDebugAppender,
    sanitizeDebugLine,
    shouldLogDebug
} from '../../src/task/debug-log.js'

/** Env stub so these tests never read the developer's own config or environment. */
const env =
    (vars: Record<string, string>) =>
    (k: string): string | undefined =>
        vars[k]

describe('shouldLogDebug', () => {
    test('off writes nothing', () => {
        expect(shouldLogDebug('event', 'off')).toBe(false)
        expect(shouldLogDebug('stream', 'off')).toBe(false)
    })

    test('full writes both kinds', () => {
        expect(shouldLogDebug('event', 'full')).toBe(true)
        expect(shouldLogDebug('stream', 'full')).toBe(true)
    })

    // The whole point of three levels rather than a boolean. There are exactly
    // two line kinds, so the matrix is: `off` writes nothing, `full` writes both,
    // and `events` writes events and drops stream. The default therefore keeps
    // the guard/verdict record and drops the model chatter and tool dumps.
    test('events keeps decisions and drops stream chatter', () => {
        expect(shouldLogDebug('event', 'events')).toBe(true)
        expect(shouldLogDebug('stream', 'events')).toBe(false)
    })
})

describe('debugLogLevel', () => {
    test('an offered env value overrides the saved config', () => {
        expect(debugLogLevel(env({[DEBUG_LOG_ENV]: 'full'}))).toBe('full')
        expect(debugLogLevel(env({[DEBUG_LOG_ENV]: 'off'}))).toBe('off')
    })

    test('surrounding whitespace is tolerated', () => {
        expect(debugLogLevel(env({[DEBUG_LOG_ENV]: '  full  '}))).toBe('full')
    })

    /**
     * A typo must fall through to the config, NOT be sanitized into the default —
     * otherwise `PI_TASK_DEBUG_LOG=verbose` would silently override a deliberate
     * `off` (or a deliberate `full`) with `events`.
     */
    test('an unrecognised env value is ignored rather than applied', () => {
        const withTypo = debugLogLevel(env({[DEBUG_LOG_ENV]: 'verbose'}))
        const withNothing = debugLogLevel(env({}))
        expect(withTypo).toBe(withNothing)
    })
})

describe('makeDebugAppender', () => {
    const capture = () => {
        const writes: string[] = []
        const appendFile = async (_p: string, data: string) => void writes.push(data)
        return {writes, appendFile}
    }

    test('stamps each line with an ISO timestamp and a trailing newline', () => {
        const {writes, appendFile} = capture()
        process.env[DEBUG_LOG_ENV] = 'full'
        try {
            makeDebugAppender('/tmp/x.log', appendFile)('hello')
        } finally {
            delete process.env[DEBUG_LOG_ENV]
        }
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello\n$/)
    })

    test('a line defaults to event, so an unclassified marker survives at events', () => {
        const {writes, appendFile} = capture()
        process.env[DEBUG_LOG_ENV] = 'events'
        try {
            const log = makeDebugAppender('/tmp/x.log', appendFile)
            log('=== verify end: FAIL ===')
            log('raw model chatter', 'stream')
        } finally {
            delete process.env[DEBUG_LOG_ENV]
        }
        expect(writes).toHaveLength(1)
        expect(writes[0]).toContain('=== verify end: FAIL ===')
    })

    test('off writes nothing at all', () => {
        const {writes, appendFile} = capture()
        process.env[DEBUG_LOG_ENV] = 'off'
        try {
            const log = makeDebugAppender('/tmp/x.log', appendFile)
            log('=== verify start ===')
            log('chatter', 'stream')
        } finally {
            delete process.env[DEBUG_LOG_ENV]
        }
        expect(writes).toEqual([])
    })

    test('an unwritable trail never surfaces as a run failure', () => {
        process.env[DEBUG_LOG_ENV] = 'full'
        try {
            const log = makeDebugAppender('/tmp/x.log', () => Promise.reject(new Error('ENOSPC')))
            expect(() => log('anything')).not.toThrow()
        } finally {
            delete process.env[DEBUG_LOG_ENV]
        }
    })

    test('what reaches the file is sanitised, not the raw message', () => {
        const {writes, appendFile} = capture()
        process.env[DEBUG_LOG_ENV] = 'full'
        try {
            makeDebugAppender('/tmp/x.log', appendFile)('tool said \u0000\u001b[31mred\u001b[0m')
        } finally {
            delete process.env[DEBUG_LOG_ENV]
        }
        expect(writes[0]).toMatch(/ tool said \[31mred\[0m\n$/)
    })
})

/**
 * The defect: a 247 KB `verify-debug.log` held terminal control bytes and NULs, so
 * `grep` called the whole file binary and printed nothing — the trail's one job.
 */
describe('sanitizeDebugLine', () => {
    // Only the control CHARACTERS go; an escape sequence's printable tail (`[0m`)
    // stays behind. That residue is plain ASCII — it is the ESC byte that makes
    // the file binary to grep, not the letters after it.
    test('strips control characters, NUL first among them', () => {
        expect(sanitizeDebugLine('a\u0000b\u0007c\u001b[0md')).toBe('abc[0md')
    })

    test('keeps newlines, so a multi-line message stays multi-line', () => {
        expect(sanitizeDebugLine('one\ntwo\nthree')).toBe('one\ntwo\nthree')
        // A CR is a control character like any other; the line break is the \n.
        expect(sanitizeDebugLine('one\r\ntwo')).toBe('one\ntwo')
    })

    test('caps a runaway line and says how much it dropped', () => {
        const capped = sanitizeDebugLine('x'.repeat(DEBUG_LINE_LIMIT + 42))
        expect(capped).toBe(`${'x'.repeat(DEBUG_LINE_LIMIT)}…+42 chars`)
    })

    test('caps each line of a multi-line message on its own', () => {
        const long = 'y'.repeat(DEBUG_LINE_LIMIT + 1)
        expect(sanitizeDebugLine(`short\n${long}\nshort`).split('\n')).toEqual([
            'short',
            `${'y'.repeat(DEBUG_LINE_LIMIT)}…+1 chars`,
            'short'
        ])
    })

    test('a line at the limit is left exactly as it is', () => {
        const exact = 'z'.repeat(DEBUG_LINE_LIMIT)
        expect(sanitizeDebugLine(exact)).toBe(exact)
    })
})

describe('gateDebugWriter', () => {
    // Returning undefined rather than a no-op function is what lets every
    // `logDebug?.(…)` site short-circuit at the `?.` — before it formats a
    // message string. A no-op would still cost every one of those formats.
    test('returns undefined at off, so every optional call site skips its work', () => {
        expect(gateDebugWriter(() => {}, env({[DEBUG_LOG_ENV]: 'off'}))).toBeUndefined()
    })

    test('routes by kind at events', () => {
        const seen: string[] = []
        const write = gateDebugWriter(m => void seen.push(m), env({[DEBUG_LOG_ENV]: 'events'}))
        write?.('phase:research: start')
        write?.('worker said something', 'stream')
        expect(seen).toEqual(['phase:research: start'])
    })

    test('passes everything through at full', () => {
        const seen: string[] = []
        const write = gateDebugWriter(m => void seen.push(m), env({[DEBUG_LOG_ENV]: 'full'}))
        write?.('phase:research: start')
        write?.('worker said something', 'stream')
        expect(seen).toHaveLength(2)
    })
})
