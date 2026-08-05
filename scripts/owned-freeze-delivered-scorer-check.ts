/**
 * Metric FP suite for A/B-2's pre-registered scorer (`scoreStaticObservation`),
 * run BEFORE any model time is spent.
 *
 * A/B-2 PASSes only if the treatment arm hits >= 14/20 on this scorer. A scorer
 * that fires on ordinary specs would manufacture that number out of nothing, and
 * one that cannot fire at all would guarantee a FAIL. Both directions are
 * checked here against ground truth that already exists on disk:
 *
 *   arm 1  every recorded composed spec in the corpus (60). Expected hits: ZERO.
 *          Not one recorded spec observes static asset serving — that is the
 *          defect run 19's final gate reported ("the rendered body is EMPTY").
 *          A hit here is a false positive and the metric is wrong.
 *   arm 2  hand-built NEGATIVES: specs that check the SPA shell, or grep
 *          `package.json` for the dev script — the exact run-18 non-resolution.
 *          Expect zero.
 *   arm 3  hand-built POSITIVES: an ACCEPTANCE line and a VERIFY command that
 *          each request a built asset and assert what came back. Expect a hit,
 *          or the metric can never reward the treatment.
 *
 * Run: bun run scripts/owned-freeze-delivered-scorer-check.ts
 *   PASS 0 · FAIL 1
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {scoreStaticObservation} from './owned-freeze-delivered-ab.js'

const HUB = path.join(os.homedir(), 'hub')
let failures = 0

function section(doc: string, name: string): string {
    const re = new RegExp(String.raw`^##\s+${name}\s*$`, 'im')
    const m = re.exec(doc)
    if (!m) return ''
    const rest = doc.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

// ── arm 1: the real corpus ──────────────────────────────────────────────────
const hits: string[] = []
let scanned = 0
for (const pool of existsSync(HUB) ? readdirSync(HUB) : []) {
    const dir = path.join(HUB, pool, '.pi-tasks')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(x => /^TASK_\d+\.md$/.test(x)).sort()) {
        const spec = section(readFileSync(path.join(dir, f), 'utf8'), 'spec')
        if (spec.length === 0) continue
        scanned++
        const r = scoreStaticObservation(spec)
        if (r.hit) hits.push(`${pool}/${f.replace(/\.md$/, '')}: ${r.line?.slice(0, 110)}`)
    }
}
console.log(`arm 1 — ${scanned} real specs: ${hits.length} hit(s) — ${hits.length === 0 ? 'OK' : 'FALSE POSITIVES'}`)
for (const h of hits) console.log(`  - ${h}`)
if (hits.length > 0) failures++

// ── arm 2: negatives ────────────────────────────────────────────────────────
const NEGATIVES: Array<{name: string; spec: string}> = [
    {
        name: 'SPA shell only — the fallback run 19 already had',
        spec: [
            'ACCEPTANCE',
            '- `src/server/index.ts` serves `dist/index.html` for all non-`/api` GET requests.',
            '',
            'VERIFY:',
            '```sh',
            'curl -s http://localhost:3000/some/route | grep -q "<div id=\\"root\\">"',
            '```'
        ].join('\n')
    },
    {
        name: 'the run-18 non-resolution — grep the dev script out of package.json',
        spec: [
            'ACCEPTANCE',
            '- The `dev` script runs `bun run --watch src/server/index.ts` alongside the Tailwind watcher.',
            '',
            'VERIFY:',
            '```sh',
            'grep -q "bun run --watch src/server/index.ts" package.json',
            'node -e "const p=require(\'./package.json\'); if(!p.scripts.dev) process.exit(1)"',
            '```'
        ].join('\n')
    },
    {
        name: 'the bundle is BUILT but never requested',
        spec: [
            'ACCEPTANCE',
            '- `bun run build` produces `dist/app.css` and the client bundle in `dist/`.',
            '',
            'VERIFY:',
            '```sh',
            'bun run build.ts && test -f dist/app.css',
            '```'
        ].join('\n')
    },
    {
        name: 'a request with no asset — the health check',
        spec: ['VERIFY:', '```sh', 'curl -sf http://localhost:3000/api/health', '```'].join('\n')
    },
    {
        name: 'the CONSTRAINTS state it but nothing observes it',
        spec: [
            'CONSTRAINTS',
            '  - "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`."'
                + ' [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)',
            '',
            'ACCEPTANCE',
            '- The server serves static assets from `dist/`.',
            '',
            'VERIFY:',
            '```sh',
            'bunx tsc --noEmit',
            '```'
        ].join('\n')
    }
]
console.log('\narm 2 — negatives, expect NO hit')
for (const n of NEGATIVES) {
    const r = scoreStaticObservation(n.spec)
    console.log(`  ${r.hit ? 'FAIL' : 'OK  '} ${n.name}${r.hit ? ` — ${r.line?.slice(0, 90)}` : ''}`)
    if (r.hit) failures++
}

// ── arm 3: positives ────────────────────────────────────────────────────────
const POSITIVES: Array<{name: string; spec: string}> = [
    {
        name: 'VERIFY curls the built stylesheet and checks the content type',
        spec: [
            'VERIFY:',
            '```sh',
            'curl -s -o /dev/null -w "%{content_type}" http://localhost:3000/app.css | grep -q text/css',
            '```'
        ].join('\n')
    },
    {
        name: 'ACCEPTANCE states the request and the non-HTML response',
        spec: [
            'ACCEPTANCE',
            '- A GET /app.css against the running server returns the built stylesheet with'
                + ' `Content-Type: text/css`, not the SPA `index.html`.'
        ].join('\n')
    },
    {
        name: 'VERIFY fetches the bundle and compares it to the built file',
        spec: [
            'VERIFY:',
            '```sh',
            'curl -sf http://localhost:3000/dist/main.js | cmp -s - dist/main.js && echo same bytes',
            '```'
        ].join('\n')
    }
]
console.log('\narm 3 — positives, expect a hit')
for (const p of POSITIVES) {
    const r = scoreStaticObservation(p.spec)
    console.log(`  ${r.hit ? 'OK  ' : 'FAIL'} ${p.name}`)
    if (!r.hit) failures++
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
