import {expect, test} from 'bun:test'
import {
    SEARCH_PROVIDERS,
    SEARCH_PROVIDER_LABELS,
    isSearchProvider,
    providerForLabel
} from './search-types.js'

test('every provider has a distinct display label that round-trips back to its id', () => {
    for (const provider of SEARCH_PROVIDERS) {
        expect(providerForLabel(SEARCH_PROVIDER_LABELS[provider])).toBe(provider)
    }
    expect(new Set(Object.values(SEARCH_PROVIDER_LABELS)).size).toBe(SEARCH_PROVIDERS.length)
})

test('providerForLabel rejects unknown labels; isSearchProvider guards the stored ids', () => {
    expect(providerForLabel('Google')).toBeUndefined()
    // Display labels are NOT valid stored values — the config keeps short ids.
    expect(isSearchProvider('DuckDuckGo')).toBe(false)
    expect(isSearchProvider('ddg')).toBe(true)
})
