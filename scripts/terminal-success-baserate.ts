/**
 * STEP 0 — does rule C have a `cmd || echo` hole worth closing? READ-ONLY.
 *
 * THE CLAIM UNDER TEST. `ruleC` calls a chain unfailable only when EVERY branch
 * that can run LAST is a pure `echo`/`printf`. For `grep -q X . || echo "absent"`
 * that is false — branch 0 is `grep` — so the line classifies CAN-FAIL. But branch
 * 0 is terminal only because `||` short-circuits on SUCCESS, so the status it
 * contributes is zero by construction, and the `||` branch contributes an echo's
 * zero. The line always exits 0 and the classifier does not say so.
 *
 * WHAT THIS MEASURES, and nothing else: over every store-eligible VERIFY line in
 * the ~/hub corpus, how many lines are currently CAN-FAIL, would become UNFAILABLE
 * under the narrowed rule, AND actually exit 0 in a real shell when the check they
 * name is FALSE. The shell is the arbiter — a classifier claiming "cannot fail" is
 * making a claim about a shell, so the shell is asked.
 *
 * NEVER POOLED. Per-project counts are printed. IAR1 and mx5 carry different
 * halves of this class and pooling hides both.
 *
 * PRE-REGISTERED GATE, written before looking:
 *
 *     PROCEED to a lever iff  flipped_and_shell_confirmed >= 10
 *                        AND  spread over >= 2 distinct projects
 *                        AND  0 lines flip that the shell shows CAN exit non-zero.
 *     Below any of those: record the count and STOP. No rule change.
 *
 * The third clause is the kill condition: one flipped line that a shell proves can
 * fail means the narrowed rule is unsound, and the size of the class is irrelevant.
 *
 * POSITIVE CONTROL, mandatory. `grep -q __nope__ /etc/hostname || echo absent`
 * must (a) classify CAN-FAIL today, (b) flip under the narrowed predicate, and
 * (c) really exit 0. A dead instrument reports zero for the wrong reason, so if
 * the control does not trip, this script refuses to report (exit 2).
 *
 * Run: bun run scripts/terminal-success-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseVerifyBlockStrict} from '../src/task/spec-validation.js'
import {classifyExitStatus} from '../src/task/unfailable-command.js'

/** `isStorableCommand`'s non-19C half, replicated because it is module-private.
 *  The 19C clause itself is DELIBERATELY omitted — it is the thing under test. */
const MAX_REASON_LENGTH = 300
function storableIgnoring19C(cmd: string): boolean {
    return cmd.length > 0 && cmd.length <= MAX_REASON_LENGTH && !/[\t\n\r]/.test(cmd)
}

const HUB = path.join(os.homedir(), 'hub')

// ─── the narrowed predicate, expressed here and NOT in src ───────────────────
// STEP 0 may not touch the shipped rule. This is a local replica used only to
// COUNT; the lever, if it ships, is a change to ruleC itself.

/** Copy of the splitter's contract, kept minimal: top-level `&&`/`||` split. */
function splitChain(s: string): {parts: string[]; ops: string[]} {
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
            const hit = ['&&', '||'].find(sep => s.startsWith(sep, i))
            if (hit !== undefined) {
                parts.push(buf.trim())
                ops.push(hit)
                buf = ''
                i += hit.length - 1
                continue
            }
        }
        buf += c
    }
    parts.push(buf.trim())
    return {parts, ops}
}

