/**
 * Scorer check for A/B-2's two counts (`requiresUnneededDep`, `forbidsMandatedApi`).
 *
 * The metric is the whole experiment, and this one was wrong three times before
 * it was right (each caught by a hand-read of a live rep, each pinned below):
 * bare token presence scored a spec that PROHIBITS `argon2` as one that requires
 * it. A metric that cannot tell a requirement from a prohibition would have
 * reported the lever's own success as its failure.
 *
 * POSITIVES  hand-built requirement/prohibition shapes.
 * NEGATIVES  every way a spec can name `argon2` while telling the implementer
 *            not to use it.
 *
 * The eleventh case — the recorded run-19 spec, the shipped defect itself —
 * stays in `scripts/refuted-constraint-scorer-check.ts`, because it needs the
 * mx5 evidence tree. Everything here needs nothing but the scorers, so it runs
 * on every `bun test` instead of when somebody remembers to run it.
 *
 * The scorers are imported from the harness, which is guarded by
 * `import.meta.main` — this launches no model calls.
 */
import {describe, expect, test} from 'bun:test'
import {forbidsMandatedApi, requiresUnneededDep} from './refuted-constraint-delivered-ab.js'

type Case = {name: string; spec: string; dep: string[]; api: string[]}

const wrap = (...constraints: string[]): string =>
    ['GOAL', 'g', '', 'CONSTRAINTS', ...constraints, '', 'ACCEPTANCE', '- a', '', 'VERIFY:'].join('\n')

const sorted = (a: string[]): string[] => a.slice().sort()

describe('requirements — the defect the lever is supposed to remove', () => {
    const CASES: Case[] = [
        {
            name: 'plain dependency-list requirement',
            spec: wrap('- Add only new entries the task requires: `hono`, `argon2`, `sharp`.'),
            dep: ['argon2'],
            api: []
        },
        {
            name: "the lead's own prohibition against the design API",
            spec: wrap(
                '- Do NOT use built-in `Bun.password` for hashing — the refined task explicitly requires `argon2`.'
            ),
            dep: ['argon2'],
            api: ['Bun.password']
        },
        {
            name: 'VERIFY assertion pinning the dependency',
            spec: [
                'GOAL',
                'g',
                '',
                'CONSTRAINTS',
                '- keep fields',
                '',
                'ACCEPTANCE',
                '- a',
                '',
                'VERIFY:',
                '```sh',
                'node -e "const p=require(\'./package.json\'); if(!p.dependencies[\'argon2\']) throw new Error(1)"',
                '```'
            ].join('\n'),
            dep: ['argon2'],
            api: []
        },
        {
            name: 'bun-sql required alongside a Bun.sql prohibition',
            spec: wrap('- Do NOT use built-in `Bun.sql`; the task requires a `bun-sql`-equivalent client.'),
            dep: ['bun-sql'],
            api: ['Bun.sql']
        }
    ]

    for (const c of CASES) {
        test(c.name, () => {
            expect(sorted(requiresUnneededDep(c.spec))).toEqual(sorted(c.dep))
            expect(sorted(forbidsMandatedApi(c.spec))).toEqual(sorted(c.api))
        })
    }
})

describe('non-requirements — naming a token while telling the implementer not to use it', () => {
    const CASES: Case[] = [
        {
            name: 'prohibition: "do not add"',
            spec: wrap('- Password hashing uses `Bun.password` (built-in) — do not add `argon2` as a dependency.'),
            dep: [],
            api: []
        },
        {
            name: 'negation of need: "no external … needed"',
            spec: wrap(
                '- Password hashing uses `Bun.password` (built-in argon2id) — no external `argon2` or `@node-rs/argon2` dependency needed.'
            ),
            dep: [],
            api: []
        },
        {
            name: 'substitution: "instead of any external argon2 package"',
            spec: wrap(
                '- Use `Bun.password.hash()` and `Bun.password.verify()` (built-in argon2id) instead of any external `argon2` package.'
            ),
            dep: [],
            api: []
        },
        {
            name: '"no `bun-sql` npm package exists"',
            spec: wrap('- SQL access uses `import { sql } from "bun"`; no `bun-sql` npm package exists.'),
            dep: [],
            api: []
        },
        {
            name: 'a mandated API used positively is never scored as forbidden',
            spec: wrap('- Use `Bun.password` for hashing. Do not add `argon2`.'),
            dep: [],
            api: []
        },
        {
            name: 'a spec that mentions neither scores nothing',
            spec: wrap('- Add `hono`, `sharp`, `react` at the pinned versions.'),
            dep: [],
            api: []
        }
    ]

    for (const c of CASES) {
        test(c.name, () => {
            expect(sorted(requiresUnneededDep(c.spec))).toEqual(sorted(c.dep))
            expect(sorted(forbidsMandatedApi(c.spec))).toEqual(sorted(c.api))
        })
    }
})
