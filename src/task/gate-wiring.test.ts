/**
 * REGRESSION — two wirings that compile, read as done, and are not.
 *
 * Both are structural: nothing observable at a seam tells them apart from the
 * correct wiring, because the defect IS the argument that was never passed. So
 * they are asserted against the source, in the one place a reader would look.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const src = (f: string): string => fs.readFileSync(path.join(import.meta.dir, f), 'utf8')

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
    // `FinalGateOptions.signal` was added so a cancel can reach repo-health, the
    // lockfile/integration/launch sections and every ACCEPT-debt re-run — the
    // whole reason `CommandRunner` became async. If no production caller supplies
    // it, that plumbing is inert and the documented behaviour does not hold.
    for (const file of ['gate-deps.ts', 'auto-orchestrator.ts']) {
        test(`every runFinalIntegrationGate call in ${file} passes a signal`, () => {
            const sites = callSites(src(file), 'runFinalIntegrationGate')
            expect(sites.length).toBeGreaterThan(0)
            for (const site of sites) expect(site).toContain('signal')
        })
    }

    test('the post-autofix debt recompute passes one too', () => {
        // Same section, same cancel: `recheckOpenDebts` re-runs every ACCEPT-debt
        // VERIFY command against the final tree, each under a 300s cap.
        for (const site of callSites(src('auto-orchestrator.ts'), 'deriveOpenDebts')) {
            expect(site).toContain('signal')
        }
    })
})

describe('the dead-air A/B arms differ', () => {
    test('the baseline arm no longer runs repo-health a second way', () => {
        // The arm was `Promise.resolve(runRepoHealthCheck(cwd2))` because
        // `runRepoHealthCheck` was SYNCHRONOUS and blocked the event loop — that
        // block was the thing being measured. It is async now, so both arms are
        // non-blocking and `scripts/verify-deadair-ab.ts` compares treatment
        // against treatment. Worse, the baseline branch drops the signal and the
        // progress hook, so `DEADAIR_AB_ARM=baseline` silently makes repo-health
        // uncancellable and mute.
        expect(src('gate-deps.ts')).not.toMatch(/runRepoHealthCheck\(\s*cwd2\s*\)/)
    })
})
