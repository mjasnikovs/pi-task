import {expect, mock, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {readPkgVersion} from './pkg-version.js'

test('reads the shipped version out of package.json', () => {
    const declared = (JSON.parse(readFileSync('package.json', 'utf8')) as {version: string}).version
    expect(readPkgVersion()).toBe(declared)
})

test('falls back to 0.0.0 rather than throwing when package.json is unreadable', async () => {
    // Every caller is cosmetic (a User-Agent, a title bar); an unreadable
    // package.json must never take a run down.
    void mock.module('node:fs', () => ({
        readFileSync: () => {
            throw new Error('ENOENT')
        }
    }))
    try {
        const fresh = (await import('./pkg-version.js')) as {readPkgVersion: () => string}
        expect(fresh.readPkgVersion()).toBe('0.0.0')
    } finally {
        mock.restore()
    }
})
