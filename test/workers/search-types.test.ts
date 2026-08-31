import {expect, test} from 'bun:test'
import {
    SEARCH_PROVIDERS,
    SEARCH_PROVIDER_LABELS,
    isSearchProvider,
    providerForLabel
} from '../../src/workers/search-types.js'

test('every provider has a distinct display label that round-trips back to its id', () => {
    for (const provider of SEARCH_PROVIDERS) {
        expect(providerForLabel(SEARCH_PROVIDER_LABELS[provider])).toBe(provider)
    }
    expect(new Set(Object.values(SEARCH_PROVIDER_LABELS)).size).toBe(SEARCH_PROVIDERS.length)
})

test('providerForLabel rejects unknown labels; isSearchProvider guards the stored ids', () => {
    expect(providerForLabel('Google')).toBeUndefined()
    // Labels are display-only. config.ts validates the stored value with
    // `isSearchProvider`, so a label written into the config file is rejected.
    expect(isSearchProvider('DuckDuckGo')).toBe(false)
    expect(isSearchProvider('ddg')).toBe(true)
})
