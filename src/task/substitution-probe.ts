/**
 * substitution-probe — deterministic detection of SELF-VERIFIED work, feeding the
 * verify gate's prompt.
 *
 * The failure class: the implementation hit a real bug
 * in the shipped app ("Context is not finalized" from a mis-signatured middleware),
 * blamed the framework, and shipped "integration tests" that re-implement the API
 * inline — an own server intercepting protected routes, and a 943-line hand-rolled
 * duplicate in a test-support file that imports the real app and never calls it.
 * The suite runs green while every protected route of the real server 500s.
 * The verify child judged "do the tests pass", saw green, and PASSed.
 *
 * A/B on the live local model proved the
 * fix must be a DETERMINISTIC, CONCRETE finding in the prompt, not prompt language
 * alone: the bare substitution rule catches it less than half the time — the
 * verdicts it does reach are right, the attention is not there. The rule PLUS a
 * probe finding naming the suspect file catches it every time, each verdict naming
 * the exact inline handlers and confirming the real app crashes.
 *
 * WHAT THE PROBE ASSERTS is deliberately the class INVARIANT, not any framework
 * shape: when a task's own diff includes the very tests whose green result would
 * bless it, the work is grading itself — so the verify child must independently
 * confirm those tests exercise the real shipped artifact before trusting them.
 * That is computable from pure git diff shape (which changed files live in test
 * paths, and how many lines the task added there): no language parsing, no server-
 * constructor lists, no import syntax — a Python, Go, or Rust project produces the
 * same finding the same way. (An earlier draft pattern-matched JS server
 * constructors; that only re-encoded the one incident. A behavioral canary — rerun
 * the suite with shipped sources removed, still-green ⇒ copy — was also rejected:
 * the real copy still imported the shipped db module, so poisoning sources
 * breaks the copy's tests too and the conviction never fires.)
 *
 * Findings are advisory: they mandate the spot-check, they never auto-FAIL. Honest
 * self-authored tests survive the spot-check (control fixtures PASS with the
 * mandate present); only tests that bypass the artifact get named in a FAIL.
 */

/** One changed file as the git-shape collector reports it. */
export interface ChangedFile {
    /** Path relative to the repo root (used verbatim in the finding text). */
    path: string
    /** Lines the task's diff ADDED to this file (0 for pure deletions). */
    addedLines: number
}

/** Is this a file whose job is testing — by suffix or by living in a test dir? */
export function isTestFile(p: string): boolean {
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) return true
    if (/(^|[._-])(test|spec)s?\.[a-z]+$/.test(p)) return true // test_x.py, x_test.go, x.spec.rb
    if (/(^|\/)test_[^/]+$/.test(p)) return true
    return /(^|\/)(test|tests|__tests__|spec|specs)\//.test(p)
}

/**
 * Analyse the task's changed files and return self-verification findings — one
 * human-readable line per test file the task itself authored or changed, ready to
 * inject into the verify prompt. Empty array → the task ships no tests of its own,
 * the prompt gets no probe block.
 */
export function findSubstitutionSuspects(files: ChangedFile[]): string[] {
    const findings: string[] = []
    for (const f of files) {
        if (!isTestFile(f.path)) continue
        if (f.addedLines <= 0) continue
        findings.push(
            `${f.path} (+${f.addedLines} lines) — a test file this task authored or changed itself; `
                + 'its green result blesses the very work that wrote it'
        )
    }
    return findings
}
