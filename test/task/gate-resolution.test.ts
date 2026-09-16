import {describe, expect, test} from 'bun:test'
import {
    AUTOFIX_BUDGET,
    RESOLUTION_RULES,
    autofixBudget,
    resolveDisposition,
    type Disposition,
    type ResolutionInput
} from '../../src/task/gate-resolution.js'
import {parseResolutionVerdict, BLOCKED_BY_FROZEN} from '../../src/task/verify-resolution.js'
import {runGatesForTask, type GateDeps, type GateParams} from '../../src/task/task-gates.js'
import type {VerifyFailClass} from '../../src/task/verify-work.js'
import type {DebtOrigin} from '../../src/task/accept-debt.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {ACCEPT_LABEL} from '../../src/task/verify-resolution.js'
import {getConfig} from '../../src/config/config.js'
import fixture from './__fixtures__/auto-0002-gate-sequences.json'

const FAIL_CLASSES: VerifyFailClass[] = [
    'repo-health',
    'static-checks',
    'model-verdict',
    'unobserved',
    'harness-fault'
]

const CONTRADICTION = {criterion: 'the build spec asserts X', frozenPath: 'tsconfig.json'}

const input = (over: Partial<ResolutionInput> = {}): ResolutionInput => ({
    failClass: 'model-verdict',
    recommend: 'autofix',
    unobserved: false,
    contradiction: null,
    attempts: 0,
    unattended: false,
    ...over
})

/** Every combination of the six input fields the table is allowed to read. */
function everyCell(): ResolutionInput[] {
    const cells: ResolutionInput[] = []
    for (const failClass of FAIL_CLASSES) {
        for (const recommend of ['autofix', 'accept'] as const) {
            for (const unobserved of [false, true]) {
                for (const contradiction of [null, CONTRADICTION]) {
                    // 0, mid-budget, exactly the budget, and past it.
                    for (const attempts of [0, 1, 3, 4]) {
                        for (const unattended of [false, true]) {
                            cells.push({
                                failClass,
                                recommend,
                                unobserved,
                                contradiction,
                                attempts,
                                unattended
                            })
                        }
                    }
                }
            }
        }
    }
    return cells
}

describe('the table is total and its rows are disjoint in effect', () => {
    test('every input cell resolves, and an accept ALWAYS carries a debt origin', () => {
        const cells = everyCell()
        expect(cells).toHaveLength(5 * 2 * 2 * 2 * 4 * 2)
        for (const cell of cells) {
            const d = resolveDisposition(cell)
            expect(['autofix', 'accept', 'ask']).toContain(d.action)
            expect(d.reason.length).toBeGreaterThan(0)
            // The invariant the type already carries, asserted over real values:
            // a terminal accept names its ledger class, and nothing else does.
            if (d.action === 'accept') expect(d.debtOrigin).not.toBeNull()
            else expect(d.debtOrigin).toBeNull()
        }
    })

    test('the LAST row matches unconditionally, so the table cannot fall through', () => {
        const last = RESOLUTION_RULES[RESOLUTION_RULES.length - 1]
        expect(last.id).toBe('autofix')
        for (const cell of everyCell()) expect(last.match(cell)).not.toBeNull()
    })

    test('row ids are unique and stated in precedence order', () => {
        expect(RESOLUTION_RULES.map(r => r.id)).toEqual([
            'spec-contradiction',
            'judge-accept',
            'no-autofix-budget',
            'budget-spent',
            'autofix'
        ])
    })
})

describe('AUTOFIX_BUDGET', () => {
    test('covers every fail class, and zero means "a re-run cannot move this"', () => {
        expect(Object.keys(AUTOFIX_BUDGET).sort()).toEqual([...FAIL_CLASSES].sort())
        expect(AUTOFIX_BUDGET.unobserved).toBe(0)
        expect(AUTOFIX_BUDGET['harness-fault']).toBe(0)
        for (const cls of ['repo-health', 'static-checks', 'model-verdict'] as const) {
            expect(AUTOFIX_BUDGET[cls]).toBeGreaterThan(0)
        }
    })

    test('an UNOBSERVED flag zeroes the budget of ANY class', () => {
        expect(autofixBudget({failClass: 'model-verdict', unobserved: false})).toBe(
            AUTOFIX_BUDGET['model-verdict']
        )
        for (const failClass of FAIL_CLASSES) {
            expect(autofixBudget({failClass, unobserved: true})).toBe(0)
        }
    })
})

