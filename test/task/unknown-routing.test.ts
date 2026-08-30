import {describe, expect, test} from 'bun:test'
import {isIntegrationUnknown} from '../../src/task/unknown-routing.js'

describe('isIntegrationUnknown', () => {
    test('fires on build-wiring / integration unknowns', () => {
        const integration = [
            'The spec names a build plugin but does not define how to wire it; should the '
                + 'stylesheet import structure in the HTML entry be modified?',
            'How should the bundler be configured to pick up this plugin?',
            'Where does the loader hook into the build pipeline?',
            'How do I integrate this middleware into the request pipeline?',
            'How should the plugin be wired into the dev server?',
            'Should the transpiler plugin be registered in the build config or the entry point?'
        ]
        for (const q of integration) {
            expect(isIntegrationUnknown(q)).toBe(true)
        }
    })

    test('does NOT fire on benign value/format/location questions', () => {
        const benign = [
            'Should logs be emitted as JSON or plain text?',
            'What should the default page size be?',
            'Which file holds the auth handler?',
            'What color should the primary button be?',
            'Should the API return 404 or 422 for a missing record?',
            'What should the rate-limit window be in seconds?',
            'Which of the existing components should this replace?'
        ]
        for (const q of benign) {
            expect(isIntegrationUnknown(q)).toBe(false)
        }
    })

    test('requires BOTH a tooling surface and wiring intent', () => {
        // tooling surface, but it is a naming/value question (no wiring intent)
        expect(isIntegrationUnknown('What should the plugin be named?')).toBe(false)
        // wiring intent, but about a non-tooling subject
        expect(
            isIntegrationUnknown('How should we integrate the new copy into the about page?')
        ).toBe(false)
        expect(isIntegrationUnknown('')).toBe(false)
    })
})
