import {test, expect, describe} from 'bun:test'
import {isTypeOnlyAnswer, proseOf} from './type-only-answer.js'

// Every POSITIVE and every real NEGATIVE below is VERBATIM from mx5 run 15's
// research-cache.json (answer bodies extracted from the formatted `text`, i.e. the prose
// between the `Per <pkg>@<ver>:` header and `Source excerpt:`). The detector is judged
// against real emitted text, not text invented to make it pass. Questions are the cache
// keys (whitespace-collapsed + lowercased by normalizeQuery — same rider as the fixtures).

// ─── POSITIVES: type-only answers that must be caught ───────────────────────────────────

describe('positives — signature restatements with no behaviour', () => {
    test('the recorded hc fatal case (F-2) is type-only', () => {
        const question =
            'hc factory function signature base url parameter types exported from hono/client'
        const answer =
            'The `hc` factory function exported from `hono/client` accepts a generic type `T` '
            + 'extending `Hono`, an optional string prefix type `Prefix` (defaulting to `string`), '
            + 'and takes two parameters: `baseUrl` of type `Prefix` and an optional `options` of '
            + 'type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>`.'
        const v = isTypeOnlyAnswer(answer, question)
        expect(v.typeOnly).toBe(true)
        expect(v.reason).toContain('signature')
    })

    test('a bare interface/class declaration restatement is type-only', () => {
        // Shape of F-2's "bare declaration restatement": every clause names a member and its
        // type; nothing says what any of it DOES. Question seeks usage ("how do I use").
        const question = 'how do i use the router fixture? what methods and properties does it have'
        const answer =
            'The `Router` interface extends `BaseRouter` and declares `route` of type `RouteFn`, '
            + '`all` of type `AllFn`, and a readonly `matcher` of type `Matcher`. It returns a '
            + '`RouteHandle` from each method.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(true)
    })

    test('a signature naming a parameter only by its opaque type is type-only', () => {
        // "of type Prefix" conveys nothing about what the parameter MEANS or DEFAULTS to in
        // behaviour — the precise F-2 hole.
        const question = 'how does the base url work when creating the client'
        const answer =
            'The factory takes two parameters: `baseUrl` of type `Prefix` and an optional '
            + '`options` of type `ClientOptions`.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(true)
    })
})

// ─── NEGATIVES: real answers that must NOT be caught ────────────────────────────────────

describe('negatives — real run-15 answers that explain behaviour', () => {
    test('bun SQL tagged-template answer describes what it DOES', () => {
        const question =
            'sql tagged template literal, sql class, bun.sql import from "bun", connection to '
            + 'postgres via database_url, query method, parameterized queries with $1 $2 placeholders'
        const answer =
            'Bun provides a built-in `SQL` class and `sql` client for database access, including '
            + 'Postgres via connection strings like `postgres://...`. Queries are executed using '
            + 'tagged template literals (e.g., `sql`SELECT * FROM users WHERE id = ${1}``) which '
            + 'automatically handle parameterization. The `Bun.sql` export is the primary way to '
            + 'access this functionality, replacing the deprecated `Bun.postgres` export.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(false)
    })

    test('getCookie answer gives a usage instruction', () => {
        const question =
            'c.get cookie getcookie, c.cookie or c.req.cookie to read incoming cookies, hono cookie helpers'
        const answer =
            'In Hono, you read incoming cookies using the `getCookie` helper function imported '
            + 'from `hono/cookie`, which accepts a Context object and optionally a key name. It is '
            + 'not accessed via `c.cookie` or `c.req.cookie` properties directly.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(false)
    })

    test('Bun.password.hash answer states behaviour and a concrete example', () => {
        const question = 'bun.password.hash argon2id — api signature and usage'
        const answer =
            'The `Bun.password.hash` method accepts a password (`Bun.StringOrBuffer`) and an '
            + 'optional algorithm parameter. The default algorithm is `"argon2id"`. It returns a '
            + '`Promise<string>` containing the hashed password. For argon2id usage, you can call '
            + 'it with just the password or specify `{ algorithm: "argon2id" }` in the second argument.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(false)
    })

    test('the task illustrative negative — base URL behaviour explained', () => {
        const question = 'how should the base url be used with the client'
        const answer =
            'The base URL is prepended to every request path, so pass "" if your routes are '
            + 'already absolute.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(false)
    })

    test('a signature answer to an explicit TYPE question is not gated in', () => {
        // The question asks only for the "full signature" — a signature answer is responsive,
        // so gate 1 (usage intent) clears it. This is why the many legitimate signature
        // answers in the corpus (toBuffer, BuildOutput, …) are not flagged.
        const question =
            'tobuffer() full signature with all options - format, quality, resolvewithobject'
        const answer =
            'The overload that returns `{ data: Buffer; info: OutputInfo }` is: '
            + '`toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>`.'
        expect(isTypeOnlyAnswer(answer, question).typeOnly).toBe(false)
    })
})

