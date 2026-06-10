import {describe, it, expect} from 'bun:test'
import {swJs} from './sw.js'

describe('swJs()', () => {
    it('handles push events by showing a notification', () => {
        const out = swJs()
        expect(out).toContain('addEventListener(\'push\'')
        expect(out).toContain('showNotification')
    })

    it('focuses or opens a window when a notification is clicked', () => {
        const out = swJs()
        expect(out).toContain('addEventListener(\'notificationclick\'')
        expect(out).toContain('openWindow')
    })

    it('suppresses the banner when a window is already focused', () => {
        const out = swJs()
        expect(out).toContain('visibilityState')
        expect(out).toContain('focused')
    })

    it('claims clients on activate so it controls the page immediately', () => {
        const out = swJs()
        expect(out).toContain('clients.claim')
        expect(out).toContain('skipWaiting')
    })
})
