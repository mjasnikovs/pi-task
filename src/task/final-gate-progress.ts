/**
 * final-gate-progress — the non-progress classifier for the final-gate autofix
 * loop. `AutofixLedger.judge` is its only caller.
 *
 * The rule: an attempt that CHANGED the tree and re-ran the gate, and got the
 * same ranked-first failure back as the previous attempt, is evidence about the
 * CHECK, not about the fix. A check that survives two post-fix results
 * identically is unfalsifiable in this environment, so stop paying for it —
 * demote that ONE check to UNOBSERVED-with-debt and let the remaining checks
 * decide whether the gate converged. The debt is appended to the ledger file
 * under `.pi-tasks/`, so it outlives the run and the next gate re-checks it.
 *
 * Deliberately conservative:
 *   - It never fires on attempt 1: `previousSignature` is null until an attempt
 *     has produced one, and null returns false.
 *   - It never fires when the attempt changed nothing. The caller passes
 *     `edited` as "the gate re-ran AND the tree is dirty", and a guard-rejected
 *     attempt returns before the re-run, so its `gate` is undefined.
 *   - It demotes exactly the one repeated signature. Every other failure still
 *     has to pass for real.
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
 * NOT applied when the colon follows a SOURCE LOCATION. A failure detail embeds
 * the failing command's output tail verbatim (final-gate.ts interpolates
 * `r.tail`), and tsc/eslint/bun-test tails are mostly `file:line`. Collapsing
 * those would make two DIFFERENT defects in one file compare equal, which reads
 * as non-progress and demotes a genuinely fixable check. A moved error is
 * progress.
 *
 * The exemption covers the FILE:LINE colon only. Measured: `src/db.ts:41` and
 * `src/db.ts:88` keep their line numbers and stay different, but the COLUMN in
 * `Cart.tsx:88:12` normalises to `cart.tsx:88:<port>` — the prefix at that colon
 * is the bare `88`, which is neither a path nor a filename. Two defects that
 * differ only in column therefore compare equal.
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
    /**
     * Did a PROBE return this failure after OBSERVING? Read off
     * `FinalGateOutcome.observedFailures` by exact text identity — never re-derived
     * from the failure string.
     *
     * True ⇒ never non-progress. See the guard in `isNonProgress` for why.
     */
    observed?: boolean
}

/**
 * True when this attempt is evidence that the ranked-first check is unfalsifiable
 * here: it edited the tree, the gate re-ran, and returned the same first failure
 * as the previous attempt.
 *
 * …EXCEPT when a probe OBSERVED the failure, which is checked FIRST and wins
 * outright. A probe that looked and saw the defect has already answered the
 * question this rule guesses at, and it answered it where the evidence is. A
 * probe that could NOT look reports that as its own outcome instead, so it never
 * reaches `observedFailures`.
 *
 * The observed guard has to win, because a deterministic un-fixed defect emits an
 * IDENTICAL failure by definition. Without it, string equality reads
 * reproducibility as evidence against the instrument — a CLI that exits 2 twice,
 * a build that fails on the same symbol twice — and demotes a real, still-broken
 * check to debt.
 */
export function isNonProgress(input: NonProgressInput): boolean {
    if (input.observed === true) return false
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

/** The debt reason recorded for a demoted check. One function so the ledger entry
 *  and the wording the user reads cannot drift apart. */
export function unobservedDebtReason(detail: string): string {
    return (
        `final gate check UNOBSERVED — ${detail.trim().slice(0, 200)} — `
        + 'repeated identically across two fix attempts that both changed the tree and '
        + 're-ran the gate; treated as unfalsifiable in this environment and carried as '
        + 'debt (re-checked by the next run’s gate), not as a proven defect'
    )
}
