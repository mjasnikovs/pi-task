/**
 * script-escape — deterministic detection of CHECK SCRIPTS THAT CANNOT FAIL.
 *
 * The failure this closes (mx5 run 13, PROMPT 4 item 4): the shipped package.json
 * declared, verbatim,
 *     "lint": "prettier … && eslint --fix … && (tsc --noEmit 2>&1 | grep -qv 'TS18003' || true)"
 * The typecheck is neutered twice over — its output is piped into an INVERTED grep
 * (so the status becomes "some line did not match", never tsc's verdict), and the
 * whole group is closed with `|| true` (so the script exits 0 unconditionally). Every
 * consumer of that script — the repo-health verify gate, the final integration gate,
 * a human reading a green CI line — is reading a constant, not a measurement.
 *
 * It was harmless in run 13 only by luck: tsc happened to be clean (validated). The
 * class is not harmless — this is the same defect as run-8's F2 skip-escape, moved
 * one level out. findSkipEscapes (skip-escape.ts) scans a spec's own VERIFY block;
 * nothing scanned the SCRIPT DEFINITIONS those VERIFY blocks then invoke by name, so
 * `bun run lint` could be authored into a no-op and every gate would salute it.
 *
 * TWO SHAPES, both crisp, both scoped to CHECK-CLASS script names:
 *
 *   A. ALWAYS-ZERO TAIL — the script's last command cannot fail (`… || true`,
 *      `… || :`, `… || exit 0`, `…; exit 0`, a trailing `|| echo` fallback). A
 *      shell script's status is its last command's status, so this is a proof, not
 *      a heuristic: the script exits 0 no matter what the checker found.
 *
 *   B. INVERTED-GREP LAUNDERING — a checker piped into `grep -qv` / `grep -vq`.
 *      "Some line of the output does NOT match X" is never a checker's verdict; it
 *      is true of virtually any non-empty output, including a wall of errors.
 *
 * Deliberately NOT flagged, because each is legitimate and FP-measured against the
 * real corpus (pi-task, aiz-server, aiz-client, gofer, mx5):
 *   - `|| exit 1` — a HARDENING, the opposite of an escape (aiz-server).
 *   - any `||`/pipe in a NON-check script (`clean`, `dev`, `start`, `copy-fonts`) —
 *     a teardown `rm -rf dist || true` is correct and common.
 *   - pipes into formatters/reporters (`| tap-spec`, `| tee`) — those propagate
 *     status or are presentational; only inverted grep is unambiguous.
 *   - a plain `| grep -q "expected"` — that is a real assertion on output.
 */

/** One neutered check script. */
export interface ScriptEscapeFinding {
    /** The script's name as declared (e.g. `lint`). */
    name: string
    /** The script's body, verbatim. */
    body: string
    /** Why it cannot fail (human- and prompt-readable). */
    reason: string
}

/**
 * Script names whose whole purpose is to FAIL when something is wrong. A neutered
 * `clean` or `dev` is nobody's business; a neutered `lint` silently disarms every
 * gate that runs it. Suffixed variants (`test:ct`, `lint:fix`, `check-types`) match.
 */
const CHECK_SCRIPT_RE =
    /^(?:lint|test|check|verify|validate|typecheck|types?|tsc|ci|audit|coverage|e2e|build|compile|fmt:check|format:check)(?:[:_-].*)?$/i

/** `|| exit 1` and friends HARDEN a script — never mistake one for an escape. */
const HARDENING_TAIL_RE = /\|\|\s*exit\s+[1-9]\d*\s*$/

/** Tails that make the script's exit status unconditionally 0. */
const ALWAYS_ZERO_TAILS: Array<{re: RegExp; what: string}> = [
    {re: /\|\|\s*true\s*$/, what: '`|| true`'},
    {re: /\|\|\s*:\s*$/, what: '`|| :`'},
    {re: /\|\|\s*exit\s+0\s*$/, what: '`|| exit 0`'},
    {re: /;\s*true\s*$/, what: '`; true`'},
    {re: /;\s*exit\s+0\s*$/, what: '`; exit 0`'},
    {re: /\|\|\s*echo\b[^|&;]*$/, what: 'a trailing `|| echo …` fallback'}
]

/** A checker piped into an INVERTED grep: status becomes "something didn't match". */
const INVERTED_GREP_RE = /\|\s*grep\s+(?:-\w*v\w*|-\w+\s+-\w*v\w*)/

/**
 * Strip trailing subshell/group closers and separators so the tail patterns see the
 * real last command. mx5's script ends `… || true)` — without this the `)` hides it.
 */
function tailOf(body: string): string {
    let s = body.trim()

    while (true) {
        const next = s.replace(/[)\s;]+$/, '').trimEnd()
        if (next === s) return s
        s = next
    }
}

