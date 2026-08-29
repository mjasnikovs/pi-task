/**
 * unfailable-command — is this shell command's exit status DESTROYED by its own
 * construction?
 *
 * WHY THIS EXISTS. `recheckAcceptDebts` may auto-close an accepted debt on exactly
 * one piece of evidence: the debt named a VERIFY command, that command was re-run,
 * and it exited ZERO (accept-debt.ts — "the debt named a command, the command was
 * run, and it passed"). `isStorableCommand` used to filter only on length and
 * control characters, so nothing asked whether a ZERO exit could ever mean
 * anything. Sixteen stored-eligible VERIFY lines in the corpus on this box cannot
 * exit non-zero no matter what the tree contains:
 *
 *     C  `test -f "$SO_LIB" && echo "PASS: …" || echo "FAIL: …"`     15  ← both
 *        branches that can be LAST are echoes, so the status is echo's: 0.
 *     A  `bun -e "console.assert(…)"`                                 1  ← measured
 *        in both runtimes: `console.assert(1===2,'X')` prints and exits 0.
 *     B  `npx tsc --noEmit 2>&1 | tail -5; test $? -eq 0 && …`        1  ← `$?` is
 *        tail's status, not tsc's.
 *
 * one real project (CMake / C++ / OBS plugin — no database, no frontend, no HTTP server)
 * carries 11 of the 16; one of its tasks is SEVEN consecutive `test -f … && echo
 * "PASS" || echo "FAIL"` lines standing in for a build verification.
 *
 * THE VERDICT IS A REFUSAL, NOT A CLAIM. An unfailable command is not stored, so
 * the debt stays OPEN and surfaced — the strictly smaller claim. Nothing here can
 * close a debt, fail a gate, or edit a spec.
 *
 * DECIDED ON SHELL SHAPE, NEVER ON THE VERB. `grep -q …` and `ctest …` set a real
 * status and are untouched; `test -f X || { echo …; exit 1; }` exits non-zero and
 * is untouched. Naming verbs is the mistake  already paid for
 * (command-shrink's guard compared NAMES) and 16B re-bought.
 *
 * OUT OF SCOPE BY DESIGN: bare `|| true`. skip-escape.ts:11-19 records the FP
 * measurement — of 45 `||` uses in the historical VERIFY blocks exactly one was a
 * real skip-escape; a blanket `|| true` rule is ~90% false positives (teardown,
 * setup, negative tests). `rm -rf build || true` classifies CAN-FAIL here and must
 * keep doing so.
 *
 * THREE OUTCOMES, and `unknown` is a first-class answer: a shape this cannot
 * decide is never guessed at, it is left alone (which is today's behaviour).
 */

/** How a command's exit status behaves. `unknown` ⇒ do not act. */
export type ExitStatusClass = 'unfailable' | 'can-fail' | 'unknown'

export interface UnfailableVerdict {
    cls: ExitStatusClass
    /** Which sub-rule decided it (A/B/C), and in prose. Empty for `can-fail`. */
    reason: string
}

const CAN_FAIL: UnfailableVerdict = {cls: 'can-fail', reason: ''}

// ─── a quote- and group-aware splitter ───────────────────────────────────────

/**
 * Split `s` on the top-level occurrences of `seps` (longest first), respecting
 * single quotes, double quotes, `$(…)`/backtick substitution and `(…)`/`{…}`
 * groups. Returns the pieces and the separators that joined them.
 */
function splitTopLevel(s: string, seps: readonly string[]): {parts: string[]; ops: string[]} {
    const parts: string[] = []
    const ops: string[] = []
    let buf = ''
    let depth = 0
    let quote: '"' | "'" | '`' | null = null
    for (let i = 0; i < s.length; i++) {
        const c = s[i]!
        if (quote !== null) {
            buf += c
            if (c === '\\' && quote === '"') {
                if (i + 1 < s.length) buf += s[++i]
                continue
            }
            if (c === quote) quote = null
            continue
        }
        if (c === '\\') {
            buf += c
            if (i + 1 < s.length) buf += s[++i]
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            quote = c
            buf += c
            continue
        }
        if (c === '(' || (c === '{' && /(?:^|\s)$/.test(buf))) {
            depth++
            buf += c
            continue
        }
        if (c === ')' || (c === '}' && depth > 0)) {
            depth = Math.max(0, depth - 1)
            buf += c
            continue
        }
        if (depth === 0) {
            const hit = seps.find(sep => s.startsWith(sep, i))
            if (hit !== undefined) {
                parts.push(buf)
                ops.push(hit)
                buf = ''
                i += hit.length - 1
                continue
            }
        }
        buf += c
    }
    parts.push(buf)
    return {parts, ops}
}

/** `a; b; c` — the LINE's exit status is the LAST segment's. */
function segments(cmd: string): string[] {
    return splitTopLevel(cmd, [';'])
        .parts.map(p => p.trim())
        .filter(p => p.length > 0)
}

/** `a && b || c` — the pieces and the operators between them. */
function chain(seg: string): {parts: string[]; ops: string[]} {
    const {parts, ops} = splitTopLevel(seg, ['&&', '||'])
    return {parts: parts.map(p => p.trim()), ops}
}

/** A top-level `|` that is not `||`. */
function hasPipeline(seg: string): boolean {
    const {ops} = splitTopLevel(seg, ['||', '|'])
    return ops.includes('|')
}

