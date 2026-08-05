/**
 * Scorer check for A/B-2's two counts — run BEFORE trusting any proportion.
 *
 * The metric is the whole experiment, and this one was wrong three times before
 * it was right (each caught by a hand-read of a live rep, each pinned below):
 * bare token presence scored a spec that PROHIBITS `argon2` as one that requires
 * it. A metric that cannot tell a requirement from a prohibition would have
 * reported the lever's own success as its failure.
 *
 * POSITIVES  the recorded run-19 spec (the shipped defect) and hand-built
 *            requirement/prohibition shapes.
 * NEGATIVES  every way a spec can name `argon2` while telling the implementer
 *            not to use it.
 *
 * Exits 0 when every case scores as stated, 1 otherwise.
 *
 * Run: bun run scripts/refuted-constraint-scorer-check.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {forbidsMandatedApi, requiresUnneededDep} from './refuted-constraint-delivered-ab.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')

type Case = {name: string; spec: string; dep: string[]; api: string[]}

const wrap = (...constraints: string[]): string =>
    ['GOAL', 'g', '', 'CONSTRAINTS', ...constraints, '', 'ACCEPTANCE', '- a', '', 'VERIFY:'].join('\n')

const CASES: Case[] = [
    // ── REQUIREMENTS (the defect) ────────────────────────────────────────────
    {
        name: 'plain dependency-list requirement',
        spec: wrap('- Add only new entries the task requires: `hono`, `argon2`, `sharp`.'),
        dep: ['argon2'],
        api: []
    },
    {
        name: 'the lead\'s own prohibition against the design API',
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
    },

    // ── NON-REQUIREMENTS (what the lever is supposed to produce) ─────────────
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

function section(md: string, name: string): string {
    const m = new RegExp(`^## ${name}\\s*$`, 'm').exec(md)!
    const rest = md.slice(m.index + m[0].length)
    const next = /^## /m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

function main(): void {
    let bad = 0
    const eq = (a: string[], b: string[]) => a.slice().sort().join(',') === b.slice().sort().join(',')

    const recordedPath = path.join(MX5, '.pi-tasks', 'TASK_0001.md')
    if (fs.existsSync(recordedPath)) {
        const spec = section(fs.readFileSync(recordedPath, 'utf8'), 'spec')
        const dep = requiresUnneededDep(spec)
        const api = forbidsMandatedApi(spec)
        const ok = eq(dep, ['argon2', 'bun-sql']) && eq(api, ['Bun.password', 'Bun.sql'])
        if (!ok) bad++
        console.log(`${ok ? 'ok  ' : 'BAD '} recorded run-19 spec — dep=[${dep}] api=[${api}]`)
    } else {
        console.log('skip  recorded run-19 spec (mx5 not present)')
    }

    for (const c of CASES) {
        const dep = requiresUnneededDep(c.spec)
        const api = forbidsMandatedApi(c.spec)
        const ok = eq(dep, c.dep) && eq(api, c.api)
        if (!ok) bad++
        console.log(
            `${ok ? 'ok  ' : 'BAD '} ${c.name} — dep=[${dep}] (want [${c.dep}]) api=[${api}] (want [${c.api}])`
        )
    }

    console.log(bad === 0 ? '\nSCORER OK' : `\nSCORER BROKEN — ${bad} case(s)`)
    process.exit(bad === 0 ? 0 : 1)
}

main()
