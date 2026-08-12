/**
 * The rule under test is one line long: an unmet precondition exits 2, never 1.
 *
 * It needs a test because it is invisible in practice — a harness that exits 1 on
 * a dead endpoint looks exactly like a harness that ran and refuted the lever, and
 * the only place the difference shows is a line of stderr nobody re-reads weeks
 * later when the number goes into VALIDATION-DEBT.md.
 */
import {describe, expect, test} from 'bun:test'
import {EXIT_CODE} from './ab-verdict.js'
import {requirePreconditions, abstainMidRun, type PreflightDeps} from './ab-preflight.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'

class Exited extends Error {
    constructor(readonly code: number) {
        super(`exit ${code}`)
    }
}

/** Captures the exit code and the lines, instead of killing the test runner. */
function harness(
    over: Partial<PreflightDeps> & {alive?: boolean; body?: string} = {}
): {deps: PreflightDeps; lines: string[]} {
    const lines: string[] = []
    const alive = over.alive ?? true
    return {
        lines,
        deps: {
            env: over.env ?? {PI_BIN: '/usr/bin/pi'},
            fileExists: over.fileExists ?? (() => true),
            log: l => lines.push(l),
            exit: (code: number) => {
                throw new Exited(code)
            },
            fetch:
                over.fetch
                ?? (async () => {
                    if (!alive) throw new Error('ECONNREFUSED')
                    return {ok: true, text: async () => over.body ?? 'ok'}
                })
        }
    }
}

async function codeOf(fn: () => Promise<unknown>): Promise<number> {
    try {
        await fn()
        return 0
    } catch (e) {
        if (e instanceof Exited) return e.code
        throw e
    }
}

describe('an unmet precondition abstains — the whole reason this module exists', () => {
    test('a dead model endpoint is exit 2, not exit 1', async () => {
        const h = harness({alive: false})
        expect(await codeOf(() => requirePreconditions('t', {model: {}}, h.deps))).toBe(
            EXIT_CODE.ABSTAIN
        )
        expect(await codeOf(() => requirePreconditions('t', {model: {}}, h.deps))).not.toBe(
            EXIT_CODE.FAIL
        )
    })

    test('an endpoint answering non-2xx is down, not up', async () => {
        const h = harness({fetch: async () => ({ok: false, text: async () => ''})})
        expect(await codeOf(() => requirePreconditions('t', {model: {}}, h.deps))).toBe(
            EXIT_CODE.ABSTAIN
        )
    })

    test('an unset PI_BIN abstains — the fork-bomb guard', async () => {
        const h = harness({env: {}})
        expect(await codeOf(() => requirePreconditions('t', {piBin: true}, h.deps))).toBe(
            EXIT_CODE.ABSTAIN
        )
        expect(h.lines.join('\n')).toContain('PI_BIN')
    })

    test('a whitespace-only PI_BIN is unset', async () => {
        const h = harness({env: {PI_BIN: '   '}})
        expect(await codeOf(() => requirePreconditions('t', {piBin: true}, h.deps))).toBe(
            EXIT_CODE.ABSTAIN
        )
    })

    test('a set research-cache id abstains — the arm would measure a cache', async () => {
        const h = harness({env: {PI_BIN: '/usr/bin/pi', [RESEARCH_RUN_ID_ENV]: 'run-7'}})
        expect(await codeOf(() => requirePreconditions('t', {cacheOff: true}, h.deps))).toBe(
            EXIT_CODE.ABSTAIN
        )
        expect(h.lines.join('\n')).toContain(RESEARCH_RUN_ID_ENV)
    })

    test('a missing corpus abstains', async () => {
        const h = harness({fileExists: p => p !== '/hub/mx5'})
        expect(
            await codeOf(() => requirePreconditions('t', {corpora: ['/hub/mx5']}, h.deps))
        ).toBe(EXIT_CODE.ABSTAIN)
        expect(h.lines.join('\n')).toContain('/hub/mx5')
    })

    test('the abstain banner says it is not a failure, in those words', async () => {
        const h = harness({alive: false})
        await codeOf(() => requirePreconditions('my-harness', {model: {}}, h.deps))
        const text = h.lines.join('\n')
        expect(text).toContain('ABSTAIN — THIS RUN PROVED NOTHING')
        expect(text).toContain('exit 2, NOT exit 1')
        expect(text).toContain('my-harness')
    })

    test('every unmet precondition is reported, not just the first', async () => {
        const h = harness({alive: false, env: {}, fileExists: () => false})
        await codeOf(() =>
            requirePreconditions(
                't',
                {model: {}, piBin: true, cacheOff: true, corpora: ['/a', '/b']},
                h.deps
            )
        )
        const text = h.lines.join('\n')
        expect(text).toContain('PI_BIN')
        expect(text).toContain('/a')
        expect(text).toContain('/b')
        expect(text).toContain('did not answer')
    })
})

