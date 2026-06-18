/**
 * Guideline enforcement for /task-auto.
 *
 * Local models drift: they skip the rules written in AGENTS.md / CLAUDE.md even
 * when those files sit right next to the code. After a /task-auto sub-task's
 * implementation turn settles — but BEFORE its per-task commit — this runs a
 * fresh child pi (the same local model that did the work) that is handed the
 * project's guideline files plus the task's diff, fixes any violations in place
 * with its edit tools, and reports a CLEAN / VIOLATION verdict.
 *
 * A VIOLATION (or an enforcement pass that cannot confirm CLEAN) blocks the
 * commit and fails the task, so non-compliant work is never snapshotted — the
 * run pauses for /task-auto-resume. This is deliberately strict: the whole
 * point is that "the model probably followed the rules" is not good enough.
 *
 * Gated by the `enforceGuidelines` config flag. With the flag off, or with no
 * guideline files in the working directory, enforcement is a pass (ok: true).
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {runChildDefault, type SpawnFn} from '../shared/child-process.js'
import {USER_CANCELLED} from './child-runner.js'

/** Filenames discovered in the working directory (cwd only — no tree walk). */
export const GUIDELINE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Tools the fix pass is allowed: read/search to inspect, edit/write to fix. */
const ENFORCE_TOOLS = 'read,grep,find,ls,edit,write'

export interface GuidelineDoc {
    /** Filenames found, in discovery order (e.g. ['AGENTS.md', 'CLAUDE.md']). */
    files: string[]
    /** The concatenated rules text, each file under a `## <name>` header. */
    text: string
}

export interface EnforceOutcome {
    /** true → compliant (after any fixes), enforcement disabled, or no
     *  guideline files. false → a violation the pass could not clear, or the
     *  pass could not run / produced no verdict. */
    ok: boolean
    /** Short, human-readable reason. Always set when ok === false; on the pass
     *  path set to the no-op cause ('disabled', 'no guideline files'). */
    reason?: string
}

/**
 * Read the guideline files that live directly in `cwd` (AGENTS.md, CLAUDE.md).
 * Returns null when none exist or all are empty — the caller treats that as a
 * pass. cwd-only by design: no walk up to the git root.
 */
export async function discoverGuidelines(
    cwd: string,
    readFile: (p: string) => Promise<string> = p => fsp.readFile(p, 'utf8')
): Promise<GuidelineDoc | null> {
    const files: string[] = []
    const sections: string[] = []
    for (const name of GUIDELINE_FILENAMES) {
        let raw: string
        try {
            raw = await readFile(path.join(cwd, name))
        } catch {
            continue // missing file — skip
        }
        if (raw.trim().length === 0) continue // present but empty — nothing to enforce
        files.push(name)
        sections.push(`## ${name}\n\n${raw.trim()}`)
    }
    if (files.length === 0) return null
    return {files, text: sections.join('\n\n')}
}

/**
 * Build the enforcement child's prompt: the rules, the diff of the work just
 * done, and the contract for the final verdict line. Kept pure so the wording
 * is unit-tested without spawning pi.
 */
export function buildEnforcePrompt(rulesText: string, diff: string): string {
    return [
        'You are a strict guideline-enforcement pass running after an AI coding agent',
        'finished a task but before its work is committed. The agent is known to skip',
        'project rules, so do not trust that it followed them — verify against the diff.',
        '',
        'PROJECT GUIDELINES (from this repository):',
        rulesText,
        '',
        'CHANGES JUST MADE (verify these specifically; read any file you need in full):',
        diff.trim().length > 0 ? diff : '(no textual diff captured — inspect the working tree)',
        '',
        'Your job:',
        '1. Check the changed files against EVERY rule above.',
        '2. For each violation you find, FIX it directly using your edit/write tools.',
        '   Make the minimal change that satisfies the rule; do not rewrite unrelated code.',
        '3. Do not introduce new behavior or features — only bring the work into compliance.',
        '',
        'When you are done, output EXACTLY ONE of these as the final line:',
        '  ENFORCE: CLEAN              (the changes comply with every rule, after your fixes)',
        '  ENFORCE: VIOLATION <text>  (a rule is still violated and you could not fix it; say which)',
        'Output the verdict line verbatim — it is parsed mechanically.'
    ].join('\n')
}

/**
 * Parse the child's final verdict. Scans for the LAST `ENFORCE: CLEAN` /
 * `ENFORCE: VIOLATION` marker (the model may discuss before concluding).
 *
 * No marker at all is treated as NOT clean: a pass that cannot state a verdict
 * is a gray area, and the contract is that uncertain work does not get
 * committed.
 */
