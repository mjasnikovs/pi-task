/**
 * Spec gate — the guards that decide whether a composed spec is acceptable at
 * handoff. Unlike the informational parsers in parsers.ts, these answer a
 * yes/no (or "what's wrong") question the orchestrator and critique phase act
 * on: is the VERIFY block runnable, is the shape well-formed, did critique come
 * back CLEAN. Self-contained (no imports) so the gate doesn't drag in the phase
 * pipeline.
 */

export interface VerifyCommand {
    raw: string
}

// ─── Verify block parser ─────────────────────────────────────────────────────

export function parseVerifyBlock(spec: string): VerifyCommand[] | null {
    return scanVerifyBlock(spec)?.cmds ?? null
}

/**
 * parseVerifyBlock, but only when the fenced block is actually CLOSED.
 *
 * An unterminated fence makes the lenient parser swallow the rest of the file:
 * mx5 run 19's `TASK_0001.md` opens ```sh and never closes it, so its "VERIFY
 * commands" include the phase-timings table and every appended gate-trail line.
 * That is harmless where the parser only asks "is there something runnable here",
 * and NOT harmless where a parsed line is treated as provenance — a debt reason
 * quoting `bun run lint` would match a gate-trail sentence and mint a stored,
 * re-runnable command the spec never asked for (accept-debt.ts
 * verifyCommandFromReason, `inv-command-provenance`). Callers that need the block
 * to MEAN something use this one: an unclosed fence is no block at all.
 */
export function parseVerifyBlockStrict(spec: string): VerifyCommand[] | null {
    const scan = scanVerifyBlock(spec)
    return scan && scan.terminated ? scan.cmds : null
}

function scanVerifyBlock(spec: string): {cmds: VerifyCommand[]; terminated: boolean} | null {
    const lines = spec.split('\n')
    let i = 0
    while (i < lines.length && !/^VERIFY:\s*$/.test(lines[i])) i++
    if (i >= lines.length) return null
    i++
    while (i < lines.length && lines[i].trim() === '') i++
    if (i >= lines.length) return null
    if (!/^```(sh|bash)?\s*$/.test(lines[i])) return null
    i++
    const cmds: VerifyCommand[] = []
    while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        const line = lines[i].trim()
        if (line.length > 0 && !line.startsWith('#')) cmds.push({raw: line})
        i++
    }
    return {cmds, terminated: i < lines.length}
}

// ─── Critique triage gate ────────────────────────────────────────────────────

// The critique-triage prompt instructs the worker to emit the literal token
// `CLEAN` on its own line when the compose draft has no substantive defects, so
// we can skip the expensive full-rewrite pass. Anything else is treated as a
// defect list that gets fed into the rewrite. Empty output is NOT clean — that
// would be a silent crash, and treating it as clean would skip review entirely.
export function isCritiqueClean(text: string): boolean {
    const firstLine = text
        .split('\n')
        .map(l => l.trim())
        .find(l => l.length > 0)
    if (!firstLine) return false
    return /^CLEAN[.!]?$/i.test(firstLine)
}

// ─── Spec shape gate ─────────────────────────────────────────────────────────

/**
 * Drop any preamble the model emitted before the spec's GOAL header. The
 * thinking model sometimes narrates ("Now I have all the context. Here's the
 * rewritten spec:") before GOAL — the prompts forbid it, but the critique
 * validator only checks for a VERIFY block, so it leaked into the delivered
 * spec. We slice from the first line that begins a GOAL section so the spec
 * starts at GOAL. No GOAL line → returned unchanged (validation then flags it).
 */
export function stripSpecPreamble(spec: string): string {
    const lines = spec.split('\n')
    const idx = lines.findIndex(l => /^GOAL\b/i.test(l))
    if (idx <= 0) return spec
    // Only strip plain narration. If the lead-in is a markdown fence or a
    // cat-heredoc wrapper, leave it untouched — that's a malformation
    // validateSpecShape must reject (and compose must retry on), not something
    // to silently unwrap into a passing spec.
    const preamble = lines.slice(0, idx)
    if (preamble.some(l => /^\s*```/.test(l) || /^\s*cat\s*<</.test(l))) return spec
    return lines.slice(idx).join('\n')
}

export function validateSpecShape(spec: string): string | null {
    const trimmed = spec.trim()
    if (trimmed.length === 0) return 'spec is empty'
    const firstLine = trimmed.split('\n', 1)[0]
    if (/^\s*```/.test(firstLine)) return 'spec starts with a markdown fence'
    if (/^\s*cat\s*<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(firstLine)) {
        return 'spec is wrapped in a cat heredoc'
    }
    if (!/^GOAL\b/i.test(trimmed)) return 'spec does not start with GOAL'
    for (const section of ['CONSTRAINTS', 'ACCEPTANCE', 'VERIFY']) {
        if (!new RegExp(`^\\s*${section}\\b`, 'm').test(trimmed)) {
            return `spec missing required section: ${section}`
        }
    }
    return null
}
