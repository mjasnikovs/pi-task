import {describe, expect, test} from 'bun:test'
import {
    extractUserDirectives,
    directiveSurvives,
    preserveDirectivesBlock,
    enforceDirectives
} from '../../src/task/user-directives.js'

describe('extractUserDirectives — web search', () => {
    // The exact mx5 run-9 raw prompt that refine silently stripped.
    const MX5_RAW =
        'Research Playwright best practices via web search — focus on E2E testing patterns for Next.js apps with auth sessions'

    test('detects "via web search" (the mx5 run-9 regression)', () => {
        const d = extractUserDirectives(MX5_RAW)
        expect(d.map(x => x.kind)).toEqual(['web-search'])
    })

    test.each([
        'Please use web search to find current best practices',
        'search the web for the latest API',
        'search the internet for recent changes',
        'do some web-searching before you answer',
        'research this online — search online first'
    ])('detects a web-search directive in: %s', prompt => {
        expect(extractUserDirectives(prompt).some(d => d.kind === 'web-search')).toBe(true)
    })

    test.each([
        'search the codebase for the auth handler',
        'search for the requireAuth function in src/',
        'grep the repo and summarize the routes',
        'add a search box to the marketplace page',
        'implement full-text search over listings'
    ])('does NOT fire on local/feature "search" wording: %s', prompt => {
        expect(extractUserDirectives(prompt)).toEqual([])
    })

    test.each([
        'do not use web search, rely only on the local files',
        'without any web search, summarize the code',
        "don't search the web — everything you need is in the repo"
    ])('ignores a NEGATED web-search mention: %s', prompt => {
        expect(extractUserDirectives(prompt)).toEqual([])
    })
})

describe('extractUserDirectives — fetch url', () => {
    test('captures the URL from an explicit fetch directive', () => {
        const d = extractUserDirectives('fetch https://example.com/api/spec and summarize it')
        expect(d[0]?.kind).toBe('fetch-url')
        expect(d[0]?.must).toContain('https://example.com/api/spec')
    })

    test('does not fire on plain "fetch" with no URL', () => {
        expect(extractUserDirectives('use fetch() to call the endpoint')).toEqual([])
    })
})

describe('directiveSurvives / enforceDirectives (the backstop lever)', () => {
    const raw = 'Research best practices via web search'
    const [directive] = extractUserDirectives(raw)

    test('a refined spec that still mentions web search is left untouched', () => {
        const refined = 'GOAL\n  Do research using pi-worker-search for web sources.\n'
        expect(directiveSurvives(refined, directive)).toBe(true)
        const {text, appended} = enforceDirectives(refined, [directive])
        expect(appended).toEqual([])
        expect(text).toBe(refined)
    })

    test('a refined spec that DROPPED the directive gets it appended verbatim', () => {
        // The real mx5 refined text: no web-search mention anywhere.
        const refined =
            'GOAL\n  Produce a concise research summary from the local files.\nCONSTRAINTS\n  - research-only\n'
        expect(directiveSurvives(refined, directive)).toBe(false)
        const {text, appended} = enforceDirectives(refined, [directive])
        expect(appended).toHaveLength(1)
        expect(text).toContain('USER TOOL DIRECTIVES')
        expect(text).toMatch(/pi-worker-search/i)
        // And the appended text now itself survives the check (idempotent).
        expect(directiveSurvives(text, directive)).toBe(true)
        const second = enforceDirectives(text, [directive])
        expect(second.appended).toEqual([])
    })

    test('no directives → no block, no injection (0 false positives)', () => {
        expect(preserveDirectivesBlock([])).toBe('')
        const refined = 'GOAL\n  Add a login form.\n'
        expect(enforceDirectives(refined, []).text).toBe(refined)
    })
})
