import {describe, expect, test} from 'bun:test'
import {findSkipEscapes, skipEscapeDefectText, skipEscapeVerifyFindings} from './skip-escape.js'

/** Wrap raw command lines in a minimal spec with a fenced VERIFY block. */
function spec(...verifyLines: string[]): string {
    return ['GOAL', 'x', '', 'VERIFY:', '```sh', ...verifyLines, '```'].join('\n')
}

describe('findSkipEscapes', () => {
    test('flags the real run-8 F2 skip-escape (announced skip)', () => {
        const f = findSkipEscapes(
            spec(
                'npx playwright test --project=chromium listing.spec.ts 2>/dev/null || { echo "Playwright not available — skipping browser smoke test"; }'
            )
        )
        expect(f).toHaveLength(1)
        expect(f[0].line).toContain('playwright test')
        expect(f[0].reason).toContain('required check must run unconditionally')
    })

    test('flags common skip-announce shapes', () => {
        for (const line of [
            'uismoke smoke.spec.js || echo "skipping browser smoke (uismoke not installed)"',
            'run-e2e || echo "e2e runner unavailable, skipped"',
            'check-render || { echo "renderer not installed"; }',
            'assert-ui 2>/dev/null || echo "ui harness missing — skipping"'
        ]) {
            expect(findSkipEscapes(spec(line))).toHaveLength(1)
        }
    })

    test('does NOT flag benign teardown / setup / negative-test uses of || true (FP guard)', () => {
        // Every one of these is a real historical VERIFY line from ~/hub/mx5/.pi-tasks;
        // a blanket `|| true` flag false-positived on all of them. The scanner keys on
        // the skip-ANNOUNCING fallback text, so none of these fire.
        for (const line of [
            'kill $SERVER_PID 2>/dev/null || true',
            'wait "$SERVER_PID" 2>/dev/null || true',
            'docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true',
            'docker compose -f "$COMPOSE_FILE" up --detach 2>/dev/null || true',
            'npx playwright install chromium 2>/dev/null || true',
            '(unset ADMIN_PHONE; bun run seed 2>/dev/null) && echo "ERROR: seed should have failed" >&2 && exit 1 || true',
            ') || true'
        ]) {
            expect(findSkipEscapes(spec(line))).toHaveLength(0)
        }
    })

    test('does NOT flag a && echo PASS || echo FAIL reporting idiom (no skip wording)', () => {
        // The `|| echo "FAIL: …"` idiom swallows the exit code but does not announce a
        // SKIP; it is a different (reporting) pattern the runtime rule 5c/negative-control
        // handles, and flagging it here would be noise. No "skip" wording ⇒ no finding.
        expect(
            findSkipEscapes(
                spec('grep -q needle out.txt && echo "All present" || echo "FAIL: missing"')
            )
        ).toHaveLength(0)
    })

    test('no VERIFY block → no findings', () => {
        expect(findSkipEscapes('GOAL\nx\nACCEPTANCE\n- y')).toHaveLength(0)
    })

    test('multiple offending lines each yield a finding', () => {
        const f = findSkipEscapes(
            spec(
                'a-smoke || echo "skipping a"',
                'kill $PID || true',
                'b-smoke || echo "b unavailable"'
            )
        )
        expect(f).toHaveLength(2)
    })
})

describe('skipEscapeDefectText / skipEscapeVerifyFindings', () => {
    test('defect text lists each offending line as a numbered rewrite instruction', () => {
        const f = findSkipEscapes(spec('smoke || echo "skipping (tool missing)"'))
        const t = skipEscapeDefectText(f)
        expect(t).toContain('SKIP-ESCAPE in the VERIFY block')
        expect(t).toContain('RUNS UNCONDITIONALLY')
        // discourage the observed `command -v`/if-guard reshape (still a silent skip)
        expect(t).toContain('command -v X')
        expect(t).toContain('EXIT NON-ZERO')
        expect(t).toContain('1. smoke || echo "skipping (tool missing)"')
    })

    test('verify findings render one line per offending command', () => {
        const f = findSkipEscapes(spec('smoke || echo "skipping (tool missing)"'))
        const lines = skipEscapeVerifyFindings(f)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toContain('smoke || echo')
        expect(lines[0]).toContain('required check must run unconditionally')
        expect(skipEscapeVerifyFindings([])).toEqual([])
    })
})
