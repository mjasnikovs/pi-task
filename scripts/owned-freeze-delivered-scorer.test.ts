/**
 * Metric FP suite for A/B-2's pre-registered scorer (`scoreStaticObservation`).
 *
 * A/B-2 PASSes only if the treatment arm hits >= 14/20 on this scorer. A scorer
 * that fires on ordinary specs would manufacture that number out of nothing, and
 * one that cannot fire at all would guarantee a FAIL. Both directions are checked.
 *
 * These are the two arms that need no corpus:
 *
 *   NEGATIVES  specs that check the SPA shell, or grep `package.json` for the dev
 *              script — the exact run-18 non-resolution. Expect zero hits.
 *   POSITIVES  an ACCEPTANCE line and a VERIFY command that each request a built
 *              asset and assert what came back. Expect a hit, or the metric can
 *              never reward the treatment.
 *
 * The third arm — every recorded composed spec in `~/hub` (60), expected ZERO
 * hits — stays in `scripts/owned-freeze-delivered-scorer-check.ts`, because it
 * needs an evidence tree this machine may not have. Splitting them is the point:
 * the arms that CAN run unattended now do, on every `bun test`.
 *
 * `scoreStaticObservation` is imported from the harness, which is guarded by
 * `import.meta.main` — validating the metric spends no model time.
 */
import {describe, expect, test} from 'bun:test'
import {scoreStaticObservation} from './owned-freeze-delivered-ab.js'

describe('negatives — a spec that does not OBSERVE static serving must not hit', () => {
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

    for (const n of NEGATIVES) {
        test(n.name, () => {
            const r = scoreStaticObservation(n.spec)
            expect(r.hit, `false positive on: ${r.line?.slice(0, 90)}`).toBe(false)
        })
    }
})

describe('positives — a spec that requests a built asset and asserts the response must hit', () => {
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

    for (const p of POSITIVES) {
        test(p.name, () => {
            expect(scoreStaticObservation(p.spec).hit).toBe(true)
        })
    }
})