describe('row by row', () => {
    test('a contradiction accepts on ROUND ONE, on every fail class, attended or not', () => {
        for (const failClass of FAIL_CLASSES) {
            for (const unattended of [false, true]) {
                for (const recommend of ['autofix', 'accept'] as const) {
                    const d = resolveDisposition(
                        input({failClass, unattended, recommend, contradiction: CONTRADICTION})
                    )
                    expect(d.rule).toBe('spec-contradiction')
                    expect(d.action).toBe('accept')
                    expect(d.debtOrigin).toBe('spec-contradiction')
                    expect(d.reason).toContain('tsconfig.json')
                }
            }
        }
    })

    test('a judge ACCEPT is never overridden — no rule below it can turn it into an autofix', () => {
        for (const failClass of FAIL_CLASSES) {
            for (const attempts of [0, 1, 3, 4]) {
                const attended = resolveDisposition(
                    input({failClass, attempts, recommend: 'accept'})
                )
                expect(attended.action).toBe('ask')
                const unattended = resolveDisposition(
                    input({failClass, attempts, recommend: 'accept', unattended: true})
                )
                expect(unattended.action).toBe('accept')
                expect(unattended.debtOrigin).toBe('yolo-accepted')
            }
        }
    })

    test('a zero-budget class never autofixes, whatever the judge said', () => {
        for (const failClass of ['unobserved', 'harness-fault'] as const) {
            const d = resolveDisposition(input({failClass}))
            expect(d.rule).toBe('no-autofix-budget')
            expect(d.action).toBe('ask')
            // …and the trail never calls a budget that was never offered "spent".
            expect(d.reason).not.toContain('spent')
        }
        expect(resolveDisposition(input({failClass: 'unobserved'})).reason).toContain('UNOBSERVED')
        expect(resolveDisposition(input({failClass: 'harness-fault'})).reason).toContain(
            'harness fault'
        )
    })

    test('the budget is spent EXACTLY at its size, never one round late', () => {
        const budget = AUTOFIX_BUDGET['model-verdict']
        for (let attempts = 0; attempts < budget; attempts++) {
            const d = resolveDisposition(input({attempts}))
            expect(d.action).toBe('autofix')
            expect(d.reason).toContain(`${attempts + 1}/${budget}`)
        }
        const spent = resolveDisposition(input({attempts: budget}))
        expect(spent.rule).toBe('budget-spent')
        expect(spent.action).toBe('ask')
        expect(spent.reason).toContain(`${budget}/${budget}`)
    })

    test('unattended, a spent budget accepts rather than reaching an unreachable picker', () => {
        const d = resolveDisposition(
            input({attempts: AUTOFIX_BUDGET['model-verdict'], unattended: true})
        )
        expect(d.action).toBe('accept')
        expect(d.debtOrigin).toBe('yolo-accepted')
    })
})

describe(`the ${BLOCKED_BY_FROZEN} marker`, () => {
    test('mints a contradiction from path and criterion', () => {
        const out = parseResolutionVerdict(
            'reasoning…\nVERIFY-RESOLUTION: BLOCKED-BY-FROZEN src/client/index.css — at least one '
                + 'OKLCH token appears verbatim in the compiled CSS'
        )
        expect(out.contradiction).toEqual({
            frozenPath: 'src/client/index.css',
            criterion: 'at least one OKLCH token appears verbatim in the compiled CSS'
        })
        expect(out.recommend).toBe('accept')
        expect(out.rationale).toContain('src/client/index.css')
    })

    test('a retyped separator still parses — losing one costs the whole budget', () => {
        for (const sep of ['—', '–', '-', '--']) {
            const out = parseResolutionVerdict(
                `VERIFY-RESOLUTION: BLOCKED-BY-FROZEN tsconfig.json ${sep} the lint must pass`
            )
            expect(out.contradiction).toEqual({
                frozenPath: 'tsconfig.json',
                criterion: 'the lint must pass'
            })
        }
    })

    test('a path with no criterion is still a contradiction; a marker with neither is not', () => {
        const pathOnly = parseResolutionVerdict('VERIFY-RESOLUTION: BLOCKED-BY-FROZEN package.json')
        expect(pathOnly.contradiction).toEqual({frozenPath: 'package.json', criterion: ''})
        const bare = parseResolutionVerdict('VERIFY-RESOLUTION: BLOCKED-BY-FROZEN')
        expect(bare.contradiction).toBeUndefined()
        expect(bare.recommend).toBe('accept')
    })

    test('LAST match wins, as for the other two verdicts', () => {
        const out = parseResolutionVerdict(
            'I considered VERIFY-RESOLUTION: AUTOFIX first.\n'
                + 'VERIFY-RESOLUTION: BLOCKED-BY-FROZEN build.ts — the artifact name is pinned'
        )
        expect(out.contradiction?.frozenPath).toBe('build.ts')
    })

    test('the judge prompt states the marker, so a judge can reach for it', async () => {
        const {buildResolutionPrompt} = await import('../../src/task/verify-resolution.js')
        expect(buildResolutionPrompt('SPEC', 'FAIL')).toContain(
            `VERIFY-RESOLUTION: ${BLOCKED_BY_FROZEN} <frozen path> — <the criterion it blocks>`
        )
    })
})