function lastSegment(cmd: string): string {
    // `;`-split at top level is close enough for the count; the shipped splitter
    // is quote-aware and this replica only has to agree on the corpus.
    const segs = cmd
        .split(/;(?=(?:[^"']*(?:"[^"]*"|'[^']*'))*[^"']*$)/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
    return segs[segs.length - 1] ?? ''
}

function commandWord(cmd: string): string {
    let rest = cmd.trim()
    for (;;) {
        const m = /^(?:env\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)/.exec(rest)
        if (!m) break
        rest = rest.slice(m[0].length)
    }
    return /^[^\s]*/.exec(rest)?.[0] ?? ''
}

function isPureEcho(cmd: string): boolean {
    const w = commandWord(cmd)
    if (w !== 'echo' && w !== 'printf') return false
    return !/>>?/.test(cmd)
}

/**
 * The NARROWED rule: a chain is unfailable when every branch that can run LAST
 * contributes a ZERO status.
 *
 *   i < n-1, remaining ops all `||`  → terminal because it SUCCEEDED → zero
 *   i < n-1, remaining ops all `&&`  → terminal because it FAILED    → non-zero
 *   i == n-1                          → zero only if it is a pure echo
 *
 * `rm -rf build || true` keeps classifying CAN-FAIL: `true` is not an echo. That
 * is deliberate — skip-escape.ts measured a blanket `|| true` rule at ~90% FP.
 *
 * SOUNDNESS REPAIR (found by the first run of this script, kept as the record): a
 * branch containing `exit N` does not "contribute a status to the chain" — it ENDS
 * THE SHELL with N. `grep -q X f && echo FAIL && exit 1 || echo OK` really exits 1
 * when the grep succeeds, and the first cut of this predicate called it unfailable.
 * Any chain carrying a shell `exit` is therefore refused outright.
 */
function narrowedUnfailable(seg: string): boolean {
    const {parts, ops} = splitChain(seg)
    const n = parts.length
    if (n < 2) return false
    // A branch that can terminate the shell defeats the whole analysis.
    if (parts.some(p => /(?:^|[;\s(])exit(?:\s+\d+)?\s*$|^exit\s+\d/.test(p.trim()))) return false
    let sawTerminal = false
    for (let i = 0; i < n; i++) {
        if (i === n - 1) {
            sawTerminal = true
            if (!isPureEcho(parts[i]!)) return false
            continue
        }
        const rest = ops.slice(i, n - 1)
        const allOr = rest.every(o => o === '||')
        const allAnd = rest.every(o => o === '&&')
        if (!allOr && !allAnd) continue // not terminal
        sawTerminal = true
        if (allAnd) return false // terminal by FAILING → non-zero
        // allOr → terminal by SUCCEEDING → zero, whatever the command is
    }
    return sawTerminal
}

// ─── shell arbitration ───────────────────────────────────────────────────────

/** Run the line in a scratch EMPTY tree, where any file/content check it names is
 *  FALSE, and report the real exit status. Bounded; a hang counts as unknown. */
function shellExit(cmd: string, cwd: string): number | null {
    const r = spawnSync('bash', ['-c', cmd], {cwd, timeout: 15_000, encoding: 'utf8'})
    if (r.error || r.status === null) return null
    return r.status
}

// ─── corpus walk ─────────────────────────────────────────────────────────────

function taskFiles(root: string): string[] {
    const out: string[] = []
    const walk = (d: string, depth: number): void => {
        if (depth > 6) return
        let ents: fs.Dirent[]
        try {
            ents = fs.readdirSync(d, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of ents) {
            const p = path.join(d, e.name)
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git') continue
                walk(p, depth + 1)
            } else if (/^TASK_\d+\.md$/.test(e.name) && d.endsWith('.pi-tasks')) {
                out.push(p)
            }
        }
    }
    walk(root, 0)
    return out
}

const CONTROL = 'grep -q __nope__ /etc/hostname || echo absent'

function main(): void {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tsb-'))

    // ── positive control, before anything is counted ─────────────────────────
    const ctlToday = classifyExitStatus(CONTROL).cls
    const ctlNarrow = narrowedUnfailable(lastSegment(CONTROL))
    const ctlShell = shellExit(CONTROL, scratch)
    console.log(`CONTROL  ${CONTROL}`)
    console.log(`         today=${ctlToday}  narrowed=${ctlNarrow}  shell_exit=${ctlShell}`)
    if (ctlToday !== 'can-fail' || !ctlNarrow || ctlShell !== 0) {
        console.error('POSITIVE CONTROL DID NOT TRIP — instrument is dead. Refusing to report.')
        process.exit(2)
    }

    const projects = fs
        .readdirSync(HUB, {withFileTypes: true})
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()

    let totalEligible = 0
    const perProject = new Map<string, {flipped: number; unsound: number; lines: string[]}>()
    const unsoundLines: {project: string; cmd: string; exit: number}[] = []

    for (const proj of projects) {
        const files = taskFiles(path.join(HUB, proj))
        if (files.length === 0) continue
        const rec = {flipped: 0, unsound: 0, lines: [] as string[]}
        const seen = new Set<string>()
        for (const f of files) {
            let body: string
            try {
                body = fs.readFileSync(f, 'utf8')
            } catch {
                continue
            }
            const cmds = parseVerifyBlockStrict(body)
            if (cmds === null) continue
            for (const c of cmds) {
                const raw = c.raw.trim()
                if (raw.length === 0) continue
                // Only lines the debt machinery would actually STORE are in scope —
                // the same gate the shipped rule sits behind.
                if (!storableIgnoring19C(raw)) continue
                totalEligible++
                if (seen.has(raw)) continue
                seen.add(raw)
                if (classifyExitStatus(raw).cls !== 'can-fail') continue
                if (!narrowedUnfailable(lastSegment(raw))) continue
                const code = shellExit(raw, scratch)
                if (code === null) continue
                if (code === 0) {
                    rec.flipped++
                    rec.lines.push(raw)
                } else {
                    rec.unsound++
                    unsoundLines.push({project: proj, cmd: raw, exit: code})
                }
            }
        }
        if (rec.flipped > 0 || rec.unsound > 0) perProject.set(proj, rec)
    }

    console.log(`\nstore-eligible VERIFY lines scanned: ${totalEligible}`)
    console.log('\nper project (NEVER pooled):')
    let flipped = 0
    let unsound = 0
    for (const [proj, rec] of perProject) {
        console.log(`  ${proj.padEnd(16)} flipped=${rec.flipped}  unsound=${rec.unsound}`)
        for (const l of rec.lines) console.log(`      ${l.slice(0, 110)}`)
        flipped += rec.flipped
        unsound += rec.unsound
    }
    if (perProject.size === 0) console.log('  (none)')

    if (unsoundLines.length > 0) {
        console.log('\nUNSOUND — narrowed rule flipped a line a shell proves CAN fail:')
        for (const u of unsoundLines) console.log(`  [${u.project}] exit=${u.exit}  ${u.cmd}`)
    }

    const projectsHit = [...perProject.values()].filter(r => r.flipped > 0).length
    console.log(`\nflipped=${flipped}  projects=${projectsHit}  unsound=${unsound}`)
    const pass = flipped >= 10 && projectsHit >= 2 && unsound === 0
    console.log(
        pass ?
            '\nGATE MET — the class is real and the narrowed rule is sound on this corpus. Proceed to a lever.'
        :   '\nGATE NOT MET — record the count and STOP. No rule change.'
    )
    fs.rmSync(scratch, {recursive: true, force: true})
}

main()
