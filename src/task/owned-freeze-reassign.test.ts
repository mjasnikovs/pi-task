import {describe, expect, test} from 'bun:test'
import {
    detachUnsatisfiableRequirements,
    claimPendingRequirements,
    unclaimedPendingRequirements,
    writeIntent
} from './owned-freeze-reassign.js'
import {
    appendOwnedConstraints,
    ownedForTitle,
    parseOwnedRequirements,
    type OwnedRequirement
} from './requirements.js'
import {findOwnedFreezeConflicts} from './owned-freeze-conflict.js'

const QUOTE = '**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.'
const P = 'src/server/index.ts'
const CATEGORY_FREEZE =
    '  - Do not touch `tsconfig.json`, `eslint.config.js`, or any configuration file outside of `package.json` — those are handled in other steps.'

const BUILD_TOOLING = 'Build tooling — build.ts, dev/build scripts in package.json'
const CLIENT_API = 'Client API layer — typed hono/client, SPA fallback route on server'

/** mx5 run 19's refined prompts, reduced to the sentence that names the file. */
const REFINED = {
    /** TASK_0017 — the pending writer. */
    claimant:
        'Create `src/client/api.ts` with a typed Hono RPC client, and add an SPA fallback route to'
        + ' the existing server `src/server/index.ts` so that non-`/api` GET requests serve the built'
        + ' `dist/index.html`.',
    /** TASK_0008 — a sibling that fences itself off the same file. */
    fenced:
        'File layout: routes go in `src/server/routes/listings.ts`, tests in `test/listings.test.ts`.'
        + ' Do not create or modify any other files outside this slice (e.g., no changes to'
        + ' `src/server/index.ts`, `src/shared/schema.ts`).',
    /** TASK_0016 — imports from it, writes nothing there. */
    importer: 'Create `src/client/main.tsx`. It imports `AppType` from `src/server/index.ts`.'
}

const ledger = (): OwnedRequirement[] => [
    {quote: QUOTE, anchor: '9. Build & run', title: BUILD_TOOLING},
    {quote: 'Use `Bun.password` (argon2id) for password hashing', anchor: '2. Tech stack', title: CLIENT_API}
]

const specWith = (bullets: string[]): string =>
    [
        'GOAL',
        '  Build tooling.',
        'CONSTRAINTS',
        ...bullets,
        'ACCEPTANCE',
        '  - `package.json` gains a `dev` script.'
    ].join('\n')

/** The composed spec run 19 shipped: the stamped owned bullet plus the freeze. */
const conflictSpec = (): string => appendOwnedConstraints(specWith([CATEGORY_FREEZE]), [ledger()[0]])

/**
 * Stands in for the git oracle: a repo-relative source file, i.e. something with
 * a directory and not under the build output. Modelling it as "any token that
 * looks path-shaped" would count API names like `Bun.password` as frozen files —
 * production never does, because the oracle is `git ls-files`.
 */
const anySource = (p: string): boolean => p.includes('/') && !p.startsWith('dist')

const detach = (spec = conflictSpec(), l = ledger()) =>
    detachUnsatisfiableRequirements({spec, title: BUILD_TOOLING, ledger: l, isSource: anySource})

describe('writeIntent', () => {
    test('a create/modify verb reaching the path counts', () => {
        expect(writeIntent(REFINED.claimant, P)).toBe(true)
        expect(writeIntent('Create `src/server/index.ts` that mounts the routes', P)).toBe(true)
    })

    test('a fenced mention does not — the negation may sit before the verb', () => {
        expect(writeIntent(REFINED.fenced, P)).toBe(false)
        expect(writeIntent('Do not modify `src/server/index.ts`.', P)).toBe(false)
        expect(writeIntent('All engine modules must remain untouched, including `src/server/index.ts`', P)).toBe(
            false
        )
    })

    test('a bare import is not a write', () => {
        expect(writeIntent(REFINED.importer, P)).toBe(false)
        expect(writeIntent("import type {AppType} from './server/index.ts'", P)).toBe(false)
    })

    test('the verb may not reach across a sentence boundary', () => {
        expect(writeIntent('Create the client shell. It reads `src/server/index.ts`.', P)).toBe(false)
    })
})

describe('detachUnsatisfiableRequirements', () => {
    test('detaches the run-19 clause and unstamps it, keeping the quote verbatim', () => {
        const r = detach()
        expect(r.actions).toHaveLength(1)
        expect(r.actions[0]).toMatchObject({kind: 'detach', paths: [P]})
        const entry = r.ledger.find(o => o.quote === QUOTE)!
        expect(entry.pending).toEqual([P])
        expect(entry.quote).toBe(QUOTE)
        expect(r.spec).not.toContain('serves `/api` + static `dist/`')
    })

    test('inv-no-requirement-loss — the quote multiset is identical, text for text', () => {
        const r = detach()
        expect(r.ledger.map(o => o.quote).sort()).toEqual(ledger().map(o => o.quote).sort())
    })

    test('a detached entry is owned by nobody until it is claimed', () => {
        const r = detach()
        expect(ownedForTitle(r.ledger, BUILD_TOOLING)).toEqual([])
    })

    test('inv-idempotent — a second pass over the result does nothing', () => {
        const first = detach()
        const second = detachUnsatisfiableRequirements({
            spec: first.spec,
            title: BUILD_TOOLING,
            ledger: first.ledger,
            isSource: anySource
        })
        expect(second.actions).toEqual([])
        expect(second.spec).toBe(first.spec)
        expect(second.ledger).toEqual(first.ledger)
    })

    test('inv-noop-when-clean — a spec with no conflict is byte-identical', () => {
        const clean = appendOwnedConstraints(
            specWith(['  - Preserve every existing entry in `package.json`.']),
            [ledger()[0]]
        )
        const r = detach(clean)
        expect(r.spec).toBe(clean)
        expect(r.actions).toEqual([])
        expect(r.ledger).toEqual(ledger())
    })

    test('a quote compose folded in as prose is not edited — only stamped bullets move', () => {
        const prose = specWith([
            CATEGORY_FREEZE,
            `  - The server watch command must match the contract: "${QUOTE}"`
        ])
        const r = detach(prose, [{quote: QUOTE, anchor: '', title: BUILD_TOOLING}])
        expect(r.spec).toBe(prose)
        expect(r.actions.every(a => a.kind === 'unresolved')).toBe(true)
        expect(r.ledger[0].pending).toBeUndefined()
    })
})