// ─── Every loop exit records a debt ─────────────────────────────────────────
//
// Five defects left AUTO_0002's gate with no ledger entry at all. The property
// below is the guard: drive the real loop over the input space and assert that
// whenever it FINISHES a task whose verify never passed, exactly one debt was
// written, under an origin that names how it got there.

const baseParams = (over: Partial<GateParams> = {}): GateParams => ({
    cwd: '/tmp/x',
    taskId: 'TASK_0006',
    title: 'A',
    tag: 'TASK_0006',
    ...over
})

async function withYolo(on: boolean, fn: () => Promise<void>): Promise<void> {
    const cfg = getConfig()
    const prev = cfg.yoloMode
    cfg.yoloMode = on
    try {
        await fn()
    } finally {
        cfg.yoloMode = prev
    }
}

interface ExitCase {
    name: string
    unattended: boolean
    /** Queue an ACCEPT at the picker, or leave it to be dismissed. */
    pickAccept: boolean
    /** What the gate returns — a dismissed picker pauses, everything else finishes. */
    ends: 'done' | 'paused'
    origin: DebtOrigin
    deps: Partial<GateDeps>
}

const NEVER_VERIFIES: GateDeps['verify'] = () =>
    Promise.resolve({ok: false, failClass: 'model-verdict', reason: 'route 500s'})

const JUDGE_ACCEPTS: Partial<GateDeps> = {
    verify: NEVER_VERIFIES,
    recommend: () => Promise.resolve({recommend: 'accept', rationale: 'fine'})
}

const JUDGE_AUTOFIXES: Partial<GateDeps> = {
    verify: NEVER_VERIFIES,
    recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'defect'})
}

const EXIT_CASES: ExitCase[] = [
    {
        name: 'judge ACCEPT, unattended',
        unattended: true,
        pickAccept: false,
        ends: 'done',
        origin: 'yolo-accepted',
        deps: JUDGE_ACCEPTS
    },
    {
        name: 'judge ACCEPT, human accepts',
        unattended: false,
        pickAccept: true,
        ends: 'done',
        origin: 'accepted',
        deps: JUDGE_ACCEPTS
    },
    {
        name: 'judge ACCEPT, human dismisses',
        unattended: false,
        pickAccept: false,
        ends: 'paused',
        origin: 'dismissed',
        deps: JUDGE_ACCEPTS
    },
    {
        name: 'budget spent, unattended',
        unattended: true,
        pickAccept: false,
        ends: 'done',
        origin: 'yolo-accepted',
        deps: JUDGE_AUTOFIXES
    },
    {
        name: 'budget spent, human dismisses',
        unattended: false,
        pickAccept: false,
        ends: 'paused',
        origin: 'dismissed',
        deps: JUDGE_AUTOFIXES
    },
    {
        name: 'UNOBSERVED, unattended',
        unattended: true,
        pickAccept: false,
        ends: 'done',
        origin: 'yolo-accepted',
        deps: {
            verify: () =>
                Promise.resolve({
                    ok: false,
                    failClass: 'unobserved',
                    unobserved: true,
                    reason: 'work unobserved: no runner'
                })
        }
    },
    {
        name: 'harness fault, human accepts',
        unattended: false,
        pickAccept: true,
        ends: 'done',
        origin: 'accepted',
        deps: {
            verify: () =>
                Promise.resolve({
                    ok: false,
                    failClass: 'harness-fault',
                    reason: 'verification pass could not run: provider died'
                })
        }
    },
    {
        name: 'spec contradiction from lint-fix',
        unattended: false,
        pickAccept: false,
        ends: 'done',
        origin: 'spec-contradiction',
        deps: {
            verify: () =>
                Promise.resolve({
                    ok: false,
                    failClass: 'repo-health',
                    reason: 'repo health: `bun run lint` exited 1'
                }),
            lintFix: () =>
                Promise.resolve({
                    ok: false,
                    class: 'frozen-path',
                    contradiction: {criterion: 'the lint must pass', frozenPath: 'tsconfig.json'},
                    reason: 'frozen-path: tsconfig.json'
                })
        }
    },
    {
        name: 'spec contradiction from the judge marker',
        unattended: true,
        pickAccept: false,
        ends: 'done',
        origin: 'spec-contradiction',
        deps: {
            verify: NEVER_VERIFIES,
            recommend: () =>
                Promise.resolve(
                    parseResolutionVerdict(
                        'VERIFY-RESOLUTION: BLOCKED-BY-FROZEN build.ts — the artifact name is pinned'
                    )
                )
        }
    }
]

