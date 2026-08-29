/**
 * F-2 / PROMPT 2 — the TARGETED REGRESSION TEST, and the reason it exists instead of an A/B.
 *
 * ── WHY THIS FILE REPLACES AN EXPERIMENT ──────────────────────────────────────────────────
 *
 * PROMPT 2's live A/B measured baseline 14/17 reps terminating without escalating (82%) vs
 * treatment 10/11 (91%), Fisher p = 0.88, and the lever was recorded as "did not move the
 * metric". That was a broken EXPERIMENT, not broken code. Stage 1 measured what the
 * experiment never did — how often the lever can fire at all:
 *
 *   MEASURED 2026-07-22, live, Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, 8 reps x the
 *   210 run-15 package questions = 1680 lookups, research cache off, 0 errors
 *   (scripts/live-typeonly-baserate.ts):
 *
 *     BASE RATE   9/1680 = 0.54%   Wilson 95% [0.28%, 1.02%]
 *                 The static record (1/150 = 0.7%) is CONFIRMED, not refuted.
 *     PER REP     1 1 1 1 1 1 1 2  — the whole population is one or two answers per rep.
 *     POPULATION  2 of 210 questions EVER flag:
 *                   8/8  hono/client  "hc factory function signature base url parameter…"
 *                   1/8  bun          "sql.query type definition, sql.helper type…"
 *
 * A lever reaching 0.54% of answers cannot move an 82% aggregate, and no arm size fixes
 * that: the population is ONE deterministic question plus one intermittent one. Running
 * another A/B would spend hours to produce another p ≈ 0.9. So the lever is not claimed as a
 * population fix. It is a TARGETED GUARD, and this file is its proof — the honest claim
 * being blast radius N = 1 deterministic case (hc, 8/8 reps) + 1 intermittent (bun SQL
 * types, 1/8 reps), which is exactly what stage 1 exit (ii) prescribes.
 *
 * ── WHAT IS AND IS NOT PROVEN HERE ────────────────────────────────────────────────────────
 *
 * PROVEN: for the recorded case the tool marks the answer UNANSWERED, refuses to present the
 * type as the answer, and hands back the `@see` URL to fetch. Also proven: the guard does not
 * fire on the neighbouring shapes (a behavioural answer, an explicit "unclear", a
 * signature question that a signature legitimately answers).
 *
 * NOT PROVEN, and deliberately not claimed anywhere: that the worker then ACTUALLY escalates.
 * That is a model behaviour, it was measured at ~18% spontaneous in the pre-change flow, and
 * the 0.54% base rate means no affordable experiment can attribute a change in it to this
 * lever. The banner is an instruction; whether the model obeys is unmeasured.
 *
 * ── WHY THE POSITIVES ARE EIGHT LIVE VARIANTS, NOT ONE FROZEN STRING ──────────────────────
 *
 * The corpus lowercases and whitespace-collapses its cache keys, and the model re-words its
 * answer every rep. Pinning one recorded string would prove only that a regex matches a
 * string. The eight answers below are the eight DISTINCT phrasings the live model actually
 * produced for the same question across the eight reps — every one caught. That is the
 * property worth defending: robustness to the model re-wording the same type-only answer.
 * Verbatim from ~/tmp/typeonly-baserate/answers.jsonl.
 */
import {test, expect, describe} from 'bun:test'
import * as path from 'node:path'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import {
    docsCacheable,
    registerPiWorkerDocs,
    type PiWorkerDocsInternals
} from '../../src/workers/pi-worker-docs.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {fakeSpawnSimple} from '../test-utils/fake-spawn.js'
import {isTypeOnlyAnswer} from '../../src/task/type-only-answer.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

/** The query verbatim, as run 15 asked it and as all 8 live reps re-asked it. */
const HC_QUERY = 'hc factory function signature base url parameter types exported from hono/client'

/**
 * The eight answers the live model produced for HC_QUERY, one per rep, 2026-07-22. Every
 * clause in every one is type-level: they name `baseUrl`'s TYPE (`Prefix`, itself an opaque
 * type variable) and never say what `baseUrl` MEANS. That is precisely why the worker
 * accepted them as complete and stopped.
 */
