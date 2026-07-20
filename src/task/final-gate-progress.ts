/**
 * final-gate-progress — the non-progress classifier for the final-gate autofix loop.
 *
 * The failure this closes (mx5 run 14, validated from TASK_AUTO_0001.md's gates
 * trail): the gate's boot check asserted "the app never opened a listening socket"
 * in a sandbox where NO tool the probe knows (`ss`, `lsof`) exists — the check was
 * UNFALSIFIABLE there. Three autofix attempts each edited real files, re-ran, and
 * came back with a byte-identical ranked-first failure; the budget was spent on a
 * check no edit could ever move, the two checks that WERE fixable had converged by
 * attempt 2, and the run ended `failed` with 13 genuinely repaired files sitting
 * uncommitted in the working tree.
 *
 * The rule this encodes: an attempt that CHANGED the tree and re-ran the gate, and
 * got the same first failure back as the previous attempt, is evidence about the
 * CHECK, not about the fix. Two identical post-fix results ⇒ the check is
 * env-shaped/unfalsifiable in this environment ⇒ stop paying for it: demote that
 * one check to UNOBSERVED-with-debt (durable, so the NEXT run's gate re-checks it)
 * and let the REMAINING checks decide whether the gate converged. Run 14 replay:
 * checks 2 and 3 were fixed by attempts 1–2, so the run converges with the boot
 * check carried as debt instead of failing with the repairs stranded.
 *
 * Deliberately conservative:
 *   - It never fires on attempt 1. The first repeat can be an ordinary
 *     didn't-fix-it-yet; only a SECOND identical post-fix result is evidence.
 *   - It never fires when the attempt changed nothing (a BLOCKED child, a
 *     guard-discarded attempt): with no edit there is nothing to conclude about
 *     falsifiability.
 *   - It demotes exactly the one repeated check. Every other failure still has to
 *     pass for real; the debt keeps the demoted one visible at run end and in the
 *     next run's gate.
 */

/**
 * Volatile substrings that differ between two runs of the SAME failing check —
 * ports, timings, pids, temp paths, timestamps, hex ids. They must be erased
 * before comparing, or the classifier never fires on a real repeat (a boot probe
 * that prints the port it tried, a test runner that prints elapsed ms).
 *
 * Ordinary integers are NOT collapsed: "3 tests failed" → "1 test failed" is real
 * progress and must stay visible as a difference.
 */
const VOLATILE: Array<[RegExp, string]> = [
    // ISO-ish timestamps, then clock times.
    [/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, '<ts>'],
    [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
    // Temp dirs (posix + macOS + windows) up to the next whitespace/quote.
    [/(?:\/tmp|\/private\/var\/folders|\/var\/folders)\/[^\s'"`)]+/g, '<tmp>'],
    [/[a-z]:\\+(?:users\\+[^\s'"`)\\]+\\+)?appdata\\+local\\+temp\\+[^\s'"`)]+/g, '<tmp>'],
    // Durations with a unit.
    [/\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns|s|m|h|sec|secs|seconds?|minutes?|hours?)\b/g, '<dur>'],
    // pids, addresses and ports (address first — it subsumes the port form).
    [/\bpids?\s*[:=]?\s*\d+/g, '<pid>'],
    [/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):\d+/g, '<addr>'],
    [/\bport\s*[:=]?\s*\d{2,5}\b/g, '<port>'],
    // Long hex / uuid-ish ids (sha, container id, request id).
    [/\b0x[0-9a-f]+\b/g, '<hex>'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>'],
    [/\b[0-9a-f]{7,40}\b/g, '<hex>']
]

/**
 * A bare `:NNNN` port, which the localhost/`port N` rules above do not reach (a
 * failure that just says "no listener on :3000").
 *
 * NOT applied when the colon follows a SOURCE LOCATION — `src/db.ts:41`,
 * `Cart.tsx:88:12`. A failure detail embeds the failing command's output tail
 * verbatim (final-gate.ts `r.tail`), and tsc/eslint/bun-test tails are mostly
 * file:line. Collapsing those made two DIFFERENT defects in one file — the second
 * uncovered by fixing the first — compare equal, which reads as non-progress and
 * demotes a genuinely fixable check to UNOBSERVED debt. A moved error is progress.
 */
const BARE_PORT = /(\S*?):(\d{2,5})\b/g
/** A path (has a separator) or a filename with an extension ⇒ a source location. */
const SOURCE_LOCATION = /[/\\]|\.[a-z][a-z0-9]{0,4}$/

function collapseBarePorts(s: string): string {
    return s.replace(BARE_PORT, (whole, prefix: string) =>
        SOURCE_LOCATION.test(prefix) ? whole : `${prefix}:<port>`
    )
}

/**
 * Comparison key for a gate failure entry: lowercased, volatile substrings erased,
 * whitespace collapsed. Two entries with the same key are "the same failure" for
 * non-progress purposes.
 */
export function normalizeFailureDetail(detail: string): string {
    let s = detail.toLowerCase()
    for (const [re, repl] of VOLATILE) s = s.replace(re, repl)
    s = collapseBarePorts(s)
    return s.replace(/\s+/g, ' ').trim()
}

/** The ranked-first failure of a gate outcome (the list is ranked most load-bearing
 *  first; a wiring without a list degrades to the single reason). */
export function rankedFirstFailure(outcome: {reason?: string; failures?: string[]}): string | null {
    const first = outcome.failures?.[0] ?? outcome.reason
    const t = first?.trim()
    return t && t.length > 0 ? t : null
}

export interface NonProgressInput {
    /** Normalized ranked-first failure of the PREVIOUS attempt's gate re-run
     *  (null before any attempt has produced one — the classifier cannot fire). */
    previousSignature: string | null
    /** This attempt's ranked-first failure, raw. */
    currentDetail: string | null
    /** Did this attempt actually change the tree AND survive the guards? Only an
     *  attempt that edited and re-tested says anything about falsifiability. */
    edited: boolean
}

/**
 * True when this attempt is evidence that the ranked-first check is unfalsifiable
 * here: it edited the tree, the gate re-ran, and returned the same first failure
 * as the previous attempt.
 */
export function isNonProgress(input: NonProgressInput): boolean {
    if (!input.edited) return false
    if (input.previousSignature === null || input.currentDetail === null) return false
    return normalizeFailureDetail(input.currentDetail) === input.previousSignature
}

/**
 * Drop every failure entry matching an already-demoted signature. What survives is
 * what still has to pass for the gate to converge; empty ⇒ converged-with-debt.
 */
export function applyDemotions(failures: string[], demoted: ReadonlySet<string>): string[] {
    if (demoted.size === 0) return [...failures]
    return failures.filter(f => !demoted.has(normalizeFailureDetail(f)))
}

/** The debt reason recorded for a demoted check, and the gate-trail wording. Kept
 *  in one place so the ledger line and the trail line cannot drift apart. */
export function unobservedDebtReason(detail: string): string {
    return (
        `final gate check UNOBSERVED — ${detail.trim().slice(0, 200)} — `
        + 'repeated identically across two fix attempts that both changed the tree and '
        + 're-ran the gate; treated as unfalsifiable in this environment and carried as '
        + 'debt (re-checked by the next run’s gate), not as a proven defect'
    )
}