describe('every exit of the resolution loop over a FAIL records a debt naming how it got there', () => {
    for (const c of EXIT_CASES) {
        test(c.name, async () => {
            await withTmpTaskDir(async dir => {
                const handle = makeFakeCtx(dir)
                const recorded: Array<{origin: DebtOrigin; reason: string}> = []
                const deps: GateDeps = {
                    runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}}),
                    commit: () => Promise.resolve({committed: true}),
                    recordDebt: (_cwd, _id, reason, origin) => {
                        recorded.push({origin, reason})
                        return Promise.resolve()
                    },
                    ...c.deps
                }
                if (c.pickAccept) handle.queueSelect(ACCEPT_LABEL)
                await withYolo(c.unattended, async () => {
                    const r = await runGatesForTask(handle.ctx, deps, baseParams({cwd: dir}))
                    expect(r.kind).toBe(c.ends)
                })
                expect(recorded).toHaveLength(1)
                expect(recorded[0].origin).toBe(c.origin)
                expect(recorded[0].reason.length).toBeGreaterThan(0)
            })
        })
    }
})

test('a verify that PASSES records no debt — the ledger is for defects, not for rounds', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const recorded: unknown[] = []
        let calls = 0
        const deps: GateDeps = {
            runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}}),
            commit: () => Promise.resolve({committed: true}),
            verify: () => {
                calls++
                return Promise.resolve(
                    calls === 1 ?
                        {ok: false, failClass: 'model-verdict', reason: 'route 500s'}
                    :   {ok: true}
                )
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'defect'}),
            recordDebt: () => {
                recorded.push(1)
                return Promise.resolve()
            }
        }
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(recorded).toEqual([])
    })
})

// ─── Replay: the two AUTO_0002 gate sequences this table was built for ──────
//
// `auto-0002-gate-sequences.json` transcribes the verify and judge outcomes from
// the `## gates` sections of mx5-n's TASK_0034 and TASK_0053, read-only. What the
// run actually DID with them is in each fixture's `shipped` block, and it is what
// these tests assert is no longer done.

/** Drive the whole gate over a scripted sequence of verify verdicts. */
async function replay(
    dir: string,
    opts: {
        failReasons: string[]
        failClass: VerifyFailClass
        judge: (round: number) => string
        lintFix?: GateDeps['lintFix']
    }
): Promise<{
    kind: string
    autofixAttempts: number
    debts: Array<{origin: DebtOrigin; reason: string}>
    trail: string[]
}> {
    const {ctx} = makeFakeCtx(dir)
    const debts: Array<{origin: DebtOrigin; reason: string}> = []
    const trail: string[] = []
    let round = 0
    let autofixAttempts = 0
    const deps: GateDeps = {
        runTask: () => {
            autofixAttempts++
            return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
        },
        commit: () => Promise.resolve({committed: true}),
        verify: () => {
            const reason = opts.failReasons[Math.min(round, opts.failReasons.length - 1)]
            round++
            return Promise.resolve({ok: false, failClass: opts.failClass, reason})
        },
        recommend: () => Promise.resolve(parseResolutionVerdict(opts.judge(round))),
        record: (_c, _i, line) => {
            trail.push(line)
            return Promise.resolve()
        },
        recordDebt: (_cwd, _id, reason, origin) => {
            debts.push({origin, reason})
            return Promise.resolve()
        },
        ...(opts.lintFix ? {lintFix: opts.lintFix} : {})
    }
    let kind = ''
    await withYolo(true, async () => {
        kind = (await runGatesForTask(ctx, deps, baseParams({cwd: dir}))).kind
    })
    return {kind, autofixAttempts, debts, trail}
}

