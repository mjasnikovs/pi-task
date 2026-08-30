import {expect, mock, test} from 'bun:test'
import {readFileSync} from 'node:fs'
import {readPkgVersion} from '../../src/shared/pkg-version.js'

test('reads the shipped version out of package.json', () => {
    const declared = (JSON.parse(readFileSync('package.json', 'utf8')) as {version: string}).version
    expect(readPkgVersion()).toBe(declared)
})

test('falls back to 0.0.0 rather than throwing when package.json is unreadable', async () => {
    // Both callers are cosmetic: html-clean.ts puts it in a fetch User-Agent and
    // config/register.ts in the /task-config box title. Neither is worth failing
    // a session over, so an unreadable package.json degrades instead of throwing.
    void mock.module('node:fs', () => ({
        readFileSync: () => {
            throw new Error('ENOENT')
        }
    }))
    try {
        const fresh = (await import('../../src/shared/pkg-version.js')) as {
            readPkgVersion: () => string
        }
        expect(fresh.readPkgVersion()).toBe('0.0.0')
    } finally {
        mock.restore()
    }
})
