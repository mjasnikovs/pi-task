import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CompressionCache, hashText} from './cache.js'

const tmpFiles: string[] = []
function tmpFile(): string {
    const f = path.join(os.tmpdir(), `pi-task-cache-${crypto.randomUUID()}.json`)
    tmpFiles.push(f)
    return f
}

afterEach(() => {
    for (const f of tmpFiles.splice(0)) {
        try {
            fs.rmSync(f, {force: true})
        } catch {
            // ignore
        }
    }
})

describe('hashText', () => {
    test('is deterministic and distinguishes content', () => {
        expect(hashText('abc')).toBe(hashText('abc'))
        expect(hashText('abc')).not.toBe(hashText('abd'))
    })
})

describe('CompressionCache', () => {
    test('get/has/set round-trip in memory', () => {
        const c = new CompressionCache(tmpFile())
        const h = hashText('reasoning')
        expect(c.has(h)).toBe(false)
        expect(c.get(h)).toBeUndefined()
        c.set(h, 'short')
        expect(c.has(h)).toBe(true)
        expect(c.get(h)).toBe('short')
        expect(c.size).toBe(1)
    })

    test('persists across instances (compress once, ever)', () => {
        const file = tmpFile()
        const h = hashText('big block')
        new CompressionCache(file).set(h, 'compressed')

        const reopened = new CompressionCache(file)
        expect(reopened.get(h)).toBe('compressed')
        expect(reopened.size).toBe(1)
    })

    test('survives a missing/corrupt file without throwing', () => {
        const file = tmpFile()
        fs.writeFileSync(file, 'not json{')
        const c = new CompressionCache(file)
        expect(c.size).toBe(0)
        c.set('h', 'v')
        expect(c.get('h')).toBe('v')
    })
})