const HC_LIVE_ANSWERS: string[] = [
    'The `hc` factory function is exported from `hono/client` and takes two parameters: `baseUrl` of generic type `Prefix extends string = string`, and an optional `options` of type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>` where `T` extends `Hono`.',
    'The `hc` factory function exported from `hono/client` takes a generic `Hono` instance type `T`, an optional string prefix `Prefix` (defaulting to `string`), and accepts two parameters: `baseUrl` of type `Prefix` and an optional `options` object of type `ClientRequestOptions`. It returns a union-to-intersection transformed `Client` typed with `T` and `Prefix`.',
    'The `hc` factory function exported from `hono/client` takes a generic type `T` extending `Hono`, an optional string literal `Prefix` (defaulting to `string`), and accepts two parameters: `baseUrl` of type `Prefix` and an optional `options` of type `ClientRequestOptions`. It returns the intersection of the `Client` type constructed with `T` and `Prefix`.',
    'The `hc` factory function exported from `hono/client` takes two parameters: `baseUrl` of type `Prefix` (defaulting to `string`) and an optional `options` parameter of type `ClientRequestOptions`. It is generic over `T` (extending `Hono`) and `Prefix`.',
    'The `hc` factory function exported from `hono/client` is generic over a Hono app type `T` and an optional prefix string `Prefix`. It takes two parameters: `baseUrl` of type `Prefix` (defaulting to `string`) and an optional `options` object of type `ClientRequestOptions`. It returns a union-to-intersection client instance.',
    'The `hc` factory function exported from `hono/client` is a generic function that takes two parameters: `baseUrl` of type `Prefix` (defaulting to `string`) and an optional `options` parameter of type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>`, where `T` is constrained to extend `Hono<any, any, any>`.',
    'The `hc` factory function is exported from `hono/client` and takes two parameters: `baseUrl` of type `Prefix` (defaulting to `string`) and an optional `options` of type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>` where `T` extends `Hono`.',
    'The `hc` factory function exported from `hono/client` takes a generic `Hono` instance type `T`, an optional `Prefix` string (defaulting to `string`), and accepts two parameters: `baseUrl` of type `Prefix` and an optional `options` of type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>`.'
]

/**
 * The ORIGINAL run-15 cache entry, kept alongside the live variants. It is the answer that
 * actually shipped the bug, so it must never stop being caught, whatever later reps say.
 */
const HC_RECORDED_ANSWER =
    'The `hc` factory function exported from `hono/client` accepts a generic type `T` '
    + 'extending `Hono`, an optional string prefix type `Prefix` (defaulting to `string`), '
    + 'and takes two parameters: `baseUrl` of type `Prefix` and an optional `options` of '
    + 'type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>`.'

describe('F-2 blast radius, case 1 of 2 — the hc answer (8/8 reps live)', () => {
    test.each(HC_LIVE_ANSWERS.map((a, i) => [i + 1, a] as const))(
        'live rep %i phrasing is caught',
        (_rep, answer) => {
            expect(isTypeOnlyAnswer(answer, HC_QUERY).typeOnly).toBe(true)
        }
    )

    test('the original run-15 cache entry — the answer that shipped the bug — is caught', () => {
        expect(isTypeOnlyAnswer(HC_RECORDED_ANSWER, HC_QUERY).typeOnly).toBe(true)
    })

    test('all eight live phrasings are genuinely distinct strings, not one answer repeated', () => {
        // Otherwise "8/8 reps" would be a single observation wearing eight hats, and the
        // robustness claim above would be unearned.
        expect(new Set(HC_LIVE_ANSWERS).size).toBe(8)
    })

    test('the ANSWER that would have prevented the bug is NOT flagged', () => {
        // The negative control that matters most: had docs said what `baseUrl` MEANS, the
        // guard must stand down. A detector that flags the good answer too would simply be
        // forcing an escalation on every hono/client lookup.
        const good =
            'The `hc` factory takes a base URL which is PREPENDED to every request path. '
            + 'Pass the origin (e.g. `http://localhost:3000`), not a mount prefix — routes '
            + 'already carry their own paths, so passing `/api` yields `/api/api/...`.'
        expect(isTypeOnlyAnswer(good, HC_QUERY).typeOnly).toBe(false)
    })
})

/**
 * F-2(c), the second fatal defect of run 15. Note carefully which channel it belongs to: the
 * docs worker answered the bun-SQL USAGE question with an explicit "unclear from this
 * package", which is the HONEST non-answer and is NOT type-only. The type-only shape appears
 * on the neighbouring TYPE question — measured live at 1/8 reps, i.e. intermittent. Both are
 * pinned, and the boundary between them is pinned, because conflating the two channels is
 * what would make the guard fire on honest abstentions.
 */
describe('F-2 blast radius, case 2 of 2 — the bun-SQL shape', () => {
    const TYPE_QUERY =
        'sql.query type definition, sql.helper type, sql.options interface, transactionsql '
        + 'type, connect method how to use'

    test('the live type-listing answer (1/8 reps) is caught', () => {
        // Verbatim from the live run. Every clause is an interface/type restatement, and the
        // method names are identifiers inside declarations — not statements of behaviour.
        const answer =
            'The `sql.query` type is defined as the `SQL.Query<T>` interface, which extends '
            + '`Promise<T>` and includes methods like `cancel()`, `simple()`, `execute()`, '
            + '`raw()`, and `values()`. The `sql.helper` type is the `SQL.Helper<T>` '
            + 'interface with readonly `value` and `columns` properties. The `sql.options` '
            + 'interface is `SQL.Options`, a union of `SQLiteOptions` and '
            + '`PostgresOrMySQLOptions`. The `transactionsql` type corresponds to '
            + '`TransactionSQL`, used in the `TransactionContextCallback<T>` type alias.'
        expect(isTypeOnlyAnswer(answer, TYPE_QUERY).typeOnly).toBe(true)
    })

    test('the recorded "unclear" non-answer is NOT type-only — it is a different channel', () => {
        // Routing an honest abstention through the type-only banner would double-report it
        // and, worse, would let the type-only counter absorb the unclear population and
        // fake a base rate far above the measured 0.54%.
        const v = isTypeOnlyAnswer(
            'unclear from this package',
            'what is the bun sql api? how does `import { sql } from "bun"` work?'
        )
        expect(v.typeOnly).toBe(false)
        expect(v.reason).toContain('unclear')
    })
})