// ─── REGRESSION: method names inside a signature are identifiers, not behaviour ─────────
//
// The behavioural scan once ran over the whole answer, so a method name inside a
// declaration (`use(...handlers)` matching /\buse\b/, `handler` matching /handle/) cleared
// a genuinely type-only answer. Gate 2 now scans `proseOf(answer)`. These six cases are the
// coordinator's stress set and must all hold.

describe('prose stripping — signature fragments are not prose', () => {
    test('proseOf removes call fragments so their identifiers cannot read as verbs', () => {
        const stripped = proseOf(
            'The router fixture is of type Router. It has methods route(url, handler) and use(...handlers).'
        )
        expect(stripped).not.toContain('handler')
        expect(stripped).not.toContain('use(')
        // The declarative prose that remains still carries the signature marker.
        expect(stripped).toContain('of type Router')
    })

    test('proseOf leaves real behavioural prose intact', () => {
        const stripped = proseOf(
            'The base URL passed to hc() is prepended to every request path, so if routes are '
                + 'mounted under /api pass an empty string.'
        )
        expect(stripped).toContain('is prepended to every request path')
        expect(stripped).toContain('pass an empty string')
    })
})

describe('stress set — unseen type-only shapes', () => {
    test('[true] router fixture: methods listed as declarations only', () => {
        const v = isTypeOnlyAnswer(
            'The router fixture is of type Router. It has methods route(url, handler) and use(...handlers).',
            'how does the router fixture work in playwright component tests'
        )
        expect(v.typeOnly).toBe(true)
    })

    test('[true] sharp resize: signature plus a bare return type', () => {
        // "Returns a Sharp instance" names the returned TYPE — it never says what resize DOES.
        const v = isTypeOnlyAnswer(
            'resize(width?, height?, options?): Sharp. Returns a Sharp instance.',
            'how do i use sharp resize to fit an image'
        )
        expect(v.typeOnly).toBe(true)
    })

    test('[true] the recorded hc answer under a plainly-usage question', () => {
        const v = isTypeOnlyAnswer(
            'The `hc` factory function exported from `hono/client` accepts a generic type `T` '
                + 'extending `Hono`, an optional string prefix type `Prefix` (defaulting to `string`), '
                + 'and takes two parameters: `baseUrl` of type `Prefix` and an optional `options` of '
                + 'type `ClientRequestOptions`. It returns a `UnionToIntersection<Client<T, Prefix>>`.',
            'how do i use hc base url for typed rpc client'
        )
        expect(v.typeOnly).toBe(true)
    })

    test('[false] hc base URL behaviour explained around a call fragment', () => {
        // `hc()` is stripped, but "is prepended"/"pass" survive as prose — still behavioural.
        const v = isTypeOnlyAnswer(
            'The base URL passed to hc() is prepended to every request path, so if routes are '
                + 'mounted under /api pass an empty string...',
            'how do i use hc base url'
        )
        expect(v.typeOnly).toBe(false)
    })

    test('[false] an explicit type-signature question is never gated in', () => {
        const v = isTypeOnlyAnswer(
            'Bun.password.hash(password: string, algorithm?): Promise<string>.',
            'what is the type signature of Bun.password.hash'
        )
        expect(v.typeOnly).toBe(false)
    })

    test('[false] zValidator usage instruction survives call stripping', () => {
        const v = isTypeOnlyAnswer(
            'Call zValidator(...) as middleware; inside the handler use c.req.valid(...). '
                + 'Example: app.post(...).',
            'how do i use zValidator with a zod schema'
        )
        expect(v.typeOnly).toBe(false)
    })
})

// ─── The "unclear" non-answer is a distinct channel, not type-only ──────────────────────

describe('unclear non-answers are routed separately', () => {
    test('"unclear from this package" is not type-only', () => {
        const v = isTypeOnlyAnswer(
            'unclear from this package',
            'how to use hc<apptype> from hono/client for typed rpc client'
        )
        expect(v.typeOnly).toBe(false)
        expect(v.reason).toContain('unclear')
    })

    test('an empty answer is not type-only', () => {
        expect(isTypeOnlyAnswer('', 'how do i use it').typeOnly).toBe(false)
    })
})
