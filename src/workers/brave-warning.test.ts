import {expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import type {SearchProvider} from './search-types.js'
import {registerBraveKeyWarning} from './brave-warning.js'

/** Fire session_start with the given provider/env and report whether the hint rendered. */
function widgetRendered(provider: SearchProvider, braveKey: string | undefined): boolean {
    let handler: ((event: unknown, ctx: unknown) => void) | undefined
    const pi = {
        on: (_event: string, cb: (event: unknown, ctx: unknown) => void) => {
            handler = cb
        }
    } as unknown as ExtensionAPI

    let rendered = false
    const ctx = {
        mode: 'tui',
        ui: {
            setWidget: (_key: string, value: unknown) => {
                if (value !== undefined) rendered = true
            },
            onTerminalInput: () => () => {},
            theme: {fg: (_color: string, s: string) => s}
        }
    }

    const prevProvider = getConfig().searchProvider
    const prevA = process.env.BRAVE_SEARCH_API_KEY
    const prevB = process.env.BRAVE_API_KEY
    getConfig().searchProvider = provider
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY
    if (braveKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = braveKey
    try {
        registerBraveKeyWarning(pi)
        handler!({}, ctx)
    } finally {
        getConfig().searchProvider = prevProvider
        if (prevA !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevA
        if (prevB !== undefined) process.env.BRAVE_API_KEY = prevB
    }
    return rendered
}

test('warning renders when brave is selected and no key is set', () => {
    expect(widgetRendered('brave', undefined)).toBe(true)
})

test('warning is silent when brave is selected and the key is present', () => {
    expect(widgetRendered('brave', 'some-key')).toBe(false)
})

test('warning is silent for keyless providers even without a key', () => {
    expect(widgetRendered('exa', undefined)).toBe(false)
    expect(widgetRendered('ddg', undefined)).toBe(false)
})
