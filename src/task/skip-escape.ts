/**
 * Deterministic skip-escape scanner for authored VERIFY blocks.
 *
 * A skip-escape is a `||` fallback that lets a REQUIRED check pass SILENTLY when
 * its tool is absent or it fails — e.g. `playwright test … || echo "skipping"`.
 * A spec whose only behavioural check is wrapped that way passes its gate on a
 * machine without the tool, and the verify child reads it as "correctly skipped".
 *
 * Flagging every `|| true` would be almost all false positives: teardown
 * (`kill … || true`, `docker compose down … || true`), setup (`… install
 * … || true`) and negative tests (`… && exit 1 || true`, where `|| true` catches
 * an EXPECTED failure) are all legitimate, and a static scan cannot tell a
 * required-check `|| true` from a teardown one. The crisp signal is narrower: a
 * fallback whose TEXT admits it is dodging the check. Bare `|| true` is left to
 * the verify child's runtime rule 5c, which can observe whether the check ran.
 *
 * Pure shell-shape / text analysis; no stack or tool-name assumptions.
 */
import {parseVerifyBlock} from './spec-validation.js'

export interface SkipEscapeFinding {
    /** The offending VERIFY command line, verbatim. */
    line: string
    /** Why it is a skip-escape (human- and prompt-readable). */
    reason: string
}

/**
 * A `||` (optionally after a `2>/dev/null`) whose fallback text ADMITS it is
 * skipping / that a tool is unavailable. Anchored on the fallback wording, so it
 * fires on `|| echo "skipping"`, `|| { echo "playwright not installed"; }`,
 * `|| echo "runner unavailable — skipped"`, and misses benign teardown `|| true`.
 */
const SKIP_ANNOUNCE_RE =
    /\|\|[^|]*\b(skip|skipping|skipped|not\s+installed|not\s+available|unavailable)\b/i

/**
 * Scan a composed spec's VERIFY block for skip-announcing escapes. Returns one
 * finding per offending command line; empty when the spec has no VERIFY block or
 * no skip-escapes. Comment/blank lines are already dropped by parseVerifyBlock.
 */
export function findSkipEscapes(spec: string): SkipEscapeFinding[] {
    const cmds = parseVerifyBlock(spec)
    if (!cmds) return []
    const found: SkipEscapeFinding[] = []
    for (const {raw} of cmds) {
        if (SKIP_ANNOUNCE_RE.test(raw)) {
            found.push({
                line: raw,
                reason:
                    'its `||` fallback announces skipping the check when a tool is absent — a '
                    + 'required check must run unconditionally, not self-waive into a silent pass'
            })
        }
    }
    return found
}

/**
 * Render skip-escape findings as a defect block for the critique rewrite: a
 * numbered instruction list the rewrite must resolve (remove the escape / run the
 * check unconditionally, or drop the check if it is genuinely not required).
 */
export function skipEscapeDefectText(findings: SkipEscapeFinding[]): string {
    return [
        'SKIP-ESCAPE in the VERIFY block — a required check is wrapped so that a missing',
        'tool or a failure passes SILENTLY (run-8 F2: the only smoke tests shipped this',
        'way, skipped unnoticed, and a blank app was blessed). Rewrite the VERIFY block so',
        'each of these checks RUNS UNCONDITIONALLY and its failure fails the block — remove',
        'the `|| echo skipping`-style fallback. PREFER a check that needs no special tool at',
        'all (start the artifact and probe its real behavior directly). Do NOT merely reshape',
        'the escape into a `command -v X`/`if`-guard that still skips silently when the tool',
        'is absent — that is the same defect: if the check truly needs a tool, its absence',
        'must make the block EXIT NON-ZERO (surface it), never exit 0. If a check genuinely',
        'cannot be required here, remove it entirely rather than leaving a self-waiving stub:',
        ...findings.map((f, i) => `  ${i + 1}. ${f.line}`)
    ].join('\n')
}

/**
 * Render skip-escape findings as verify-child prompt lines (the deterministic
 * finding that makes rule 5c fire reliably — the model does not self-discover a
 * graceful skip-escape, but acts on a finding that names the exact line). Empty
 * findings → empty array (caller emits no block).
 */
export function skipEscapeVerifyFindings(findings: SkipEscapeFinding[]): string[] {
    return findings.map(f => `${f.line} — ${f.reason}`)
}