describe('replay of AUTO_0002', () => {
    test('0034: the judge ACCEPT is KEPT — no rescue attempt, and the defect is written down', async () => {
        const f = fixture.TASK_0034
        // What shipped: one rescue attempt over a correct ACCEPT, 41 minutes, 16
        // suppressions, and nothing in the ledger.
        expect(f.shipped.autofixAttempts).toBe(1)
        expect(f.shipped.debtsRecorded).toBe(0)
        await withTmpTaskDir(async dir => {
            const r = await replay(dir, {
                failReasons: f.verifyReasons,
                failClass: 'repo-health',
                judge: () => f.judgeVerdicts[0],
                // The real lint-fix BLOCKED on an upstream typing bug — not a frozen
                // path, so it mints no contradiction and the judge decides.
                lintFix: () =>
                    Promise.resolve({ok: false, class: 'not-applied', reason: f.lintFixReason})
            })
            expect(r.kind).toBe('done')
            expect(r.autofixAttempts).toBe(0)
            expect(r.debts).toHaveLength(1)
            expect(r.debts[0].origin).toBe('yolo-accepted')
            expect(r.debts[0].reason).toBe(f.verifyReasons[0])
            expect(r.trail.some(l => l.includes('judge recommended ACCEPT'))).toBe(true)
        })
    })

    test('0053: the judge marker ends it on ROUND ONE with a spec-contradiction debt', async () => {
        const f = fixture.TASK_0053
        // What shipped: four verify rounds, three implementation re-runs, and only
        // then a debt — for a criterion round one had already shown unreachable.
        expect(f.shipped.rounds).toBe(4)
        expect(f.shipped.autofixAttempts).toBe(3)
        await withTmpTaskDir(async dir => {
            const r = await replay(dir, {
                failReasons: f.verifyReasons,
                failClass: 'model-verdict',
                // Under the new contract the judge that found the criterion
                // unreachable says so with the marker instead of asking for a re-run
                // it knows cannot converge — the vocabulary the real judge lacked.
                judge: () => f.judgeUnderNewContract
            })
            expect(r.kind).toBe('done')
            expect(r.autofixAttempts).toBe(0)
            expect(r.debts).toHaveLength(1)
            expect(r.debts[0].origin).toBe('spec-contradiction')
            // Still static-class-routable: the reason LEADS with the minted prefix.
            expect(r.debts[0].reason.startsWith(f.verifyReasons[0])).toBe(true)
            expect(r.debts[0].reason).toContain('src/client/index.css')
        })
    })

    test("0053: replaying the judge's REAL verdicts still terminates on the budget", async () => {
        const f = fixture.TASK_0053
        await withTmpTaskDir(async dir => {
            const r = await replay(dir, {
                failReasons: f.verifyReasons,
                failClass: 'model-verdict',
                judge: round => f.judgeVerdicts[Math.min(round - 1, f.judgeVerdicts.length - 1)]
            })
            expect(r.kind).toBe('done')
            // The budget is what bounds a judge with no word for "impossible"; the
            // marker is what makes those three rounds unnecessary.
            expect(r.autofixAttempts).toBe(AUTOFIX_BUDGET['model-verdict'])
            expect(r.debts).toHaveLength(1)
            expect(r.debts[0].origin).toBe('yolo-accepted')
        })
    })
})

test('a disposition the table calls `autofix` or `ask` never names a ledger class', () => {
    const nonTerminal: Disposition[] = everyCell()
        .map(resolveDisposition)
        .filter(d => d.action !== 'accept')
    expect(nonTerminal.length).toBeGreaterThan(0)
    for (const d of nonTerminal) expect(d.debtOrigin).toBeNull()
})
