import {describe, expect, test} from 'bun:test'
import {applyExtensionToggle, extensionItems} from './register.js'

describe('extensionItems', () => {
    const installed = [
        {path: '/x/pi-lmstudio/index.ts', label: 'pi-lmstudio', origin: 'npm:pi-lmstudio (user)'},
        {path: '/y/theme.ts', label: 'theme', origin: 'discovered (user)'}
    ]

    test('one on/off toggle per installed extension, current state from the whitelist', () => {
        const items = extensionItems(installed, ['/x/pi-lmstudio/index.ts'])
        expect(items).toHaveLength(2)
        expect(items[0]!.id).toBe('ext:/x/pi-lmstudio/index.ts')
        expect(items[0]!.label).toBe('ext: pi-lmstudio')
        expect(items[0]!.currentValue).toBe('on')
        expect(items[1]!.currentValue).toBe('off')
        expect(items[0]!.values).toEqual(['on', 'off'])
    })

    test('description carries provenance and the trust caveat', () => {
        const items = extensionItems(installed, [])
        expect(items[0]!.description).toContain('npm:pi-lmstudio (user)')
        expect(items[0]!.description).toContain('trust')
    })
})

describe('applyExtensionToggle', () => {
    test('on adds once, off removes; both idempotent', () => {
        let wl: string[] = []
        wl = applyExtensionToggle(wl, '/a.ts', true)
        wl = applyExtensionToggle(wl, '/a.ts', true)
        expect(wl).toEqual(['/a.ts'])
        wl = applyExtensionToggle(wl, '/a.ts', false)
        wl = applyExtensionToggle(wl, '/a.ts', false)
        expect(wl).toEqual([])
    })

    test('toggling one entry leaves the others alone', () => {
        const wl = applyExtensionToggle(['/a.ts', '/b.ts'], '/a.ts', false)
        expect(wl).toEqual(['/b.ts'])
    })
})
