import {describe, it, expect} from 'bun:test'
import {qrLines} from './qr.js'

describe('qrLines', () => {
    it('returns a non-empty array of strings', async () => {
        const lines = await qrLines('http://192.168.1.1:7600')
        expect(Array.isArray(lines)).toBe(true)
        expect(lines.length).toBeGreaterThan(0)
        expect(typeof lines[0]).toBe('string')
    })

    it('all lines are strings (no nulls)', async () => {
        const lines = await qrLines('http://localhost:7600')
        for (const line of lines) {
            expect(typeof line).toBe('string')
        }
    })
})
