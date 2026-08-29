/**
 * The five A/B-1 invariants, pinned as fixtures, plus the two corpus shapes that
 * decided the closed negation set.
 */
import {describe, expect, test} from 'bun:test'

import {applyRefutations, detectRefutations, dropToken} from '../../src/task/refuted-constraint.js'

const OWNED_STAMP =
    'owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)'

/** The lead's own lines, verbatim from a real spec. */
const LEAD_CONSTRAINT =
    '- Preserve every existing field in `package.json`: name (`mx5-private`), private, type, all existing scripts'
    + ' (`lint`, `test`). Add only new entries the task requires (e.g., `hono`, `bun-sql`-equivalent,'
    + ' `@hono/zod-validator`, `argon2`, `sharp`, `wouter`, `react`, `react-dom`, `tailwindcss`,'
    + ' `@playwright/experimental-ct-react`, `playwright`, and any other runtime/dev dependencies the spec pins).'
    + ' Do not remove or rename any existing entry.'
const LEAD_ARGON2_RESEARCH =
    '- Password hashing uses `Bun.password` (built-in argon2id) — no external `argon2` or `@node-rs/argon2`'
    + " dependency needed despite the task's mention of it."
const LEAD_BUNSQL_RESEARCH =
    '- Postgres access uses Bun\'s built-in SQL client (`import { sql } from "bun"`) — no `bun-sql` npm package'
    + ' exists; this is a runtime builtin, not a dependency to add.'

function refinedWith(...constraints: string[]): string {
    return ['GOAL', 'Scaffold the project.', '', 'CONSTRAINTS', ...constraints, ''].join('\n')
}
function researchWith(...bullets: string[]): string {
    return ['FILES', '- package.json', '', 'CONTEXT', ...bullets, ''].join('\n')
}

/** Character subsequence — the mechanical form of "only deletes". */
function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0
    for (const ch of haystack) if (i < needle.length && needle[i] === ch) i++
    return i === needle.length
}

describe('the lead — mx5 run 19 TASK_0001', () => {
    const refined = refinedWith(LEAD_CONSTRAINT)
    const research = researchWith(LEAD_ARGON2_RESEARCH, LEAD_BUNSQL_RESEARCH)

    test('both refuted tokens are detected, with their source lines', () => {
        const found = detectRefutations(refined, research)
        expect(found.map(r => r.token).sort()).toEqual(['argon2', 'bun-sql'])
        expect(found.find(r => r.token === 'argon2')!.research).toContain('no external `argon2`')
        expect(found.find(r => r.token === 'bun-sql')!.pattern).toBe('no-package-exists')
    })

    test('both are dropped from CONSTRAINTS, and nothing else is', () => {
        const {refined: out} = applyRefutations(refined, research)
        expect(out).not.toContain('`argon2`')
        expect(out).not.toContain('`bun-sql`')
        // `bun-sql`-equivalent: the glued suffix goes with the token.
        expect(out).not.toContain('-equivalent')
        for (const kept of [
            '`hono`',
            '`sharp`',
            '`wouter`',
            '`react-dom`',
            '`playwright`',
            '`package.json`'
        ]) {
            expect(out).toContain(kept)
        }
    })

    test('inv-no-line-invention — the result is a strict subsequence', () => {
        const {refined: out} = applyRefutations(refined, research)
        expect(isSubsequence(out, refined)).toBe(true)
        expect(out.length).toBeLessThan(refined.length)
    })

    test('inv-trail — every drop quotes both source lines', () => {
        const {trail} = applyRefutations(refined, research)
        expect(trail).toHaveLength(2)
        for (const line of trail) {
            expect(line).toContain('constraint refuted by research')
            expect(line).toContain('| constraint: "')
            expect(line).toContain('| research: "')
        }
        expect(trail.join('\n')).toContain('no `bun-sql` npm package exists')
    })
})

describe('inv-owned-untouched', () => {
    test('an owned CONSTRAINTS line is never modified, even when research refutes its token', () => {
        const ownedLine = `  - "Password hashing uses \`argon2\`" [4. Auth] — ${OWNED_STAMP}`
        const refined = refinedWith(ownedLine, LEAD_CONSTRAINT)
        const {refined: out, trail} = applyRefutations(refined, researchWith(LEAD_ARGON2_RESEARCH))
        expect(out).toContain(ownedLine)
        // …while the refine-invented one on the very same token still goes.
        expect(trail).toHaveLength(1)
        expect(out.split('\n').filter(l => l.includes('`argon2`'))).toEqual([ownedLine])
    })
})

