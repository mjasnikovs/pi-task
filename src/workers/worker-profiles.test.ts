import {describe, expect, test} from 'bun:test'
import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    applyOverride,
    DEFAULT_LOOP_DETECTOR,
    DEFAULT_LOOP_PROGRESS,
    RESEARCH_WORKER_TIMEOUT_MS,
    STALL_AFTER_MS,
    WORKER_PROFILES,
    workerPolicy,
    type WorkerGuardPolicy,
    type WorkerProfileId
} from './worker-profiles.js'
import {WORKER_KILLS} from './worker-kill.js'
import {MAX_LOOP_RESTARTS} from '../task/child-runner.js'
import {
    DEFAULT_WORKER_PROGRESS_CEILING_MS,
    FANOUT_TIMEOUT_CEILING_ENV,
    FANOUT_TIMEOUT_PER_LOOKUP_ENV,
    RESEARCH_LEVER_ENVS,
    snapshotLeverEnv,
    WORKER_CARRY_FORWARD_ENV,
    WORKER_PROGRESS_CEILING_ENV
} from '../task/research-fanout-budget.js'
import {runWorker} from './pi-worker-core.js'
import {agentEndResponse, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

/**
 * THE DEFAULTS, WRITTEN OUT LONGHAND.
 *
 * What `runWorker` filled in around a caller that named no guards at all, back
 * when `RunWorkerInput` carried the knobs. Written out in full — not built from a
 * helper — because a literal is the only form that can disagree with the table it
 * is checking.
 *
 * It is no longer any profile's resolved policy: `adhoc` deliberately departs
 * from it on the clock (no wall clock, a silence bound instead). It stays as the
 * reference the other rows are diffed against, so a change to any guard OTHER
 * than the one we meant to change still fails a test.
 */
const ADHOC: WorkerGuardPolicy = {
    guards: {
        stalled: {afterMs: 180_000, probe: null},
        'command-timeout': 0,
        'stream-stall': 0,
        'worker-timeout': {timeoutMs: 240_000, progressCeilingMs: null, fanout: null},
        'connection-error': 2,
        loop: {
            detector: {window: 20, threshold: 5, pathThreshold: 5},
            progress: {limit: 8, churnFactor: 2}
        },
        'leaked-tool-call': null,
        aborted: null,
        exit: null
    },
    carryForward: false
}

describe('WORKER_PROFILES — the shipped policy of each worker child', () => {
    test('adhoc has NO WALL CLOCK, and is bounded by SILENCE instead', () => {
        // The change of record. A fixed elapsed-time cap on a read-only worker is
        // a hardware test, not a work test — the same prompt on slower hardware
        // loses its work, and no constant fixes that. The replay corroborates
        // rather than decides: after nothing but a MODEL swap on the same machine,
        // 5 of 28 valid trials ran past the "~25-130s" this was sized against.
        const g = workerPolicy('adhoc', {streamInactivityMs: 1_800_000}).guards
        expect(g['worker-timeout']).toEqual({
            timeoutMs: 0,
            progressCeilingMs: null,
            fanout: null
        })
        expect(g['stream-stall']).toBe(1_800_000)
    })

    test('adhoc arms NO silence bound when the caller hands it no setting', () => {
        // 0 is off. A harness that names no config must not silently acquire a
        // guard it never asked for — the same rule the gate row follows.
        expect(workerPolicy('adhoc').guards['stream-stall']).toBe(0)
        expect(workerPolicy('adhoc').guards['worker-timeout'].timeoutMs).toBe(0)
    })

    test('everything OTHER than the clock is still every default', () => {
        const g = workerPolicy('adhoc').guards
        expect({...g, 'worker-timeout': ADHOC.guards['worker-timeout']}).toEqual(ADHOC.guards)
    })

    test('gate: no wall clock, both watchdogs armed from config, path rule off', () => {
        expect(
            workerPolicy('gate', {commandTimeoutMs: 900_000, streamInactivityMs: 600_000})
        ).toEqual({
            guards: {
                ...ADHOC.guards,
                'command-timeout': 900_000,
                'stream-stall': 600_000,
                'worker-timeout': {timeoutMs: 0, progressCeilingMs: null, fanout: null},
                loop: {
                    detector: {window: 20, threshold: 5, pathThreshold: Number.POSITIVE_INFINITY},
                    progress: {limit: 8, churnFactor: 2}
                }
            },
            carryForward: false
        })
    })

    test('gate with no config numbers leaves both watchdogs OFF, not defaulted', () => {
        // 0 is the off value `commandCeilingForAttempt` and the stream watchdog
        // both test for. A guard that invented a ceiling here would arm a
        // watchdog the user never configured.
        const p = workerPolicy('gate')
        expect(p.guards['command-timeout']).toBe(0)
        expect(p.guards['stream-stall']).toBe(0)
    })

    test('research ships the progress deadline ON and both A/B levers OFF', () => {
        const none = (): undefined => undefined
        expect(workerPolicy('research', {env: none})).toEqual({
            guards: {
                ...ADHOC.guards,
                'worker-timeout': {
                    timeoutMs: 240_000,
                    progressCeilingMs: DEFAULT_WORKER_PROGRESS_CEILING_MS,
                    fanout: null
                }
            },
            carryForward: false
        })
    })

    test('research: only a fanoutBounded worker can be handed a fan-out policy', () => {
        const env = (k: string): string | undefined =>
            k === FANOUT_TIMEOUT_PER_LOOKUP_ENV ? '400'
            : k === FANOUT_TIMEOUT_CEILING_ENV ? '900000'
            : undefined
        expect(workerPolicy('research', {env}).guards['worker-timeout'].fanout).toBeNull()
        expect(
            workerPolicy('research', {env, fanoutBounded: true}).guards['worker-timeout'].fanout
        ).toEqual({perLookupMs: 400, ceilingMs: 900_000})
    })

    test('research: each lever moves ITS OWN slot and nothing else', () => {
        const base = workerPolicy('research', {env: () => undefined})
        const carry = workerPolicy('research', {
            env: k => (k === WORKER_CARRY_FORWARD_ENV ? '1' : undefined)
        })
        expect(carry.carryForward).toBe(true)
        expect(carry.guards).toEqual(base.guards)

        const off = workerPolicy('research', {
            env: k => (k === WORKER_PROGRESS_CEILING_ENV ? 'off' : undefined)
        })
        expect(off.guards['worker-timeout'].progressCeilingMs).toBeNull()
        expect(off.carryForward).toBe(false)
        // Turning the deadline off must not also disable the cap it bounds.
        expect(off.guards['worker-timeout'].timeoutMs).toBe(240_000)
    })

    test('the two moved constants still hold the values the call sites assumed', () => {
        expect(RESEARCH_WORKER_TIMEOUT_MS).toBe(240_000)
        expect(STALL_AFTER_MS).toBe(180_000)
        expect(MAX_LOOP_RESTARTS).toBe(2)
        expect(DEFAULT_LOOP_DETECTOR).toEqual({window: 20, threshold: 5, pathThreshold: 5})
        expect(DEFAULT_LOOP_PROGRESS).toEqual({limit: 8, churnFactor: 2})
    })
})

describe('WORKER_PROFILES — the roster is the key', () => {
    test('every profile decides about every way a worker can die', () => {
        const ids = WORKER_KILLS.map(k => k.id).sort()
        for (const id of Object.keys(WORKER_PROFILES) as WorkerProfileId[]) {
            expect(Object.keys(workerPolicy(id).guards).sort()).toEqual(ids)
        }
    })

    test('the three causes with no dial say so, rather than being absent', () => {
        const g = workerPolicy('adhoc').guards
        expect(g['leaked-tool-call']).toBeNull()
        expect(g.aborted).toBeNull()
        expect(g.exit).toBeNull()
    })

    test('every profile carries prose saying why its guards differ', () => {
        for (const p of Object.values(WORKER_PROFILES)) {
            expect(p.why.length).toBeGreaterThan(120)
        }
    })

    test('a profile row cannot leave the roster: ids match the table keys', () => {
        expect(Object.keys(WORKER_PROFILES).sort()).toEqual(['adhoc', 'gate', 'research'])
        for (const [key, p] of Object.entries(WORKER_PROFILES)) expect<string>(p.id).toBe(key)
    })
})

describe('applyOverride — whole rows, tests only', () => {
    test('lays one row over the profile and leaves the rest alone', () => {
        const out = applyOverride(workerPolicy('adhoc'), {'command-timeout': 42})
        expect(out.guards['command-timeout']).toBe(42)
        // Diffed against the PROFILE, not the defaults literal: `adhoc` departs
        // from the defaults on the clock, and this test is about the override.
        expect({...out.guards, 'command-timeout': 0}).toEqual(workerPolicy('adhoc').guards)
    })

    test('carryForward overrides independently of the rows', () => {
        expect(applyOverride(workerPolicy('adhoc'), {carryForward: true}).carryForward).toBe(true)
        expect(applyOverride(workerPolicy('adhoc'), {'command-timeout': 1}).carryForward).toBe(
            false
        )
    })

    test('a present-but-undefined row is ignored, not laid down', () => {
        // `{'worker-timeout': cond ? {...} : undefined}` is how a harness writes
        // a swept arm. A plain spread would put `undefined` in the policy and
        // runWorker would throw on `clock.timeoutMs`.
        const out = applyOverride(workerPolicy('adhoc'), {
            'worker-timeout': undefined,
            'command-timeout': undefined
        })
        expect(out).toEqual(workerPolicy('adhoc'))
    })

    test('no override is the profile itself', () => {
        expect(applyOverride(workerPolicy('gate'), undefined)).toEqual(workerPolicy('gate'))
    })

    /**
     * THE DOOR STAYS SHUT. `override` is what lets a caller hand-pick a subset of
     * guards, which is the exact thing the profile table exists to stop; the
     * escape hatch would re-open it the moment a production call site used one.
     * Enforced rather than hoped for: this walks the real tree, not a list.
     */
    test('no production source file passes an `override` to runWorker', () => {
        const root = join(import.meta.dir, '..')
        const allowed = new Set([join(root, 'workers', 'worker-profiles.ts')])
        const offenders: string[] = []
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, {withFileTypes: true})) {
                const full = join(dir, e.name)
                if (e.isDirectory()) {
                    if (e.name !== 'test-utils' && e.name !== '__fixtures__') walk(full)
                    continue
                }
                if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue
                if (allowed.has(full)) continue
                const src = readFileSync(full, 'utf8')
                // Only files that BUILD a RunWorkerInput can pass one. Scanning
                // the whole tree would red the build on an unrelated property
                // that happens to be called `override`.
                if (!/RunWorkerInput|runWorker\(/.test(src)) continue
                if (/^\s*override:/m.test(src)) offenders.push(full)
            }
        }
        walk(root)
        expect(offenders).toEqual([])
    })

    /**
     * The other half of the same rule, and the only cover `pi-worker.ts` has:
     * it registers a tool rather than exposing a seam, so no harness can drive
     * its call site. A production caller that names no profile would not compile
     * — `profile` is required — but one that names the WRONG kind of thing, or a
     * fourth caller added without a profile row, is caught here.
     */
    /**
     * `adhoc` has no wall clock, so `stream-stall` is the ONLY thing bounding it.
     * A call site that names the profile and forgets the setting gets a worker
     * that can never be killed for going quiet — and `pi-worker.ts` registers a
     * tool rather than exposing a seam, so no harness can drive it. Breaking that
     * line by hand fails nothing without this test; it is the cover.
     */
    test('a production `adhoc` call site must pass the silence bound', () => {
        const root = join(import.meta.dir, '..')
        const offenders: string[] = []
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, {withFileTypes: true})) {
                const full = join(dir, e.name)
                if (e.isDirectory()) {
                    if (e.name !== 'test-utils' && e.name !== '__fixtures__') walk(full)
                    continue
                }
                if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue
                const src = readFileSync(full, 'utf8')
                if (!/^\s*profile: 'adhoc',?$/m.test(src)) continue
                if (!/streamInactivityMs/.test(src)) offenders.push(full)
            }
        }
        walk(root)
        expect(offenders).toEqual([])
    })

    test('every production runWorker call site names a profile', () => {
        const root = join(import.meta.dir, '..')
        const defs = new Set([
            join(root, 'workers', 'pi-worker-core.ts'),
            join(root, 'workers', 'worker-profiles.ts')
        ])
        const missing: string[] = []
        const walk = (dir: string): void => {
            for (const e of readdirSync(dir, {withFileTypes: true})) {
                const full = join(dir, e.name)
                if (e.isDirectory()) {
                    if (e.name !== 'test-utils' && e.name !== '__fixtures__') walk(full)
                    continue
                }
                if (!e.name.endsWith('.ts') || e.name.includes('.test.')) continue
                if (defs.has(full)) continue
                const src = readFileSync(full, 'utf8')
                // NOT `runWorker\(\{`: the research driver calls its seam as
                // `run.runWorker(spec.label, {...}`, so a literal-first pattern
                // silently exempts one of the three real call sites. This matches
                // a call with an object literal anywhere in its arguments, and
                // still skips `runWorker(input)` pass-through adapters.
                if (!/runWorker\([^)]{0,120}\{/.test(src)) continue
                if (!/^\s*profile: '(research|gate|adhoc)',?$/m.test(src)) missing.push(full)
            }
        }
        walk(root)
        expect(missing).toEqual([])
    })
})