/**
 * Which commands of an `&&`/`||` chain can be the LAST one executed — i.e. whose
 * exit status can become the chain's.
 *
 * `c_i` (before the end) can be terminal only if some single status short-circuits
 * EVERY remaining operator: `&&` skips what follows when the status is non-zero,
 * `||` skips it when the status is zero. A chain that mixes the two after `c_i`
 * therefore always runs on past it. For `A && B || C`: A is never terminal (the
 * `||` picks C up after A fails), B is terminal when it succeeds, C is terminal —
 * so the status is always an echo's, which is the run-21 shape.
 */
function terminalIndices(ops: readonly string[], n: number): number[] {
    const out: number[] = []
    for (let i = 0; i < n; i++) {
        if (i === n - 1) {
            out.push(i)
            continue
        }
        const rest = ops.slice(i, n - 1)
        const skipsOnFail = rest.every(o => o === '&&')
        const skipsOnOk = rest.every(o => o === '||')
        if (skipsOnFail || skipsOnOk) out.push(i)
    }
    return out
}

// ─── the three sub-rules ─────────────────────────────────────────────────────

/** The command word, with leading `VAR=value` assignments and `env` stripped. */
function commandWord(cmd: string): string {
    let rest = cmd.trim()
    for (;;) {
        const m = /^(?:env\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/.exec(rest)
        if (!m) break
        rest = rest.slice(m[0].length)
    }
    return /^[^\s]*/.exec(rest)?.[0] ?? ''
}

/**
 * A branch that cannot do anything but succeed: `echo …` / `printf …` with no
 * redirection to a file (a redirect CAN fail on a bad path, and this class is
 * about statuses destroyed by construction, not about likely ones).
 */
function isPureEcho(cmd: string): boolean {
    const word = commandWord(cmd)
    if (word !== 'echo' && word !== 'printf') return false
    return !splitTopLevel(cmd, ['>>', '>']).ops.length
}

/**
 * RULE A — a `console.assert` check. Measured, not assumed, in both runtimes:
 *
 *     $ bun  -e "console.assert(1===2,'X'); console.log('end')"; echo $?   → 0
 *     $ node -e "console.assert(1===2,'X'); console.log('end')"; echo $?   → 0
 *
 * It prints and continues. Narrowed so an eval that ALSO has a real exit path
 * (`process.exit`, `throw`, a shell `exit`) is untouched — those can fail.
 */
function ruleA(cmd: string): boolean {
    if (!cmd.includes('console.assert')) return false
    return !/\bprocess\.exit\b|\bthrow\b|\bexit\s+\d/.test(cmd)
}

/**
 * RULE B — `$?` read after a PIPELINE. `a | b ; test $? …` tests b's status, not
 * a's, so the check reports on the filter rather than on the thing being checked.
 * Shape-only: which command ends the pipeline is never inspected.
 */
function ruleB(segs: readonly string[]): boolean {
    for (let i = 1; i < segs.length; i++) {
        if (segs[i]!.includes('$?') && hasPipeline(segs[i - 1]!)) return true
    }
    return false
}

/**
 * RULE C — every branch of the top-level `&&`/`||` chain that can be LAST is a
 * pure echo/printf, so the chain's status is an echo's: zero, always.
 */
function ruleC(seg: string): boolean {
    const {parts, ops} = chain(seg)
    if (parts.length < 2) return false
    const terms = terminalIndices(ops, parts.length)
    return terms.length > 0 && terms.every(i => isPureEcho(parts[i]!))
}

// ─── the verdict ─────────────────────────────────────────────────────────────

/** Shapes this refuses to judge — never a guess, always today's behaviour. */
function undecidable(cmd: string): string | null {
    const t = cmd.trim()
    // `set -e` changes what a non-zero status DOES, all the way up the line.
    if (/(?:^|[;&|(]\s*)set\s+-[a-z]*e/.test(t)) return '`set -e` is in effect for this line'
    // The whole line wrapped in a command substitution: the status is the outer
    // context's, which is not in the text.
    if (/^\$\([\s\S]*\)$/.test(t) || /^`[\s\S]*`$/.test(t)) {
        return 'the whole line is a command substitution'
    }
    return null
}

/**
 * Is this command's exit status destroyed by construction? The only caller that
 * may ACT on `unfailable` is `isStorableCommand`, and the only action is a refusal
 * to store — never a close, never a gate failure.
 */
export function classifyExitStatus(cmd: string): UnfailableVerdict {
    const t = cmd.trim()
    if (t.length === 0) return CAN_FAIL
    const skip = undecidable(t)
    if (skip !== null) return {cls: 'unknown', reason: skip}

    const segs = segments(t)
    if (segs.length === 0) return CAN_FAIL

    if (ruleB(segs)) {
        return {
            cls: 'unfailable',
            reason:
                'B: `$?` is read after a pipeline, so it holds the LAST pipeline element’s '
                + 'status and not the checked command’s'
        }
    }
    // The line's status is the LAST segment's; earlier segments cannot change it.
    const last = segs[segs.length - 1]!
    if (ruleA(last)) {
        return {
            cls: 'unfailable',
            reason:
                'A: `console.assert` never exits non-zero and never throws — it prints and '
                + 'continues, in both bun and node'
        }
    }
    if (ruleC(last)) {
        return {
            cls: 'unfailable',
            reason:
                'C: every branch of the `&&`/`||` chain that can run LAST is an `echo`/`printf`, '
                + 'so the exit status is the echo’s — zero whatever the check found'
        }
    }
    return CAN_FAIL
}

/** Convenience predicate for the one place that acts on this. */
export function isUnfailableCommand(cmd: string): boolean {
    return classifyExitStatus(cmd).cls === 'unfailable'
}
