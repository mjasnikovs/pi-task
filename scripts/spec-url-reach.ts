/**
 * PROMPT 4 STEP 1 — MEASURE THE LEVER'S REACH, before anything is implemented.
 *
 * WHY THIS RUNS FIRST, and why it can veto the rest. PROMPT 2's type-only lever was built,
 * A/B'd and written off before anyone measured how often it could fire; the answer turned out
 * to be 0.54% of answers over a population of ONE deterministic question, which made every
 * aggregate experiment against it unreadable and cost hours. The rule that came out of that:
 * measure the population BEFORE choosing the instrument. If this harness reports ~1 reachable
 * case, PROMPT 4 is another targeted guard, an A/B is again the wrong instrument, and the
 * correct action is to say so and stop.
 *
 * THE QUESTION, verbatim from PROMPT 4 STEP 1: over the run-15 design text, how many distinct
 * http(s) URLs does the spec cite, and for how many of them does worker:apis ask
 * pi-worker-docs about the same package in the same task? That count is the lever's reach.
 *
 * WHOLLY MECHANICAL, ZERO MODEL TIME. Both inputs are recorded artifacts of run 15:
 *   design  ~/hub/mx5/DESIGN/PROJECT.md      — §5 and §13 are literal reference lists
 *   asks    ~/hub/mx5/.pi-tasks/TASK_*-debug.log — `worker:apis: pi-worker-docs: <module> …`
 *   fetches the same logs' `worker:apis: pi-worker-fetch: <url>` lines
 * Nothing here is inferred about why the model behaves as it does.
 *
 * THE ASSOCIATION RULE IS THE LOAD-BEARING CHOICE, so it is measured TWICE at different
 * strictness and both numbers are printed. A reach figure that only survives a generous rule
 * is not a reach figure.
 *   LOOSE   the package's root name occurs as a token anywhere in the URL (host or path).
 *           Admits github.com/molefrog/wouter for `wouter` and .../zod-validator for
 *           `@hono/zod-validator` — real associations that live in the path, not the host.
 *   STRICT  the package's root name occurs as a token in the URL's HOST only. Drops both
 *           github.com cases; keeps hono.dev/hono, bun.com/bun, zod.dev/zod, react.dev/react,
 *           tailwindcss.com/tailwindcss, playwright.dev/playwright,
 *           sharp.pixelplumbing.com/sharp.
 * `module: "."` (project source) is never associated with any URL — it names no package.
 *
 * Run (no model, no PI_BIN, no network):
 *   bun run scripts/spec-url-reach.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {reportArm, type Invariant} from './ab-verdict.js'

const MX5 = path.join(os.homedir(), 'hub', 'mx5')
const DESIGN = path.join(MX5, 'DESIGN', 'PROJECT.md')
const TASKS = path.join(MX5, '.pi-tasks')

/** Trailing sentence punctuation is not part of a URL; `#fragment` and query ARE kept. */
export function extractUrls(text: string): string[] {
    const raw = text.match(/https?:\/\/[^\s)>`"']+/g) ?? []
    return [...new Set(raw.map(u => u.replace(/[.,;:]+$/, '')))].sort()
}

/**
 * Tokens of a package specifier that could plausibly appear in its documentation URL:
 * the root name plus every path/scope segment. `hono/client` ⇒ {hono, client};
 * `@hono/zod-validator` ⇒ {hono, zod, validator, zod-validator}.
 */
export function packageTokens(module: string): string[] {
    const m = module.toLowerCase().trim()
    if (m === '.' || m.length === 0) return []
    const segs = m.split('/').filter(Boolean)
    const out = new Set<string>()
    for (const s of segs) {
        const bare = s.replace(/^@/, '')
        if (bare.length > 2) out.add(bare)
        for (const part of bare.split('-')) if (part.length > 2) out.add(part)
    }
    return [...out]
}

const tokenize = (s: string): Set<string> =>
    new Set(
        s
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
    )

export type Strictness = 'loose' | 'strict'

/** Does this spec-cited URL document the package this docs query names? */
export function associated(url: string, module: string, how: Strictness): boolean {
    const toks = packageTokens(module)
    if (toks.length === 0) return false
    let scope: string
    try {
        const u = new URL(url)
        scope = how === 'strict' ? u.hostname : `${u.hostname} ${u.pathname}`
    } catch {
        return false
    }
    const inUrl = tokenize(scope)
    return toks.some(t => inUrl.has(t))
}

interface TaskRecord {
    id: string
    /** Distinct package modules worker:apis asked pi-worker-docs about ("." excluded). */
    modules: string[]
    /** URLs worker:apis actually handed to pi-worker-fetch. */
    fetched: string[]
}

function readTasks(): TaskRecord[] {
    const out: TaskRecord[] = []
    for (const f of fs.readdirSync(TASKS).sort()) {
        const m = /^(TASK_\d+)-debug\.log$/.exec(f)
        if (!m) continue
        const txt = fs.readFileSync(path.join(TASKS, f), 'utf8')
        const modules = new Set<string>()
        const fetched = new Set<string>()
        // The log lines are ISO-timestamp-prefixed, so these must NOT be anchored at ^.
        // An anchored version silently matched nothing and reported reach 0/44 — a zero that
        // reads exactly like "the lever has no population".
        for (const line of txt.split('\n')) {
            const d = /worker:apis: pi-worker-docs: (\S+)/.exec(line)
            if (d && d[1] !== '.') modules.add(d[1])
            const u = /worker:apis: pi-worker-fetch: (\S+)/.exec(line)
            if (u) fetched.add(u[1])
        }
        out.push({id: m[1], modules: [...modules].sort(), fetched: [...fetched].sort()})
    }
    return out
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)

/**
 * The two pages PROMPT 4 fact (c) names: each documents the semantics behind one of run 15's
 * two fatal defects — hc's base-URL meaning (F-1/F-2) and bun's SQL tagged-template
 * behaviour (F-2c). Fact (b) is that neither was ever fetched.
 */
const FATAL_PAGES = ['https://hono.dev/docs/guides/rpc', 'https://bun.com/docs/runtime/sql']

interface Reach {
    /** (task, URL) pairs where that task's worker:apis asked docs about the URL's package. */
    pairs: Array<{task: string; url: string; via: string[]}>
    urls: Set<string>
    tasks: Set<string>
}

function measure(urls: string[], tasks: TaskRecord[], how: Strictness): Reach {
    const pairs: Reach['pairs'] = []
    for (const t of tasks) {
        for (const url of urls) {
            const via = t.modules.filter(m => associated(url, m, how))
            if (via.length > 0) pairs.push({task: t.id, url, via})
        }
    }
    return {
        pairs,
        urls: new Set(pairs.map(p => p.url)),
        tasks: new Set(pairs.map(p => p.task))
    }
}

function main(): void {
    for (const p of [DESIGN, TASKS]) {
        if (!fs.existsSync(p)) {
            console.error(`FATAL: run-15 artifact missing: ${p}`)
            process.exit(1)
        }
    }
    const design = fs.readFileSync(DESIGN, 'utf8')
    const urls = extractUrls(design)
    const tasks = readTasks()
    const asking = tasks.filter(t => t.modules.length > 0)

    console.log(
        `spec-url-reach — PROMPT 4 STEP 1, mechanical, no model\n`
            + `  design ${DESIGN}\n`
            + `  tasks  ${tasks.length} debug logs, ${asking.length} with worker:apis package docs calls`
    )
    console.log(`\n=== URLS THE DESIGN CITES: ${urls.length} distinct ===`)
    for (const u of urls) console.log(`  ${u}`)

    const loose = measure(urls, tasks, 'loose')
    const strict = measure(urls, tasks, 'strict')

    console.log(
        `\n=== REACH — (task, cited-URL) pairs where the task asked docs about that package ===`
    )
    for (const [how, r] of [
        ['LOOSE (host+path)', loose],
        ['STRICT (host only)', strict]
    ] as const) {
        console.log(
            `  ${how.padEnd(20)} pairs ${String(r.pairs.length).padStart(4)}   `
                + `URLs reached ${r.urls.size}/${urls.length}   `
                + `tasks reached ${r.tasks.size}/${tasks.length} (${pct(r.tasks.size, tasks.length)})`
        )
    }

    console.log(`\n=== PER URL (strict rule) — how many tasks asked docs about its package ===`)
    const byUrl = new Map<string, number>()
    for (const p of strict.pairs) byUrl.set(p.url, (byUrl.get(p.url) ?? 0) + 1)
    for (const u of urls) {
        console.log(`  ${String(byUrl.get(u) ?? 0).padStart(3)} tasks  ${u}`)
    }

    // ── PROMPT 4 fact (b): none of the two fatal-defect pages was ever fetched ───────────
    // Recomputed here rather than quoted, so the reach number and the never-fetched number
    // come off the same pass over the same logs.
    const allFetched = new Set(tasks.flatMap(t => t.fetched))
    const citedFetched = [...allFetched].filter(f =>
        urls.some(u => f.replace(/\/+$/, '') === u.replace(/\/+$/, ''))
    )
    console.log(`\n=== WHAT WAS ACTUALLY FETCHED IN RUN 15 ===`)
    console.log(
        `  SCOPE: worker:apis only, from the task debug logs — the same channel the A/B will\n`
            + `  score. It is NOT the 30 cached fetch RESULTS quoted elsewhere; those also\n`
            + `  include the enrichment pass and the unlogged implementation turn.`
    )
    console.log(
        `  distinct URLs handed to pi-worker-fetch: ${allFetched.size}\n`
            + `  of those, SPEC-CITED: ${citedFetched.length} `
            + `(${pct(citedFetched.length, allFetched.size)})`
    )
    for (const f of [...allFetched].sort()) {
        console.log(`    ${citedFetched.includes(f) ? 'CITED    ' : 'not cited'}  ${f}`)
    }
    const unfetchedReached = [...strict.urls].filter(u => !citedFetched.includes(u))
    console.log(
        `\n  cited URLs whose package WAS asked about but which were NEVER fetched: `
            + `${unfetchedReached.length}/${strict.urls.size}`
    )
    for (const u of unfetchedReached.sort()) console.log(`    ${u}`)

    // ── the STEP 1 decision ─────────────────────────────────────────────────────────────
    // PROMPT 4: "If it is ~1 case, this is another targeted guard and an A/B is again the
    // wrong instrument — say so and stop, exactly as PROMPT 2 did." The threshold is stated
    // as a number here so the decision is not made by eye afterwards.
    const TARGETED_GUARD_CEILING = 3
    console.log(`\n=== STEP 1 DECISION ===`)
    if (strict.tasks.size <= TARGETED_GUARD_CEILING) {
        console.log(
            `  ${strict.tasks.size} reachable task(s) <= ${TARGETED_GUARD_CEILING} — TARGETED GUARD. `
                + `Do NOT size an A/B against this; PROMPT 2's lesson applies unchanged.`
        )
    } else {
        console.log(
            `  ${strict.tasks.size} reachable tasks and ${strict.urls.size} reachable URLs `
                + `(${strict.pairs.length} pairs) — this is a POPULATION, not a single case. `
                + `An A/B is a valid instrument; proceed to STEP 2 and size the arms from the `
                + `MEASURED baseline rate, never from ">= 8 reps".`
        )
    }

    const invariants: Invariant[] = [
        {
            label: 'the design text was found and cites URLs at all',
            ok: urls.length > 0,
            detail: `${urls.length} distinct URLs`
        },
        {
            label: 'the run-15 task logs were found and record worker:apis docs calls',
            ok: asking.length > 0,
            detail: `${asking.length}/${tasks.length} tasks`
        },
        {
            // If the strict rule collapses the reach to nothing, the loose number was an
            // artifact of matching on path substrings and must not be quoted as reach.
            label: 'reach survives the STRICT association rule (not an artifact of generosity)',
            ok: strict.tasks.size > 0 && strict.pairs.length >= loose.pairs.length * 0.5,
            detail: `strict ${strict.pairs.length} vs loose ${loose.pairs.length} pairs`
        },
        {
            // PROMPT 4 fact (b), stated as PROMPT 4 states it: the two pages that would have
            // PREVENTED the two fatal defects were never fetched. An earlier version of this
            // invariant claimed the broader "cited pages were essentially never fetched" and
            // broke — 2 of the 6 URLs worker:apis fetched (bun.com/docs/bundler,
            // tailwindcss.com/docs/installation/tailwind-cli) ARE cited. That is a real and
            // useful correction to the record, not a reason to weaken fact (b): the baseline
            // rate of spec-URL fetching is NOT zero, which STEP 2 must measure rather than
            // assume.
            label: 'PROMPT 4 fact (b): neither fatal-defect page was ever fetched',
            ok: FATAL_PAGES.every(p => ![...allFetched].some(f => f.startsWith(p))),
            detail: FATAL_PAGES.map(
                p => `${p} ${[...allFetched].some(f => f.startsWith(p)) ? 'FETCHED' : 'never'}`
            ).join('; ')
        },
        {
            // The reach only matters if it is UNSPENT. If the worker already fetched most
            // cited pages for the packages it asked about, the lever has nothing to add.
            label: 'the reachable cited URLs are mostly still UNFETCHED (the lever has headroom)',
            ok: unfetchedReached.length >= strict.urls.size * 0.5,
            detail: `${unfetchedReached.length}/${strict.urls.size} reachable cited URLs unfetched`
        }
    ]

    reportArm({
        name: 'spec-url-reach',
        arm: 'run-15 artifacts (STEP 1 population census, no lever)',
        reps: tasks.length,
        targetShape:
            'a run-15 task whose worker:apis asked pi-worker-docs about a package for which '
            + 'the design text cites a documentation URL — i.e. a task the spec-cited-URL '
            + 'lever could act on. An ABSTAIN means the design cites nothing the worker ever '
            + 'asked about and PROMPT 4 has no population at all.',
        hits: strict.tasks.size,
        witnessed: asking.length,
        expect: 'some',
        invariants
    })
}

// Only when run directly — `extractUrls` is imported by snapshot-spec-url-pages.ts and by
// the A/B harness, and a top-level main() would fire a full census as an import side effect.
if (import.meta.main) {
    main()
}
