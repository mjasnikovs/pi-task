/**
 * Snapshot every page the run-15 design text cites, so PROMPT 4's A/B is OFFLINE and
 * DETERMINISTIC.
 *
 * WHY. The A/B's metric is WHICH URL worker:apis asked pi-worker-fetch for. Serving those
 * requests from the live web would put two uncontrolled variables inside the experiment:
 * network latency (these pages are large and the arms run back to back) and page drift —
 * hono.dev and bun.com are living documentation sites, and a page that changes between the
 * baseline arm and the treatment arm would be credited to the lever. The same reasoning
 * PROMPT 3 states for its fixture pages applies here verbatim.
 *
 * WHAT IS CAPTURED: the output of `fetchAndClean` — the cleaned markdown the child actually
 * sees — plus finalUrl and title, keyed by the URL including any #fragment.
 *
 * WHAT IS NOT STUBBED BY THIS FILE: the pi-worker-fetch child summariser still runs for
 * real against this content. Only the network hop is replaced.
 *
 * Network only; no model, no GPU. Safe to run alongside a live measurement.
 *
 * Run: bun run scripts/snapshot-spec-url-pages.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fetchAndClean} from '../src/workers/html-clean.js'
import {extractUrls} from './spec-url-reach.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const OUT = path.join(HERE, 'fixtures', 'spec-url-pages')
const DESIGN = path.join(os.homedir(), 'hub', 'mx5', 'DESIGN', 'PROJECT.md')

/** One file per distinct URL; the fragment is part of the identity, not noise. */
export function pageKey(url: string): string {
    return `${url.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120)}.json`
}

export interface SnapshotPage {
    url: string
    finalUrl: string
    title: string
    markdown: string
}

async function main(): Promise<void> {
    if (!fs.existsSync(DESIGN)) {
        console.error(`FATAL: ${DESIGN} not found — the run-15 design text is the input here.`)
        process.exit(1)
    }
    fs.mkdirSync(OUT, {recursive: true})
    const urls = extractUrls(fs.readFileSync(DESIGN, 'utf8'))
    console.log(`snapshotting ${urls.length} design-cited URLs -> ${OUT}`)

    let ok = 0
    let failed = 0
    for (const url of urls) {
        const dest = path.join(OUT, pageKey(url))
        if (fs.existsSync(dest)) {
            console.log(`  skip (already snapshotted) ${url}`)
            ok++
            continue
        }
        try {
            const cleaned = await fetchAndClean(url, {})
            const page: SnapshotPage = {
                url,
                finalUrl: cleaned.finalUrl,
                title: cleaned.title,
                markdown: cleaned.markdown
            }
            fs.writeFileSync(dest, JSON.stringify(page, null, 1), 'utf8')
            console.log(`  ok ${String(cleaned.markdown.length).padStart(7)}B  ${url}`)
            ok++
        } catch (e) {
            console.log(`  FAILED ${url} — ${String(e).slice(0, 120)}`)
            failed++
        }
    }
    console.log(`\n${ok} snapshotted, ${failed} failed`)
    // A missing page is not fatal for the A/B — the stub answers with an explicit
    // "not snapshotted" note and the harness counts it — but it IS a hole in the fixture,
    // so it must be visible in the exit code rather than buried in the log.
    if (failed > 0) process.exitCode = 1
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
