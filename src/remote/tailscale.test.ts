import {describe, it, expect} from 'bun:test'
import {getTailscaleHttps, planRemoteUrls} from './tailscale.js'
import type {Run} from './tailscale.js'

// Build a fake `run` that returns canned output keyed by the first CLI arg.
function fakeRun(map: Record<string, {stdout?: string; stderr?: string; exitCode?: number}>): Run {
    return async (_cmd, args) => {
        const key = args[0] === 'serve' ? 'serve' : args[0]
        const r = map[key] ?? {exitCode: 1}
        return {stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0}
    }
}

const STATUS_OK = JSON.stringify({Self: {DNSName: 'omarchy-1.tailaa4e75.ts.net.'}})

describe('getTailscaleHttps()', () => {
    it('returns unavailable when tailscale status fails', async () => {
        const res = await getTailscaleHttps(fakeRun({status: {exitCode: 1}}))
        expect(res.state).toBe('unavailable')
    })

    it('returns unavailable when there is no Self.DNSName', async () => {
        const res = await getTailscaleHttps(fakeRun({status: {stdout: '{"Self":{}}'}}))
        expect(res.state).toBe('unavailable')
    })

    it('returns served and strips the trailing dot when serve has an https handler', async () => {
        const res = await getTailscaleHttps(
            fakeRun({
                status: {stdout: STATUS_OK},
                serve: {
                    stdout: 'https://omarchy-1.tailaa4e75.ts.net\n|-- / proxy http://127.0.0.1:8800'
                }
            })
        )
        expect(res).toEqual({
            state: 'served',
            host: 'omarchy-1.tailaa4e75.ts.net',
            url: 'https://omarchy-1.tailaa4e75.ts.net'
        })
    })

    it('returns certs-disabled when serve is empty and cert support is off', async () => {
        const res = await getTailscaleHttps(
            fakeRun({
                status: {stdout: STATUS_OK},
                serve: {stdout: 'No serve config'},
                cert: {
                    stderr: 'HTTPS cert support is not enabled/configured for your tailnet.',
                    exitCode: 1
                }
            })
        )
        expect(res).toEqual({state: 'certs-disabled', host: 'omarchy-1.tailaa4e75.ts.net'})
    })

    it('returns not-served when certs are enabled but no serve handler exists', async () => {
        const res = await getTailscaleHttps(
            fakeRun({
                status: {stdout: STATUS_OK},
                serve: {stdout: 'No serve config'},
                cert: {stdout: 'Usage: tailscale cert [flags] <domain>', exitCode: 1}
            })
        )
        expect(res).toEqual({state: 'not-served', host: 'omarchy-1.tailaa4e75.ts.net'})
    })
})

describe('planRemoteUrls()', () => {
    const http = 'http://100.83.115.70:8800'

    it('prefers the https url and adds no hint when served', () => {
        const plan = planRemoteUrls(http, 8800, {
            state: 'served',
            host: 'h.ts.net',
            url: 'https://h.ts.net'
        })
        expect(plan.primaryUrl).toBe('https://h.ts.net')
        expect(plan.hintLines).toEqual([])
    })

    it('keeps http and hints the serve command when not-served', () => {
        const plan = planRemoteUrls(http, 8800, {state: 'not-served', host: 'h.ts.net'})
        expect(plan.primaryUrl).toBe(http)
        expect(plan.hintLines.join('\n')).toContain(
            'tailscale serve --bg --https=443 http://127.0.0.1:8800'
        )
    })

    it('keeps http and hints the admin step when certs-disabled', () => {
        const plan = planRemoteUrls(http, 8800, {state: 'certs-disabled', host: 'h.ts.net'})
        expect(plan.primaryUrl).toBe(http)
        expect(plan.hintLines.join('\n')).toContain('admin console')
        expect(plan.hintLines.join('\n')).toContain(
            'tailscale serve --bg --https=443 http://127.0.0.1:8800'
        )
    })

    it('keeps http and adds no hint when unavailable', () => {
        const plan = planRemoteUrls(http, 8800, {state: 'unavailable'})
        expect(plan.primaryUrl).toBe(http)
        expect(plan.hintLines).toEqual([])
    })
})