describe('the resolved policy is what runWorker actually runs on', () => {
    /**
     * WHY THIS EXISTS. Asserting that a profile RESOLVES correctly proves nothing
     * about whether `runWorker` then READS it correctly — a rewiring that turns
     * "0 means off" into "0 means on" leaves every assertion above green. This
     * drives the REAL runWorker and checks the policy it reports, so the two
     * halves of the claim are joined.
     */
    const spawn = fakeSpawnByPrompt(() => agentEndResponse('ok'))

    test('onPolicy reports the gate policy, resolved from the gate call site inputs', async () => {
        // A box, not a bare `let`: TypeScript narrows a closure-assigned `let`
        // back to its initialiser at the read site (same reason `salvage` is one
        // in pi-worker-core.ts).
        const seen: {p: WorkerGuardPolicy | null} = {p: null}
        await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'gate',
            policyInputs: {commandTimeoutMs: 900_000, streamInactivityMs: 600_000},
            onPolicy: p => (seen.p = p)
        })
        expect(seen.p).toEqual(
            workerPolicy('gate', {commandTimeoutMs: 900_000, streamInactivityMs: 600_000})
        )
    })

    test('onPolicy reports the override, not the bare profile', async () => {
        const seen: {p: WorkerGuardPolicy | null} = {p: null}
        await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            override: {'worker-timeout': {timeoutMs: 7, progressCeilingMs: null, fanout: null}},
            onPolicy: p => (seen.p = p)
        })
        expect(seen.p?.guards['worker-timeout'].timeoutMs).toBe(7)
    })

    test('it fires ONCE, before the first attempt, not once per restart', async () => {
        const seen: WorkerGuardPolicy[] = []
        await runWorker({
            prompt: 'x',
            cwd: process.cwd(),
            spawn,
            profile: 'adhoc',
            onPolicy: p => seen.push(p)
        })
        expect(seen.length).toBe(1)
    })
})

