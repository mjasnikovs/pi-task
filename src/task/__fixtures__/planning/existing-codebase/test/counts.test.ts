import {describe, expect, test} from 'bun:test'
import {parseLine} from '../src/parse.js'

describe('parseLine', () => {
    test('parses a combined-format line', () => {
        const e = parseLine(
            '203.0.113.7 - - [12/Jul/2026:14:03:22 +0000] "GET /parts/na HTTP/1.1" 200 5123'
        )
        expect(e).not.toBeNull()
        expect(e!.status).toBe(200)
        expect(e!.path).toBe('/parts/na')
    })

    test('returns null on garbage', () => {
        expect(parseLine('not a log line')).toBeNull()
    })
})