describe('claimPendingRequirements', () => {
    const detached = (): OwnedRequirement[] => detach().ledger

    test('the task whose refined prompt writes the path takes it', () => {
        const r = claimPendingRequirements({
            intent: REFINED.claimant,
            title: CLIENT_API,
            ledger: detached()
        })
        expect(r.actions).toMatchObject([{kind: 'claim', by: CLIENT_API, paths: [P]}])
        const entry = r.ledger.find(o => o.quote === QUOTE)!
        expect(entry.title).toBe(CLIENT_API)
        expect(entry.pending).toBeUndefined()
        expect(ownedForTitle(r.ledger, CLIENT_API).map(o => o.quote)).toContain(QUOTE)
    })

    test('a task that only fences itself off the path does not claim it', () => {
        const r = claimPendingRequirements({
            intent: REFINED.fenced,
            title: 'Listing CRUD routes',
            ledger: detached()
        })
        expect(r.actions).toEqual([])
        expect(unclaimedPendingRequirements(r.ledger)).toHaveLength(1)
    })

    test('a task that only imports the file does not claim it', () => {
        const r = claimPendingRequirements({
            intent: REFINED.importer,
            title: 'Client shell',
            ledger: detached()
        })
        expect(r.actions).toEqual([])
    })

    test('inv-single-owner — the second claimant finds nothing pending', () => {
        const first = claimPendingRequirements({
            intent: REFINED.claimant,
            title: CLIENT_API,
            ledger: detached()
        })
        const second = claimPendingRequirements({
            intent: REFINED.claimant,
            title: 'Some later task',
            ledger: first.ledger
        })
        expect(second.actions).toEqual([])
        expect(second.ledger.find(o => o.quote === QUOTE)!.title).toBe(CLIENT_API)
    })

    test('inv-no-new-conflict — the clause lands where the file is not frozen', () => {
        const claimed = claimPendingRequirements({
            intent: REFINED.claimant,
            title: CLIENT_API,
            ledger: detached()
        }).ledger
        const spec = appendOwnedConstraints(
            specWith(['  - Do not modify `package.json` or any route file.']),
            ownedForTitle(claimed, CLIENT_API)
        )
        expect(spec).toContain('serves `/api` + static `dist/`')
        expect(findOwnedFreezeConflicts(spec, {owned: claimed, isSource: anySource})).toEqual([])
    })

    test('an unclaimed obligation stays visible as a debt', () => {
        expect(unclaimedPendingRequirements(detached()).map(o => o.quote)).toEqual([QUOTE])
    })
})

describe('claim → detach cycle', () => {
    test('a claimant that also freezes the path releases it again, and terminates', () => {
        const claimed = claimPendingRequirements({
            intent: REFINED.claimant,
            title: CLIENT_API,
            ledger: detach().ledger
        }).ledger
        // The claimant's own spec freezes everything but `src/client/api.ts`.
        const spec = appendOwnedConstraints(
            [
                'GOAL',
                '  Client API layer.',
                'CONSTRAINTS',
                '  - Do not modify any source files outside of `src/client/api.ts`.',
                'ACCEPTANCE',
                '  - `src/client/api.ts` exports a typed client.'
            ].join('\n'),
            ownedForTitle(claimed, CLIENT_API)
        )
        const again = detachUnsatisfiableRequirements({
            spec,
            title: CLIENT_API,
            ledger: claimed,
            isSource: anySource
        })
        expect(again.actions).toMatchObject([{kind: 'detach', from: CLIENT_API}])
        const entry = again.ledger.find(o => o.quote === QUOTE)!
        expect(entry.pending).toEqual([P])
        // Provenance follows the last owner, and the quote is still verbatim.
        expect(entry.title).toBe(CLIENT_API)
        expect(entry.quote).toBe(QUOTE)
        // A task claims at most once (it composes once), so the cycle is finite:
        // re-running the claim for the same task now finds nothing to take.
        expect(
            claimPendingRequirements({
                intent: REFINED.claimant,
                title: CLIENT_API,
                ledger: again.ledger
            }).actions
        ).toHaveLength(1)
    })
})

describe('ledger round-trip', () => {
    test('pending survives write → parse, and old ledgers still parse', () => {
        const detached = detach().ledger
        const text = detached
            .map(
                o =>
                    `OWNED: "${o.quote}"${o.anchor ? ` [anchor: ${o.anchor}]` : ''}`
                    + (o.pending ? ` [pending: ${o.pending.join(', ')}]` : '')
                    + ` [title: ${o.title}]`
            )
            .join('\n')
        const back = parseOwnedRequirements(text)
        expect(back.find(o => o.quote === QUOTE)!.pending).toEqual([P])
        expect(back.find(o => o.quote !== QUOTE)!.pending).toBeUndefined()
        expect(back.map(o => o.quote).sort()).toEqual(detached.map(o => o.quote).sort())
    })
})
