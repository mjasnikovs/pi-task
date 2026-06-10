import {execFile} from 'node:child_process'

/** Injectable command runner so serve orchestration is unit-testable without a real CLI. */
export interface Run {
    (cmd: string, args: string[]): Promise<{stdout: string; stderr: string; exitCode: number}>
}

export type ServeResult =
    | {state: 'served'; url: string}
    | {state: 'foreign-conflict'; host: string}
    | {state: 'certs-disabled'; host: string}
    | {state: 'unavailable'}

export interface RemoteUrlPlan {
    /** URL to encode in the QR and announce; the https one when serve is live. */
    primaryUrl: string
    /** Labeled URL lines to add to the address list (e.g. the HTTPS URL when served). */
    urlLines: {label: string; url: string}[]
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

/** The "/" proxy target of the first :443 Web handler in `tailscale serve status --json`,
 *  or undefined when there is no such handler / the output isn't valid serve JSON
 *  (e.g. the literal "No serve config"). */
export function serve443Target(json: string): string | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(json)
    } catch {
        return undefined
    }
    const web = (parsed as {Web?: Record<string, {Handlers?: Record<string, {Proxy?: string}>}>})
        .Web
    if (!web) return undefined
    for (const key of Object.keys(web)) {
        if (key.endsWith(':443')) return web[key]?.Handlers?.['/']?.Proxy
    }
    return undefined
}

/** Tailscale MagicDNS name (trailing dot stripped), or undefined if the daemon
 *  isn't reachable / has no name. */
async function tailscaleHost(run: Run): Promise<string | undefined> {
    const status = await run('tailscale', ['status', '--json'])
    if (status.exitCode !== 0) return undefined
    try {
        const parsed = JSON.parse(status.stdout) as {Self?: {DNSName?: string}}
        return (parsed.Self?.DNSName ?? '').replace(/\.$/, '') || undefined
    } catch {
        return undefined
    }
}

/** Ensure Tailscale serves https://<host> → http://127.0.0.1:<port>. Mutates only
 *  when needed and never touches a serve config we didn't create. Best-effort:
 *  returns a non-served state rather than throwing. */
export async function ensureTailscaleServe(
    port: number,
    run: Run = defaultRun
): Promise<ServeResult> {
    const host = await tailscaleHost(run)
    if (!host) return {state: 'unavailable'}

    const ours = `http://127.0.0.1:${port}`
    const serve = await run('tailscale', ['serve', 'status', '--json'])
    const target = serve443Target(serve.stdout)
    if (target === ours) return {state: 'served', url: `https://${host}`}
    if (target !== undefined) return {state: 'foreign-conflict', host}

    // No :443 handler yet — check cert capability before trying to create one.
    const cert = await run('tailscale', ['cert'])
    if (/HTTPS cert support is not enabled/i.test(cert.stdout + cert.stderr)) {
        return {state: 'certs-disabled', host}
    }

    const set = await run('tailscale', ['serve', '--bg', '--https=443', ours])
    if (set.exitCode === 0) return {state: 'served', url: `https://${host}`}
    return {state: 'certs-disabled', host}
}

/** Tear down the :443 serve handler ONLY if it currently points at our port.
 *  Best-effort; callers should additionally `.catch()` since it may run during
 *  shutdown. */
export async function teardownTailscaleServe(port: number, run: Run = defaultRun): Promise<void> {
    const serve = await run('tailscale', ['serve', 'status', '--json'])
    if (serve443Target(serve.stdout) === `http://127.0.0.1:${port}`) {
        await run('tailscale', ['serve', '--https=443', 'off'])
    }
}

/** Pure: pick the primary URL and any hint lines from a serve result. */
export function planRemoteUrls(httpPrimary: string, result: ServeResult): RemoteUrlPlan {
    switch (result.state) {
        case 'served':
            return {
                primaryUrl: result.url,
                urlLines: [{label: 'HTTPS', url: result.url}],
                hintLines: []
            }
        case 'foreign-conflict':
            return {
                primaryUrl: httpPrimary,
                urlLines: [],
                hintLines: [
                    'HTTPS: port 443 is already used by another tailscale serve config; not touching it.',
                    '  Free it (tailscale serve --https=443 off) to enable phone notifications.'
                ]
            }
        case 'certs-disabled':
            return {
                primaryUrl: httpPrimary,
                urlLines: [],
                hintLines: [
                    'HTTPS (for phone notifications): enable HTTPS in the Tailscale admin console, then restart the remote.'
                ]
            }
        case 'unavailable':
            return {primaryUrl: httpPrimary, urlLines: [], hintLines: []}
    }
}