describe('snapshotLeverEnv — one arm per research phase', () => {
    test('freezes every lever the module owns, so a mid-phase flip cannot half-apply', () => {
        const live: Record<string, string | undefined> = {[WORKER_CARRY_FORWARD_ENV]: '1'}
        const frozen = snapshotLeverEnv(k => live[k])
        expect(frozen(WORKER_CARRY_FORWARD_ENV)).toBe('1')
        live[WORKER_CARRY_FORWARD_ENV] = undefined
        live[WORKER_PROGRESS_CEILING_ENV] = 'off'
        expect(frozen(WORKER_CARRY_FORWARD_ENV)).toBe('1')
        expect(frozen(WORKER_PROGRESS_CEILING_ENV)).toBeUndefined()
    })

    /**
     * `RESEARCH_LEVER_ENVS`' own docstring claims it "cannot drift from the
     * levers". Nothing made that true: the test below asks the snapshot which
     * keys it reads, which is true by construction. A sixth lever read through
     * `inputs.env` would compile, pass every unit test (they inject their own
     * env fn), and be silently unset in production — strictly worse than the
     * live `process.env` read it replaced. This is what makes the claim true.
     */
    test('the list covers every lever constant the module declares', () => {
        const src = readFileSync(
            join(import.meta.dir, '..', 'task', 'research-fanout-budget.ts'),
            'utf8'
        )
        const declared = [...src.matchAll(/^export const \w*_ENV = '([^']+)'/gm)].map(m => m[1]!)
        expect(declared.length).toBeGreaterThan(0)
        expect([...declared].sort()).toEqual([...RESEARCH_LEVER_ENVS].sort())
    })

    test('covers every lever env var, so none is left reading live', () => {
        const asked: string[] = []
        snapshotLeverEnv(k => {
            asked.push(k)
            return undefined
        })
        expect(asked.sort()).toEqual([...RESEARCH_LEVER_ENVS].sort())
    })
})