// ─── the tool seam: UNANSWERED banner + the pointer to follow ────────────────────────────

interface RegisteredTool {
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
    ) => Promise<AgentToolResult<unknown>>
}

async function runTool(
    internals: PiWorkerDocsInternals,
    params: {module: string; query: string}
): Promise<AgentToolResult<unknown>> {
    const registered: RegisteredTool[] = []
    registerPiWorkerDocs(
        {registerTool: (t: RegisteredTool) => registered.push(t)} as unknown as Parameters<
            typeof registerPiWorkerDocs
        >[0],
        internals
    )
    return registered[0].execute('id', params, undefined, undefined, {cwd: FIXTURES})
}

const textOf = (r: AgentToolResult<unknown>): string =>
    (r.content[0] as {type: 'text'; text: string}).text

/**
 * End-to-end at the seam that matters: the real tool, real resolve/index/retrieve against a
 * fixture package shaped like hono/client, with only the child summariser and the npm
 * registry call stubbed. The `@see` pointer is NOT injected — it is pulled out of the
 * declarations the retriever actually returned, which is the whole point of F-2(d): the URL
 * was already in hand and was never used.
 */
describe('the docs tool marks the recorded case UNANSWERED and names what to fetch', () => {
    test('type-only answer ⇒ UNANSWERED banner, retained type, and the @see URL to fetch', async () => {
        const cache = openCache(':memory:')
        const result = await runTool(
            {
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnSimple(`<answer>${HC_RECORDED_ANSWER}</answer>`)
            },
            {module: 'rpc-client-pkg', query: HC_QUERY}
        )
        const text = textOf(result)

        // 1. The answer is not presented as an answer.
        expect(text).toContain('UNANSWERED — TYPE-ONLY')
        // 2. The worker is told, in terms, not to close the gap from memory — which is
        //    exactly what worker:context did in run 15 (F-1).
        expect(text).toMatch(/Do NOT answer from memory/i)
        // 3. It is handed the pointer that was sitting in the retrieved text all along.
        expect(text).toContain('https://hono.dev/docs/guides/rpc')
        expect(text).toMatch(/NEXT STEP/)
        // 4. The retrieved declaration is KEPT — it is real and useful, just demoted from
        //    "the answer" to "context". Deleting it would lose true information.
        expect(text).toContain('baseUrl')
        expect((result.details as {typeOnly?: boolean}).typeOnly).toBe(true)
        cache.close()
    })

    test('a behavioural answer to the same query gets NO banner — the guard is conditional', async () => {
        // Without this control the suite would pass just as well if the banner were
        // unconditional, which would make every docs lookup an escalation.
        const cache = openCache(':memory:')
        const result = await runTool(
            {
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnSimple(
                    '<answer>Pass the server origin as baseUrl; it is prepended to every '
                        + 'request path, so use `http://localhost:3000`, not `/api`.</answer>'
                )
            },
            {module: 'rpc-client-pkg', query: HC_QUERY}
        )
        expect(textOf(result)).not.toContain('UNANSWERED')
        expect((result.details as {typeOnly?: boolean}).typeOnly).toBeUndefined()
        cache.close()
    })

    test('a type-only answer is never memoised, so the next asker can still escalate', async () => {
        // F-2(e): run 15 cached its non-answers, so one dead end was re-served to every
        // later sibling task and the miss never recurred to trigger an escalation.
        const cache = openCache(':memory:')
        const result = await runTool(
            {
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnSimple(`<answer>${HC_RECORDED_ANSWER}</answer>`)
            },
            {module: 'rpc-client-pkg', query: HC_QUERY}
        )
        const d = result.details as {typeOnly?: boolean; childExitCode?: number}
        // The child ran clean, so this IS an answer — and an answer carries no exit
        // code at all now. Cacheability keys on the ANSWER, and nothing else can.
        expect(d.childExitCode).toBeUndefined()
        expect(d.typeOnly).toBe(true)
        const body = result.content[0]
        expect(docsCacheable(d, body?.type === 'text' ? body.text : '')).toBe(false)
        cache.close()
    })
})