/**
 * Judge one script definition. Returns null when the script is not check-class, or
 * is check-class but can genuinely fail.
 */
export function judgeScript(name: string, body: string): ScriptEscapeFinding | null {
    if (!CHECK_SCRIPT_RE.test(name)) return null
    if (typeof body !== 'string' || body.trim().length === 0) return null
    const reasons: string[] = []
    const tail = tailOf(body)
    if (!HARDENING_TAIL_RE.test(tail)) {
        for (const {re, what} of ALWAYS_ZERO_TAILS) {
            if (re.test(tail)) {
                reasons.push(`it ends in ${what}, so the script exits 0 whatever the check reports`)
                break
            }
        }
    }
    if (INVERTED_GREP_RE.test(body)) {
        reasons.push(
            'it pipes a check into an INVERTED grep (`grep -v`), so the exit status becomes '
                + '"some output line did not match" — true of almost any output, including errors'
        )
    }
    if (reasons.length === 0) return null
    return {
        name,
        body: body.trim(),
        reason: reasons.join('; ')
    }
}

/**
 * Scan a parsed `scripts` map (package.json shape) for neutered check scripts.
 * A non-object, or a map with no check-class scripts, yields no findings.
 */
export function findScriptEscapes(scripts: unknown): ScriptEscapeFinding[] {
    if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) return []
    const out: ScriptEscapeFinding[] = []
    for (const [name, body] of Object.entries(scripts as Record<string, unknown>)) {
        const f = judgeScript(name, typeof body === 'string' ? body : '')
        if (f) out.push(f)
    }
    return out
}

/**
 * Scan a package.json's TEXT. Invalid JSON yields no findings — a manifest that does
 * not parse is a different problem, and guessing at its contents is how a scanner
 * earns false positives.
 */
export function findScriptEscapesInManifest(manifestText: string): ScriptEscapeFinding[] {
    try {
        const parsed: unknown = JSON.parse(manifestText)
        if (typeof parsed !== 'object' || parsed === null) return []
        return findScriptEscapes((parsed as {scripts?: unknown}).scripts)
    } catch {
        return []
    }
}

/**
 * Scan ARBITRARY text (a spec, a design doc) for script definitions written as JSON
 * pairs — the form a spec uses when it dictates a script for the implementer to add
 * (`"lint": "tsc --noEmit || true"`). This is what lets the critique catch the
 * neutered script at SPEC time, before any task writes it into a manifest.
 *
 * Deliberately narrow: only `"name": "body"` pairs on one line, only check-class
 * names. Prose describing a script in words extracts nothing.
 */
export function findScriptEscapesInText(text: string): ScriptEscapeFinding[] {
    const out: ScriptEscapeFinding[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(/"([A-Za-z0-9:_-]{1,40})"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
        const name = m[1]
        // Unescape the JSON string body so shell operators read normally.
        let body: string
        try {
            body = JSON.parse(`"${m[2]}"`) as string
        } catch {
            continue
        }
        const key = `${name}=${body}`
        if (seen.has(key)) continue
        const f = judgeScript(name, body)
        if (!f) continue
        seen.add(key)
        out.push(f)
    }
    return out
}

/**
 * Verify-child prompt lines (probe+rule pattern): one per neutered script, naming
 * the script, its body, and why it cannot fail.
 */
export function scriptEscapeVerifyFindings(findings: ScriptEscapeFinding[]): string[] {
    return findings.map(f => `\`${f.name}\`: ${f.body} — ${f.reason}`)
}

/**
 * Render findings as a critique/rewrite defect block — same shape as
 * skipEscapeDefectText: a numbered list the rewrite must resolve.
 */
export function scriptEscapeDefectText(findings: ScriptEscapeFinding[]): string {
    return [
        'NEUTERED CHECK SCRIPT — this spec defines a check script that CANNOT FAIL, so every',
        'gate that runs it reads a constant instead of a measurement (mx5 run 13 shipped',
        '`"lint": "… && (tsc --noEmit 2>&1 | grep -qv \'TS18003\' || true)"` — the typecheck',
        'was fully disarmed, and it went unnoticed only because tsc happened to be clean).',
        "Rewrite each so it PROPAGATES the checker's exit status: drop the `|| true` /",
        '`; exit 0` tail, and never launder a checker through an inverted grep. If a',
        'specific diagnostic must genuinely be tolerated, suppress THAT diagnostic in the',
        "checker's own config — never blanket-zero the whole script's exit code:",
        ...findings.map((f, i) => `  ${i + 1}. "${f.name}": "${f.body}" — ${f.reason}`)
    ].join('\n')
}