describe('inv-noop-when-no-refutation', () => {
    test('no CONTEXT negation ⇒ byte-identical', () => {
        const refined = refinedWith(LEAD_CONSTRAINT)
        const research = researchWith(
            '- `package.json` pins `hono` at 4.12.27 and `sharp` at 0.35.3.'
        )
        const {refined: out, trail} = applyRefutations(refined, research)
        expect(out).toBe(refined)
        expect(trail).toHaveLength(0)
    })

    test('no CONSTRAINTS section, or no CONTEXT section ⇒ byte-identical', () => {
        const research = researchWith(LEAD_ARGON2_RESEARCH)
        expect(applyRefutations('GOAL\nDo the thing.\n', research).refined).toBe(
            'GOAL\nDo the thing.\n'
        )
        const refined = refinedWith(LEAD_CONSTRAINT)
        expect(applyRefutations(refined, 'FILES\n- package.json\n').refined).toBe(refined)
    })

    test('a token refuted by research but absent from CONSTRAINTS is a no-op', () => {
        const refined = refinedWith('- Use `hono` for routing.')
        const {refined: out, trail} = applyRefutations(refined, researchWith(LEAD_ARGON2_RESEARCH))
        expect(out).toBe(refined)
        expect(trail).toHaveLength(0)
    })
})

describe('inv-precision — the shapes STEP 0 rejected', () => {
    // 300 of the first cut's 306 corpus hits were this: a MANIFEST-STATE bullet
    // that says the dependency is missing and MUST BE ADDED. Dropping on it
    // mutilated real constraints ("use  with the shared `loginSchema`").
    test('"currently lists no `X` dependencies; they must be added" does NOT refute', () => {
        const refined = refinedWith(
            '- **Input validation:** use `@hono/zod-validator` with the shared `loginSchema` from `src/shared/schema.ts`.'
        )
        const research = researchWith(
            '- `package.json` currently lists no `hono` or `@hono/zod-validator` dependencies; they must be added at'
                + ' versions 4.12.27 and 0.8.0 respectively per the task spec.'
        )
        const {refined: out, trail} = applyRefutations(refined, research)
        expect(trail).toHaveLength(0)
        expect(out).toBe(refined)
    })

    test('"has … and no `sharp` dependency — must add `sharp`" does NOT refute', () => {
        const refined = refinedWith(
            '- Preserve all existing `package.json` fields. Only add `sharp` as a devDependency.'
        )
        const research = researchWith(
            '- `package.json` has `@hono/zod-validator` pinned at `0.8.0` and no `sharp` dependency — must add `sharp`'
                + ' as devDependency while preserving all existing deps.'
        )
        expect(applyRefutations(refined, research).trail).toHaveLength(0)
    })

    // The doc's pre-registered risk: a bullet naming one package negatively and
    // another positively must only ever refute the one inside the negation.
    test('a negation of one package does not refute the alternative named beside it', () => {
        const refined = refinedWith('- Hash with `argon2`; do not use `@node-rs/argon2`.')
        const research = researchWith(
            '- No `@node-rs/argon2` dependency is needed here — the repo uses the `argon2` package throughout.'
        )
        const {refined: out, trail} = applyRefutations(refined, research)
        expect(trail).toHaveLength(1)
        expect(out).toContain('`argon2`')
        expect(out).not.toContain('`@node-rs/argon2`')
    })

    // 412 corpus bullets carry "does not require" as ordinary behavioural prose.
    test('behavioural "does NOT require" prose does not refute anything', () => {
        const refined = refinedWith('- The `mine` filter is applied only when `c.var.user` is set.')
        const research = researchWith(
            "- The server's `GET /api/listings` endpoint does NOT require authentication for the `mine` filter — it"
                + " checks `if (mine === '1' && c.var.user)`."
        )
        expect(applyRefutations(refined, research).trail).toHaveLength(0)
    })

    test('an API expression is never treated as a package token', () => {
        const refined = refinedWith('- Hash with `Bun.password`.')
        const research = researchWith('- `Bun.password` is not needed as an npm dependency.')
        expect(applyRefutations(refined, research).trail).toHaveLength(0)
    })
})

describe('dropToken', () => {
    test('eats the preceding list separator, keeping the list shape', () => {
        expect(dropToken('- Add `hono`, `argon2`, `sharp`.', 'argon2')).toBe(
            '- Add `hono`, `sharp`.'
        )
        expect(dropToken('- Add `argon2`, `sharp`.', 'argon2')).toBe('- Add `sharp`.')
        expect(dropToken('- Add `hono` or `argon2`.', 'argon2')).toBe('- Add `hono`.')
    })

    test('takes a suffix glued to the token with it', () => {
        expect(dropToken('- Add `hono`, `bun-sql`-equivalent, `sharp`.', 'bun-sql')).toBe(
            '- Add `hono`, `sharp`.'
        )
    })

    test('signals a whole-line drop rather than leaving a carcass', () => {
        expect(dropToken('- `argon2`', 'argon2')).toBeNull()
        expect(dropToken('- (e.g., `argon2`)', 'argon2')).toBeNull()
    })

    test('never rephrases — an untouched line comes back identical', () => {
        const line = '- Add `hono` and `sharp`.'
        expect(dropToken(line, 'argon2')).toBe(line)
    })

    test('a whole-line drop removes the line and trails it', () => {
        const refined = refinedWith('- Add `hono`.', '- `argon2`')
        const {refined: out, trail} = applyRefutations(refined, researchWith(LEAD_ARGON2_RESEARCH))
        expect(out).not.toContain('`argon2`')
        expect(out).toContain('- Add `hono`.')
        expect(trail[0]).toContain('dropped the whole CONSTRAINTS line')
    })
})
