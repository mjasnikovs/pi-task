import {describe, it, expect} from 'bun:test'
import {
    ensureTailscaleServe,
    teardownTailscaleServe,
    planRemoteUrls,
    serve443Target
} from './tailscale.js'
import type {Run} from './tailscale.js'

interface Call {
    cmd: string
    args: string[]
}

// Records every command and returns canned output keyed by a subcommand label.
function recordingRun(map: Record<string, {stdout?: string; stderr?: string; exitCode?: number}>): {
    run: Run
    calls: Call[]
} {
    const calls: Call[] = []
    const run: Run = async (cmd, args) => {
        calls.push({cmd, args})
        let key: string
        if (args[0] === 'status') key = 'status'
        else if (args[0] === 'serve' && args[1] === 'status') key = 'serve-status'
        else if (args[0] === 'serve' && args.includes('off')) key = 'serve-off'
        else if (args[0] === 'serve') key = 'serve-set'
        else key = args[0]
        const r = map[key] ?? {exitCode: 0}
        return {stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0}
    }
    return {run, calls}
}

const HOST = 'omarchy-1.tailaa4e75.ts.net'
const STATUS_OK = JSON.stringify({Self: {DNSName: HOST + '.'}})
const served = (target: string) =>
    JSON.stringify({Web: {[`${HOST}:443`]: {Handlers: {'/': {Proxy: target}}}}})

describe('serve443Target()', () => {
    it('returns the / proxy target of the :443 handler', () => {
        expect(serve443Target(served('http://127.0.0.1:8800'))).toBe('http://127.0.0.1:8800')
    })
    it('returns undefined for "No serve config" (not JSON)', () => {
        expect(serve443Target('No serve config')).toBeUndefined()
    })
    it('returns undefined for malformed JSON', () => {
        expect(serve443Target('{bad')).toBeUndefined()
    })
    it('returns undefined when there is no :443 handler', () => {
        const json = JSON.stringify({Web: {[`${HOST}:80`]: {Handlers: {'/': {Proxy: 'x'}}}}})
        expect(serve443Target(json)).toBeUndefined()
    })
})

describe('ensureTailscaleServe()', () => {
    it('returns unavailable when status fails (and probes nothing else)', async () => {
        const {run, calls} = recordingRun({status: {exitCode: 1}})
        expect(await ensureTailscaleServe(8800, run)).toEqual({state: 'unavailable'})
        expect(calls.map(c => c.args[0])).toEqual(['status'])
    })

    it('is idempotent: served + no serve-set when :443 already points at our port', async () => {
        const {run, calls} = recordingRun({
            status: {stdout: STATUS_OK},
            'serve-status': {stdout: served('http://127.0.0.1:8800')}
        })
        expect(await ensureTailscaleServe(8800, run)).toEqual({
            state: 'served',
            url: `https://${HOST}`
        })
        expect(calls.some(c => c.args.includes('--bg'))).toBe(false)
    })

    it('foreign-conflict + no mutation when :443 points elsewhere', async () => {
        const {run, calls} = recordingRun({
            status: {stdout: STATUS_OK},
            'serve-status': {stdout: served('http://127.0.0.1:9999')}
        })
        expect(await ensureTailscaleServe(8800, run)).toEqual({
            state: 'foreign-conflict',
            host: HOST
        })
        expect(calls.some(c => c.args.includes('--bg'))).toBe(false)
    })

    it('certs-disabled + no serve-set when no handler and certs off', async () => {
        const {run, calls} = recordingRun({
            status: {stdout: STATUS_OK},
            'serve-status': {stdout: 'No serve config'},
            cert: {
                stderr: 'HTTPS cert support is not enabled/configured for your tailnet.',
                exitCode: 1
            }
        })
        expect(await ensureTailscaleServe(8800, run)).toEqual({
            state: 'certs-disabled',
            host: HOST
        })
        expect(calls.some(c => c.args.includes('--bg'))).toBe(false)
    })

    it('sets up serve and returns served when no handler and certs enabled', async () => {
        const {run, calls} = recordingRun({
            status: {stdout: STATUS_OK},
            'serve-status': {stdout: 'No serve config'},
            cert: {stdout: 'Usage: tailscale cert [flags] <domain>', exitCode: 1},
            'serve-set': {exitCode: 0}
        })
        expect(await ensureTailscaleServe(8800, run)).toEqual({
            state: 'served',
            url: `https://${HOST}`
        })
        const setCall = calls.find(c => c.args.includes('--bg'))
        expect(setCall?.args).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:8800'])
    })

    it('certs-disabled when the serve-set command itself fails', async () => {
        const {run} = recordingRun({
            status: {stdout: STATUS_OK},
            'serve-status': {stdout: 'No serve config'},
            cert: {stdout: 'Usage: tailscale cert', exitCode: 1},
            'serve-set': {exitCode: 1}
        })
        expect(await ensureTailscaleServe(8800, run)).toEqual({
            state: 'certs-disabled',
            host: HOST
        })
    })
})

describe('teardownTailscaleServe()', () => {
    it('issues serve off when :443 points at our port', async () => {
        const {run, calls} = recordingRun({
            'serve-status': {stdout: served('http://127.0.0.1:8800')}
        })
        await teardownTailscaleServe(8800, run)
        const off = calls.find(c => c.args.includes('off'))
        expect(off?.args).toEqual(['serve', '--https=443', 'off'])
    })

    it('does nothing when :443 points elsewhere', async () => {
        const {run, calls} = recordingRun({
            'serve-status': {stdout: served('http://127.0.0.1:9999')}
        })
        await teardownTailscaleServe(8800, run)
        expect(calls.some(c => c.args.includes('off'))).toBe(false)
    })

    it('does nothing when there is no serve config', async () => {
        const {run, calls} = recordingRun({'serve-status': {stdout: 'No serve config'}})
        await teardownTailscaleServe(8800, run)
        expect(calls.some(c => c.args.includes('off'))).toBe(false)
    })
})

describe('planRemoteUrls()', () => {
    const http = 'http://100.83.115.70:8800'
    it('served → https url, no hint', () => {
        expect(planRemoteUrls(http, {state: 'served', url: 'https://h.ts.net'})).toEqual({
            primaryUrl: 'https://h.ts.net',
            hintLines: []
        })
    })
    it('foreign-conflict → http + conflict hint', () => {
        const plan = planRemoteUrls(http, {state: 'foreign-conflict', host: 'h.ts.net'})
        expect(plan.primaryUrl).toBe(http)
        expect(plan.hintLines.join('\n')).toContain(
            'already used by another tailscale serve config'
        )
    })
    it('certs-disabled → http + admin hint', () => {
        const plan = planRemoteUrls(http, {state: 'certs-disabled', host: 'h.ts.net'})
        expect(plan.primaryUrl).toBe(http)
        expect(plan.hintLines.join('\n')).toContain('admin console')
    })
    it('unavailable → http, no hint', () => {
        expect(planRemoteUrls(http, {state: 'unavailable'})).toEqual({
            primaryUrl: http,
            hintLines: []
        })
    })
})
