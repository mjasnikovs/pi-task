import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CHILD_BASE_ARGS} from './child-process.js'
import {childBaseArgs, extensionArgs} from './child-extensions.js'
import {getConfig, sanitizeExtensionWhitelist} from '../config/config.js'

const exists = (ok: boolean) => () => ok

describe('extensionArgs', () => {
    test('maps each whitelisted path to a -e pair', () => {
        expect(extensionArgs(['/a/ext.ts', '/b/index.js'], exists(true))).toEqual([
            '-e',
            '/a/ext.ts',
            '-e',
            '/b/index.js'
        ])
    })

    test('skips a path whose file is gone (extension uninstalled) instead of failing the spawn', () => {
        const onlyA = (p: string): boolean => p === '/a/ext.ts'
        expect(extensionArgs(['/a/ext.ts', '/gone/ext.ts'], onlyA)).toEqual(['-e', '/a/ext.ts'])
    })

    test('dedupes so a path can never be loaded twice', () => {
        expect(extensionArgs(['/a.ts', '/a.ts'], exists(true))).toEqual(['-e', '/a.ts'])
    })

    test('ignores empty and blank entries from a hand-edited config', () => {
        expect(extensionArgs(['', '   ', '/a.ts'], exists(true))).toEqual(['-e', '/a.ts'])
    })
})

describe('sanitizeExtensionWhitelist', () => {
    test('non-array and non-string members collapse to a safe list', () => {
        expect(sanitizeExtensionWhitelist(undefined)).toEqual([])
        expect(sanitizeExtensionWhitelist('nope')).toEqual([])
        expect(sanitizeExtensionWhitelist([1, {}, null, '/ok.ts', ' '])).toEqual(['/ok.ts'])
    })
})

describe('childBaseArgs', () => {
    test('with an empty whitelist the argv is exactly CHILD_BASE_ARGS (isolation unchanged)', () => {
        const prev = getConfig().extensionWhitelist
        getConfig().extensionWhitelist = []
        try {
            expect(childBaseArgs()).toEqual([...CHILD_BASE_ARGS])
        } finally {
            getConfig().extensionWhitelist = prev
        }
    })

    test('a whitelisted existing file is injected as -e BEFORE --no-extensions, per spawn', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-wl-'))
        const ext = path.join(dir, 'provider.ts')
        fs.writeFileSync(ext, '// test extension\n')
        const prev = getConfig().extensionWhitelist
        getConfig().extensionWhitelist = [ext, path.join(dir, 'uninstalled.ts')]
        try {
            const args = childBaseArgs()
            expect(args.slice(0, 2)).toEqual(['-e', ext])
            // The uninstalled entry is skipped, not fatal.
            expect(args.filter(a => a === '-e')).toHaveLength(1)
            expect(args).toContain('--no-extensions')
        } finally {
            getConfig().extensionWhitelist = prev
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('internal worker extensions ride first verbatim and dedupe against the whitelist', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-wl-'))
        const worker = path.join(dir, 'worker-ext.js')
        const user = path.join(dir, 'user-ext.ts')
        fs.writeFileSync(worker, '')
        fs.writeFileSync(user, '')
        const prev = getConfig().extensionWhitelist
        // The worker extension also appears in the whitelist: must not double-load.
        getConfig().extensionWhitelist = [worker, user]
        try {
            const args = childBaseArgs([worker])
            expect(args.slice(0, 4)).toEqual(['-e', worker, '-e', user])
            expect(args.filter(a => a === worker)).toHaveLength(1)
        } finally {
            getConfig().extensionWhitelist = prev
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })
})
