/**
 * The real docs-lookup sequence run 19 issued, recovered from its own debug logs.
 *
 * `pi-worker-docs` logs one `docs: <pkg> "<query>"` line per lookup with an ISO
 * timestamp, so the ORDER is recoverable, not just the multiset. The query text is
 * truncated in the log (`…`) — only the package matters for anything this seam
 * decides, so queries are dropped.
 *
 * Written to answer "does this workload even reach the seam?" before an A/B was
 * built on it — and the answer killed the A/B: over 500 real lookups the redirect
 * loop's auto-install hop fires **0** times, so the metric nexttask 1-1
 * pre-registered (`npm install` invocations, strictly down) has a zero baseline
 * and cannot move. See VALIDATION-DEBT.md, "RULED OUT", and methodology rule 7.
 *
 * Run: bun run scripts/docs-hop-replay.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const RUN19_TREE = '/home/edgars/hub/mx5'

const LOOKUP_RE = /^(\S+Z)\s+.*\bpi-worker-docs:\s+(\S+)\s+"/

export interface Lookup {
    at: string
    pkg: string
}

/** Every docs lookup in a run's `.pi-tasks/*.log`, in timestamp order. */
export function replayLookups(tree: string = RUN19_TREE): Lookup[] {
    const dir = path.join(tree, '.pi-tasks')
    let files: string[]
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.log'))
    } catch {
        return []
    }
    const out: Lookup[] = []
    for (const f of files) {
        let text: string
        try {
            text = fs.readFileSync(path.join(dir, f), 'utf8')
        } catch {
            continue
        }
        for (const line of text.split('\n')) {
            const m = LOOKUP_RE.exec(line)
            if (m) out.push({at: m[1], pkg: m[2]})
        }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at))
}

async function main(): Promise<void> {
    const {walk} = await import('./docs-hop-install-baserate.js')
    const lookups = replayLookups()
    const counts = new Map<string, number>()
    for (const l of lookups) counts.set(l.pkg, (counts.get(l.pkg) ?? 0) + 1)
    console.log(`lookups: ${lookups.length}  distinct packages: ${counts.size}  tree: ${RUN19_TREE}`)
    let hops = 0
    for (const [pkg, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
        const w = walk(RUN19_TREE, pkg)
        hops += w.hops.length * n
        const detail = w.hops.map(h => `-> ${h.target}`).join(' ') || '(no install hop)'
        console.log(`  x${String(n).padStart(3)}  ${pkg.padEnd(38)} ${detail}`)
    }
    console.log(`\ninstall hops over the whole replay: ${hops}`)
}

if (import.meta.main) await main()
