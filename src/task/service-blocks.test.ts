import {describe, expect, test} from 'bun:test'
import {formatServiceBlock, formatFreshnessSkippedBlock} from './service-blocks.js'

describe('formatServiceBlock', () => {
    test('with 0 results returns just header + Query line', () => {
        const out = formatServiceBlock('Twitch', 'Twitch eventsub', [])
        expect(out).toBe('### service: Twitch\nQuery: Twitch eventsub')
    })

    test('with one result includes a bullet in `- **title** — url\\n  description` form', () => {
        const out = formatServiceBlock('Twitch', 'Twitch eventsub', [
            {
                title: 'EventSub',
                url: 'https://dev.twitch.tv/docs/eventsub',
                description: 'replaces PubSub'
            }
        ])
        expect(out).toBe(
            '### service: Twitch\nQuery: Twitch eventsub\n'
                + '- **EventSub** — https://dev.twitch.tv/docs/eventsub\n  replaces PubSub'
        )
    })

    test('with multiple results joins bullets with newlines', () => {
        const out = formatServiceBlock('Stripe', 'Stripe webhooks', [
            {title: 'A', url: 'https://a', description: 'da'},
            {title: 'B', url: 'https://b', description: 'db'}
        ])
        expect(out).toContain('### service: Stripe\nQuery: Stripe webhooks\n')
        expect(out).toContain('- **A** — https://a\n  da')
        expect(out).toContain('- **B** — https://b\n  db')
        // Bullets are joined with '\n' (no blank line between them).
        expect(out).toContain('da\n- **B**')
    })
})

describe('formatFreshnessSkippedBlock', () => {
    test('with a single name produces a one-bullet block', () => {
        const out = formatFreshnessSkippedBlock(['Twitch'])
        expect(out).toBe(
            '### freshness-check skipped\n'
                + 'Could not verify external services (search provider is brave but BRAVE_SEARCH_API_KEY is not set):\n'
                + '- Twitch'
        )
    })

    test('with two names produces a two-bullet block joined by newlines', () => {
        const out = formatFreshnessSkippedBlock(['Twitch', 'Stripe'])
        expect(out).toBe(
            '### freshness-check skipped\n'
                + 'Could not verify external services (search provider is brave but BRAVE_SEARCH_API_KEY is not set):\n'
                + '- Twitch\n- Stripe'
        )
    })
})
