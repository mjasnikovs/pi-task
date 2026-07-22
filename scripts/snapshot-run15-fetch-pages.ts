/**
 * Snapshot the run-15 fetch fixture pages to disk, so PROMPT 3's A/B is DETERMINISTIC.
 *
 * WHY. nexxtasks PROMPT 3 requires it explicitly: "Page content must be SNAPSHOTTED to disk
 * so the A/B is deterministic and offline — a live re-fetch would let page drift masquerade
 * as a lever effect." These are living documentation sites (playwright.dev, tailwindcss.com,
 * bun.com); between the baseline arm and the treatment arm a page can simply change, and the
 * harness would credit the lever for it.
 *
 * WHAT IS CAPTURED. The output of `fetchAndClean` — i.e. the cleaned markdown the child
 * actually sees, not raw HTML — plus finalUrl and title, keyed by the fixture URL INCLUDING
 * its #fragment (the fragment is the point of one of the ten failures, so it must not be
 * normalised away).
 *
 * Network only; no model, no GPU. Safe to run alongside a live A/B.
 *
 * Run: bun run scripts/snapshot-run15-fetch-pages.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fetchAndClean} from '../src/workers/html-clean.js'

interface Pair {
    url: string
    query: string
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const OUT = path.join(HERE, 'fixtures', 'run15-fetch-pages')

const failing = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'run15-fetch-failures.json'), 'utf8')
) as Pair[]
const regression = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'run15-fetch-regression.json'), 'utf8')
) as Pair[]

/** One file per distinct URL; the fragment is part of the identity, not noise. */
function keyOf(url: string): string {
    return url.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120) + '.json'
}

async function main(): Promise<void> {
    fs.mkdirSync(OUT, {recursive: true})
    const urls = [...new Set([...failing, ...regression].map(p => p.url))]
    console.log(`snapshotting ${urls.length} distinct URLs -> ${OUT}`)

    let ok = 0
    let failed = 0
    for (const url of urls) {
        const dest = path.join(OUT, keyOf(url))
        if (fs.existsSync(dest)) {
            console.log(`  skip (already snapshotted) ${url.slice(0, 78)}`)
            ok++
            continue
        }
        try {
            const cleaned = await fetchAndClean(url, {})
            fs.writeFileSync(
                dest,
                JSON.stringify(
                    {
                        url,
                        finalUrl: cleaned.finalUrl,
                        title: cleaned.title,
                        markdown: cleaned.markdown,
                        capturedAt: new Date().toISOString(),
                        chars: cleaned.markdown.length
                    },
                    null,
                    2
                ),
                'utf8'
            )
            ok++
            console.log(`  ok ${String(cleaned.markdown.length).padStart(7)} chars  ${url.slice(0, 70)}`)
        } catch (e) {
            failed++
            console.log(`  FAIL ${url.slice(0, 70)} — ${String(e).slice(0, 110)}`)
        }
    }
    console.log(`\nsnapshotted ${ok}, failed ${failed}`)
    if (failed > 0) {
        console.log(
            'A failed snapshot means that fixture cannot be replayed offline. Re-run to retry;\n'
                + 'do NOT silently drop it from the A/B — a shrunken fixture set changes the result.'
        )
    }
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
