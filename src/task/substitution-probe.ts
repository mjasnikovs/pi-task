/**
 * substitution-probe — deterministic detection of SELF-VERIFIED work, feeding the
 * verify gate's prompt.
 *
 * The failure class: an implementation that hits a real bug in the shipped app
 * can ship "integration tests" that re-implement the API inline instead — a test
 * file that stands up its own server, or imports the real app and never calls it.
 * The suite then runs green while every route of the real server fails, and a
 * verify child that asks "do the tests pass" sees green and PASSes.
 *
 * The prompt rule alone is weak against that, because the child has to notice the
 * substitution unprompted. This probe hands it a concrete finding naming the
 * suspect file, so the rule fires on a line rather than on self-discovery.
 *
 * WHAT THE PROBE ASSERTS is deliberately the class INVARIANT, not any framework
 * shape: when a task's own diff includes the very tests whose green result would
 * bless it, the work is grading itself — so the verify child must independently
 * confirm those tests exercise the real shipped artifact before trusting them.
 * That is computable from pure git diff shape (which changed files live in test
 * paths, and how many lines the task added there): no language parsing, no server-
 * constructor lists, no import syntax — a Python, Go, or Rust project produces the
 * same finding the same way.
 *
 * A behavioural canary — re-run the suite with the shipped sources removed, and
 * treat still-green as proof of a copy — does NOT work here: a substituted test
 * usually still imports SOMETHING real (a db module, a type), so poisoning the
 * sources breaks it too and the canary never convicts.
 *
 * Findings are advisory: they mandate the spot-check, they never auto-FAIL. An
 * honest self-authored test survives that spot-check; only one that bypasses the
 * artifact gets named in a FAIL.
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