export function parseEnforceVerdict(text: string): {clean: boolean; detail: string} {
    const re = /ENFORCE:\s*(CLEAN|VIOLATION)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {clean: false, detail: 'no verdict emitted'}
    const clean = last[1].toUpperCase() === 'CLEAN'
    return {clean, detail: clean ? '' : last[2].trim() || 'unspecified violation'}
}

/** The subset of a runWorker result the enforcement-child mapping reads. */
export interface EnforceChildResult {
    text: string
    exitCode: number
    aborted: boolean
    timedOut?: boolean
    loopHit?: unknown
    leakedToolCall?: unknown
}

/**
 * Map the enforcement child's runWorker result to a fatal error message, or null
 * when it finished cleanly enough to parse a verdict from its text.
 *
 * The order is load-bearing. A loop-kill AND a wall-clock timeout BOTH also set
 * `aborted` (and a non-zero exit) — killProc flips it on every kill path — so the
 * specific causes (timeout, loop, leaked tool call) must be handled BEFORE the
 * generic `aborted → user-cancel` and `exitCode` mappings. Checking `aborted`
 * first (as the original inline code did) mislabels a loop-killed enforcement
 * child as a user cancel.
 *
 * A loop is NOT fatal: enforce attaches the detector in nudge-then-warn mode, so a
 * loop that survived its restart-with-hint nudges returns null here (the caller
 * logs/notifies it as a warning) and the verdict gate alone decides the outcome.
 * It still has to be matched before `aborted`/`exitCode` so the kill's side
 * effects don't get re-classified as a user cancel or a crash.
 */
export function classifyEnforceChildFailure(r: EnforceChildResult): string | null {
    if (r.timedOut) return 'enforcement child timed out'
    if (r.loopHit) return null // looped past the nudges → warning, handled by caller
    if (r.leakedToolCall) return 'enforcement child leaked a tool call'
    if (r.aborted) return USER_CANCELLED
    if (r.exitCode !== 0) return `enforcement child exited ${r.exitCode}`
    return null
}

/**
 * Capture the work to verify as text: the tracked diff against HEAD plus the
 * names of any new (untracked) files. Non-destructive — it does not touch the
 * index, so the later `git add -A` in gitCommitAll still stages everything
 * (including fixes the enforcement child makes).
 */
export async function captureDiff(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string> {
    const run = (args: string[]) =>
        runChildDefault({command: 'git', args}, cwd, signal, {mode: 'text'}, spawnFn)
    const tracked = await run(['diff', 'HEAD'])
    const untracked = await run(['ls-files', '--others', '--exclude-standard'])
    const parts: string[] = []
    if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0)
        parts.push(tracked.stdout.trim())
    const newFiles = untracked.exitCode === 0 ? untracked.stdout.trim() : ''
    if (newFiles.length > 0) parts.push(`New (untracked) files — read them in full:\n${newFiles}`)
    return parts.join('\n\n')
}

export interface EnforcementDeps {
    cwd: string
    signal?: AbortSignal
    /** Defaults to the real cwd-only file discovery. */
    discover?: (cwd: string) => Promise<GuidelineDoc | null>
    /** Defaults to the real git diff capture. */
    getDiff?: (cwd: string, signal?: AbortSignal) => Promise<string>
    /** Runs the enforcement child and returns its assistant text. Injected so
     *  the orchestrator wires the real child runner and tests use a fake. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Run the full enforcement pass for one task. Discovery is cwd-only; an empty
 * result is a pass. Otherwise capture the diff, run the fix child, and turn its
 * verdict into an ok/blocked outcome. Never throws — a child failure becomes a
 * blocking outcome (ok: false) so an unverifiable task is not committed.
 */
export async function runGuidelineEnforcement(deps: EnforcementDeps): Promise<EnforceOutcome> {
    const discover = deps.discover ?? (cwd => discoverGuidelines(cwd))
    const getDiff = deps.getDiff ?? ((cwd, signal) => captureDiff(cwd, signal))

    const doc = await discover(deps.cwd)
    if (!doc) return {ok: true, reason: 'no guideline files'}

    const diff = await getDiff(deps.cwd, deps.signal)
    let text: string
    try {
        text = await deps.runChild(ENFORCE_TOOLS, buildEnforcePrompt(doc.text, diff), deps.signal)
    } catch (err) {
        // A user cancellation is not an enforcement failure — re-throw it so the
        // /task-auto loop's USER_CANCELLED handler reports a clean "cancelled —
        // resume" instead of wrapping it as "enforcement pass could not run".
        if (err instanceof Error && err.message === USER_CANCELLED) throw err
        const msg = err instanceof Error ? err.message : String(err)
        return {ok: false, reason: `enforcement pass could not run: ${msg}`}
    }

    const verdict = parseEnforceVerdict(text)
    if (verdict.clean) return {ok: true}
    return {ok: false, reason: `guideline violation: ${verdict.detail}`}
}

export {ENFORCE_TOOLS}
