/**
 * Two wirings that compile either way, so no seam can observe them: an optional
 * argument left off a call still type-checks and still returns the right value —
 * only the cancel and the progress hook silently go missing. Both are therefore
 * asserted against the source text of the call site itself.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import {srcPath} from '../test-utils/src-tree.js'

const src = (f: string): string => fs.readFileSync(srcPath('task', f), 'utf8')

/** The text of one call, from `name(` to its matching close paren. */
function callSites(source: string, name: string): string[] {
    const out: string[] = []
    const needle = `${name}(`
    for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
        let depth = 0
        let j = i + needle.length - 1
        for (; j < source.length; j++) {
            if (source[j] === '(') depth++
            else if (source[j] === ')' && --depth === 0) break
        }
        out.push(source.slice(i, j + 1))
    }
    return out
}

describe("the gate's cancel reaches the gate", () => {
    // `FinalGateOptions.signal` is optional, and it is what carries the run's
    // cancel into repo-health, the lockfile/integration/launch sections and the
    // ACCEPT-debt re-runs. A production caller that omits it leaves that whole
    // path inert, and nothing about the gate's return value says so.
    for (const file of ['gate-deps.ts', 'auto-orchestrator.ts']) {
        test(`every runFinalIntegrationGate call in ${file} passes a signal`, () => {
            const sites = callSites(src(file), 'runFinalIntegrationGate')
            expect(sites.length).toBeGreaterThan(0)
            for (const site of sites) expect(site).toContain('signal')
        })
    }

    test('the post-autofix debt recompute passes one too', () => {
        // Same cancel, same reason: `recheckOpenDebts` wires `deriveOpenDebts`,
        // which re-runs every ACCEPT-debt VERIFY command against the final tree
        // under DEBT_RERUN_TIMEOUT_MS.
        for (const site of callSites(src('auto-orchestrator.ts'), 'deriveOpenDebts')) {
            expect(site).toContain('signal')
        }
    })
})

describe('the dead-air A/B arms differ', () => {
    test('the baseline arm no longer runs repo-health a second way', () => {
        // `runRepoHealthCheck` carries `signal` and `onCommand` in its options bag,
        // both optional. A bare `runRepoHealthCheck(cwd2)` therefore compiles and
        // returns a real verdict while the run's cancel and the loader's command
        // name are both dropped, so no path may call it that way.
        expect(src('gate-deps.ts')).not.toMatch(/runRepoHealthCheck\(\s*cwd2\s*\)/)
    })
})
