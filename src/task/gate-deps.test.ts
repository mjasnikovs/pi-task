/**
 * gate-deps tests — the tool-result log summary used by the gate debug log
 * (mx5 run 10 item 6). The summary is pure; the wiring that feeds it real tool
 * output is covered in json-event-sink.test.ts (the sink emits onToolResult).
 */
import {describe, expect, test} from 'bun:test'
import {truncateToolResult} from './gate-deps.js'

describe('truncateToolResult', () => {
    test('flattens whitespace to one line', () => {
        expect(truncateToolResult('line one\n  line two\ttabbed')).toBe('line one line two tabbed')
    })

    test('empty / whitespace-only output → (no output)', () => {
        expect(truncateToolResult('')).toBe('(no output)')
        expect(truncateToolResult('   \n\t ')).toBe('(no output)')
    })

    test('keeps the TAIL (where a bind failure / status lands) with a leading ellipsis', () => {
        const long = 'x'.repeat(500) + ' curl: (7) Failed to connect to localhost port 3000'
        const out = truncateToolResult(long, 40)
        expect(out.startsWith('…')).toBe(true)
        expect(out).toContain('port 3000')
        expect(out.length).toBe(41) // ellipsis + 40 tail chars
    })

    test('short output is kept verbatim (no ellipsis)', () => {
        expect(truncateToolResult('HELLO_WORLD_123')).toBe('HELLO_WORLD_123')
    })
})
