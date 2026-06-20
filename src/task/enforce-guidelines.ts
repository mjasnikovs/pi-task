/**
 * Guideline enforcement for /task-auto.
 *
 * Local models drift: they skip the rules written in AGENTS.md / CLAUDE.md even
 * when those files sit right next to the code. After a /task-auto sub-task's
 * implementation turn settles — but BEFORE its per-task commit — this runs a
 * fresh child pi (the same local model that did the work) that is handed the
 * project's guideline files, the task's diff, and the list of changed files. With
 * read + edit tools (and nothing else) it reads those files, fixes any violations
 * in place, and reports a CLEAN / VIOLATION verdict. It cannot create files or run
 * anything: no `write` (so it can't scaffold junk) and no `grep`/`find`/`ls` (so it
 * can't roam the tree) — see ENFORCE_TOOLS.
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
import {TASKS_DIR_NAME} from './task-types.js'

/** Filenames discovered in the working directory (cwd only — no tree walk). */
export const GUIDELINE_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

/**
 * The fix pass gets exactly two tools: `read` and `edit`. Deliberately no
 * `write`, `grep`, `find`, or `ls`.
 *
 *  - No `write` (and `edit` ENOENTs on a missing path) → the pass cannot create
 *    new files. Without this the local model, unable to run lint/tsc/tests, wrote
 *    hundreds of scratch "runner" scripts hoping to execute them — 864 junk files
 *    in one real run (see enforce-debug.log analysis). This is the load-bearing
 *    removal: dropping `write` is what stops the runaway file creation.
 *  - No `grep`/`find`/`ls` → the pass cannot enumerate or roam the tree; it is
 *    handed the explicit, closed list of changed files (see captureDiff) and is
 *    told to edit only those.
 *  - `read` IS allowed: the model genuinely needs it — to re-read a file after
 *    editing to confirm the fix landed, and to read a neighbouring file for the
 *    correct import/type when bringing the change into compliance (without it the
 *    model fabricates imports — validated against the local model). `read` has no
 *    per-path sandbox in pi, so "only the changed files" is enforced for EDITS
 *    (the prompt scopes them) but is a soft instruction for READS.
 */
const ENFORCE_TOOLS = 'read,edit'

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
        'project rules, so do not trust that it followed them — verify against the changes.',
        '',
        'You have a `read` tool and an `edit` tool — nothing else. You CANNOT run',
        'commands, run lint/tsc/tests, or create files. Read the changed files listed',
        'below to inspect them; you may also read a neighbouring file when you need the',
        'correct import or type. But EDIT ONLY the changed files listed below — do not',
        'create new files and do not modify anything outside that set.',
        '',
        'PROJECT GUIDELINES (from this repository):',
        rulesText,
        '',
        'CHANGES JUST MADE (verify these specifically against the rules):',
        diff.trim().length > 0 ? diff : '(no textual diff captured — nothing to verify)',
        '',
        'Your job:',
        '1. Read each changed file and check it against EVERY rule above.',
        '2. For each violation you find, FIX it directly with your `edit` tool, then',
        '   re-read the file to confirm the fix landed. Make the minimal change that',
        '   satisfies the rule; do not rewrite unrelated code.',
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
 * Capture the work to verify as text: the tracked diff against HEAD followed by
 * the COMPLETE list of changed files — tracked-modified ∪ new (untracked) — that
 * the child should read and is allowed to edit.
 *
 * The child has a `read` tool, so file contents are NOT inlined here: it reads
 * each listed file itself (and re-reads after editing to confirm). The list is the
 * scoping signal — it tells the model the closed set of files to touch so it edits
 * only the change set rather than roaming. Validated against the local model:
 * inlining full bodies bought nothing (it read the files by name regardless).
 *
 * Non-destructive — it does not touch the index, so the later `git add -A` in
 * gitCommitAll still stages everything (including fixes the enforcement child
 * makes).
 *
 * The `.pi-tasks/` directory is excluded from every git command. Those task files
 * are committable (tracked) by design, so they show up in `git diff HEAD` and
 * `git ls-files --others` — git does not honor the fd/ripgrep `.ignore` that keeps
 * them out of the worker's find/grep discovery. Without this pathspec the enforce
 * child is handed its own TASK_*.md / TASK_AUTO_*.md bookkeeping as "changes to
 * verify" and edits them, corrupting the front matter mid-run.
 */
export async function captureDiff(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string> {
    // `:(exclude)<dir>` is a git pathspec that drops everything under the tasks
    // directory from the result, leaving only real source changes to verify.
    const excludeTasks = `:(exclude)${TASKS_DIR_NAME}`
    const run = (args: string[]) =>
        runChildDefault({command: 'git', args}, cwd, signal, {mode: 'text'}, spawnFn)
    const tracked = await run(['diff', 'HEAD', '--', '.', excludeTasks])
    const trackedNames = await run(['diff', 'HEAD', '--name-only', '--', '.', excludeTasks])
    const untracked = await run([
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        '.',
        excludeTasks
    ])

    const parts: string[] = []
    if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0)
        parts.push(`UNIFIED DIFF (modified files):\n${tracked.stdout.trim()}`)

    const lines = (out: {exitCode: number; stdout: string}): string[] =>
        out.exitCode === 0 ?
            out.stdout
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean)
        :   []
    const modified = lines(trackedNames).sort()
    // Untracked-NEW files do NOT appear in the diff above, so they are listed in
    // their own emphatic section: in a flat list the model overlooks them and then
    // emits a false CLEAN while a new file still violates the rules (observed on the
    // local model). A diff-only file (already in `modified`) is not repeated here.
    const newFiles = lines(untracked)
        .filter(n => !modified.includes(n))
        .sort()

    if (modified.length > 0)
        parts.push(
            'MODIFIED FILES — read each in full and check it against the rules:\n'
                + modified.map(n => `- ${n}`).join('\n')
        )
    if (newFiles.length > 0)
        parts.push(
            'NEW FILES — created by this task and NOT shown in the diff above. You MUST'
                + ' read and check each one against EVERY rule too:\n'
                + newFiles.map(n => `- ${n}`).join('\n')
        )
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
