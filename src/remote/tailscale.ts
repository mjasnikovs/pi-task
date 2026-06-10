import {execFile} from 'node:child_process'

/** Injectable command runner so detection is unit-testable without a real CLI. */
export interface Run {
    (cmd: string, args: string[]): Promise<{stdout: string; stderr: string; exitCode: number}>
}

export type TailscaleHttps =
    | {state: 'served'; host: string; url: string}
    | {state: 'not-served'; host: string}
    | {state: 'certs-disabled'; host: string}
    | {state: 'unavailable'}

export interface RemoteUrlPlan {
    /** URL to encode in the QR and announce; the https one when available. */
    primaryUrl: string
    /** Extra lines to print under the URLs (empty when nothing to suggest). */
    hintLines: string[]
}

const defaultRun: Run = (cmd, args) =>
    new Promise(resolve => {
        execFile(cmd, args, {timeout: 5000}, (err, stdout, stderr) => {
            const exitCode =
                err && typeof (err as {code?: unknown}).code === 'number' ?
                    (err as {code: number}).code
                : err ? 1
                : 0
            resolve({stdout: stdout ?? '', stderr: stderr ?? '', exitCode})
        })
    })

/** Read-only probe of the local Tailscale daemon: never mutates serve state. */
export async function getTailscaleHttps(run: Run = defaultRun): Promise<TailscaleHttps> {
    const status = await run('tailscale', ['status', '--json'])
    if (status.exitCode !== 0) return {state: 'unavailable'}

    let dnsName: string
    try {
        const parsed = JSON.parse(status.stdout) as {Self?: {DNSName?: string}}
        dnsName = (parsed.Self?.DNSName ?? '').replace(/\.$/, '')
    } catch {
        return {state: 'unavailable'}
    }
    if (!dnsName) return {state: 'unavailable'}

    const serve = await run('tailscale', ['serve', 'status'])
    const httpsMatch = serve.stdout.match(/https:\/\/\S+/)
    if (httpsMatch) {
        return {state: 'served', host: dnsName, url: httpsMatch[0]}
    }

    const cert = await run('tailscale', ['cert'])
    const certText = cert.stdout + cert.stderr
    if (/HTTPS cert support is not enabled/i.test(certText)) {
        return {state: 'certs-disabled', host: dnsName}
    }
    return {state: 'not-served', host: dnsName}
}

/** Pure: pick the primary URL and any hint lines from a detection result. */
export function planRemoteUrls(
    httpPrimary: string,
    port: number,
    ts: TailscaleHttps
): RemoteUrlPlan {
    const serveCmd = `  tailscale serve --bg --https=443 http://127.0.0.1:${port}`
    switch (ts.state) {
        case 'served':
            return {primaryUrl: ts.url, hintLines: []}
        case 'not-served':
            return {primaryUrl: httpPrimary, hintLines: ['HTTPS: run', serveCmd]}
        case 'certs-disabled':
            return {
                primaryUrl: httpPrimary,
                hintLines: [
                    'HTTPS (for phone notifications): enable HTTPS in the Tailscale admin console, then run',
                    serveCmd
                ]
            }
        case 'unavailable':
            return {primaryUrl: httpPrimary, hintLines: []}
    }
}