describe('a met precondition set returns a watch and does not exit', () => {
    test('all preconditions satisfied', async () => {
        const h = harness()
        const r = await requirePreconditions(
            't',
            {model: {}, piBin: true, cacheOff: true, corpora: ['/hub/mx5']},
            h.deps
        )
        expect(r.watch).toBeDefined()
        expect(h.lines).toEqual([])
    })

    test('an omitted model check does not probe at all', async () => {
        let probes = 0
        const h = harness({
            fetch: async () => {
                probes++
                return {ok: true, text: async () => 'ok'}
            }
        })
        await requirePreconditions('t', {piBin: true}, h.deps)
        expect(probes).toBe(0)
    })
})

describe('ModelWatch — the mid-arm check that existed in 1 of 51 harnesses', () => {
    test('stillAlive goes false when the endpoint goes away', async () => {
        let up = true
        const h = harness({
            fetch: async () => {
                if (!up) throw new Error('ECONNREFUSED')
                return {ok: true, text: async () => 'v1'}
            }
        })
        const {watch} = await requirePreconditions('t', {model: {}}, h.deps)
        expect(await watch.stillAlive()).toBe(true)
        up = false
        expect(await watch.stillAlive()).toBe(false)
    })

    test('unchanged goes false when the model restarts under the run', async () => {
        let body = 'model-a'
        const h = harness({fetch: async () => ({ok: true, text: async () => body})})
        const {watch, fingerprint} = await requirePreconditions('t', {model: {}}, h.deps)
        expect(fingerprint).toBe('model-a')
        expect(await watch.unchanged()).toBe(true)
        body = 'model-b'
        expect(await watch.unchanged()).toBe(false)
    })

    test('a restart that also killed the endpoint is not "unchanged"', async () => {
        let up = true
        const h = harness({
            fetch: async () => {
                if (!up) throw new Error('down')
                return {ok: true, text: async () => 'v1'}
            }
        })
        const {watch} = await requirePreconditions('t', {model: {}}, h.deps)
        up = false
        expect(await watch.unchanged()).toBe(false)
    })

    test('an endpoint publishing nothing stable is not reported as restarting', async () => {
        // A false MODELRESTART on every tick would be worse than no check: the arm
        // would abstain constantly and the check would get deleted.
        const h = harness({body: ''})
        const {watch} = await requirePreconditions('t', {model: {}}, h.deps)
        expect(await watch.unchanged()).toBe(true)
    })
})

describe('abstainMidRun', () => {
    test('is the same verdict and the same exit code as a failed precondition', async () => {
        const h = harness()
        expect(
            await codeOf(async () => abstainMidRun('t', 'the model restarted at rep 12', h.deps))
        ).toBe(EXIT_CODE.ABSTAIN)
        expect(h.lines.join('\n')).toContain('restarted at rep 12')
        expect(h.lines.join('\n')).toContain('exit 2, NOT exit 1')
    })
})
