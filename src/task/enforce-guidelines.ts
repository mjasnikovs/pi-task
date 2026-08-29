/**
 * Guideline enforcement for /task-auto.
 *
 * Local models drift: they skip the rules written in AGENTS.md / CLAUDE.md even
 * when those files sit right next to the code. A /task-auto sub-task's work is
 * auto-committed AS SOON AS the implementation turn passes; THEN this runs a
 * fresh child pi (the same local model that did the work) that is handed the
 * project's guideline files and the diff of THAT LAST COMMIT. With read + edit
 * tools (and nothing else) it reads the committed files, fixes any violations in
 * place, and reports a CLEAN / VIOLATION verdict. It cannot create files or run
 * anything: no `write` (so it can't scaffold junk) and no `grep`/`find`/`ls` (so it
 * can't roam the tree) — see ENFORCE_TOOLS.
 *
 * The fixes it makes are committed SEPARATELY by the orchestrator under an
 * "ENFORCE GUIDELINES" commit, so guideline corrections are an independent,
 * auditable diff that sits on top of the task commit. A VIOLATION it could not
 * fix (or a pass that cannot confirm CLEAN) is surfaced as a warning — the task
 * commit already landed, so the run continues rather than pausing. The outcome's
 * `ok` flag therefore drives a warn-or-not decision, not a hard gate.
 *
 * Gated by the `enforceGuidelines` config flag. With the flag off, or with no
 * guideline files in the working directory, enforcement is a pass (ok: true).
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {SpawnFn} from '../shared/child-process.js'
import {makeGit} from '../shared/git-runner.js'
import {USER_CANCELLED} from './child-runner.js'
import {classifyWorkerFailure, type WorkerFailureInput} from '../workers/worker-failure.js'
import {TASKS_DIR_NAME} from './task-types.js'
import {findProbeGamingInDiff} from './probe-gaming.js'

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
 *    handed the explicit, closed list of changed files (see captureCommitDiff) and is
 *    told to edit only those.
 *  - `read` IS allowed: the model genuinely needs it — to re-read a file after
 *    editing to confirm the fix landed, and to read a neighbouring file for the
 *    correct import/type when bringing the change into compliance (without it the
 *    model fabricates imports — validated against the local model). `read` has no
 *    per-path sandbox in pi, so "only the changed files" is enforced for EDITS
 *    (the prompt scopes them) but is a soft instruction for READS.
 */
const ENFORCE_TOOLS = 'read,edit'

/**
 * Flag-only enforcement gets exactly ONE tool: `read`. It can inspect the changed
 * files and report violations but CANNOT edit, create, or run anything.
 *
 * This is the "no signal ⇒ no license to rewrite logic" half of the gate. When a
 * task ships no behavioral verification to guard a destructive edit (no runnable
 * VERIFY, or the verify gate did not produce a genuine clean pass), letting the
 * weak model rewrite working code is exactly what trashes the build. With
 * `read,edit` and no guard it degrades a clean tree while declaring CLEAN. Demoted to `read`, it cannot trash anything and still names the real
 * violation. So with no signal to revert against, the
 * pass reports the violation as a warning instead of editing.
 */
const ENFORCE_FLAG_TOOLS = 'read'

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
 * Render the deterministic probe-gaming findings as a prompt block, or
 * an empty array when there are none. Shared by the edit and flag prompts: the
 * finding is a concrete diff line whose stated purpose is to make a check pass
 * rather than meet the requirement — the reliable lever the prompt rule leans on.
 * The `action` line differs (fix vs report) between the two capability modes.
 */
function probeGamingEnforceBlock(findings: string[], action: string): string[] {
    if (findings.length === 0) return []
    return [
        'CHECK-GAMING NOTICE (deterministic, computed from the diff): these added lines',
        'state their own purpose is to make a CHECK pass (a test / verification / lint /',
        'gate), not to meet the requirement the check stands for:',
        ...findings.map(f => `- ${f}`),
        'A check is a MESSENGER for a requirement; code written only to quiet the messenger',
        'is a defect even when the check is green (run-8 F6: a handler returned 401 "so the',
        `verification test passes" while the real route stayed dead). ${action}`,
        ''
    ]
}

/**
 * Build the enforcement child's prompt: the rules, the diff of the work just
 * done, and the contract for the final verdict line. Kept pure so the wording
 * is unit-tested without spawning pi.
 */
export function buildEnforcePrompt(
    rulesText: string,
    diff: string,
    probeGamingFindings: string[] = []
): string {
    return [
        'You are a strict guideline-enforcement pass running right after an AI coding',
        'agent finished a task and committed it. The agent is known to skip project',
        'rules, so do not trust that it followed them — verify against the changes.',
        '',
        'You have a `read` tool and an `edit` tool — nothing else. You CANNOT run',
        'commands, run lint/tsc/tests, or create files. Read the changed files listed',
        'below to inspect them; you may also read a neighbouring file when you need the',
        'correct import or type. But EDIT ONLY the changed files listed below — do not',
        'create new files and do not modify anything outside that set. Your fixes will',
        'be committed separately, so make them count.',
        '',
        'PROJECT GUIDELINES (from this repository):',
        rulesText,
        '',
        'CHANGES IN THE LAST COMMIT (verify these specifically against the rules):',
        diff.trim().length > 0 ? diff : '(no textual diff captured — nothing to verify)',
        '',
        ...probeGamingEnforceBlock(
            probeGamingFindings,
            'Treat this as a violation: replace the check-gaming code with a real'
                + ' implementation of the requirement, or if you cannot, report it as a'
                + ' VIOLATION naming the gamed check.'
        ),
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
 * Build the FLAG-ONLY enforcement prompt: same rules + diff, but the child has a
 * `read` tool only and is told to REPORT violations, not fix them. Kept pure so
 * the wording is unit-tested without spawning pi. Used when there is no
 * verification signal to guard a destructive edit (see ENFORCE_FLAG_TOOLS).
 */
export function buildEnforceFlagPrompt(
    rulesText: string,
    diff: string,
    probeGamingFindings: string[] = []
): string {
    return [
        'You are a strict guideline-enforcement REVIEW pass running right after an AI',
        'coding agent finished a task and committed it. The agent is known to skip',
        'project rules, so do not trust that it followed them — verify against the',
        'changes.',
        '',
        'You have a `read` tool — and NOTHING else. You CANNOT edit, create, or run',
        'anything. Your job is to REVIEW and REPORT, not to fix.',
        '',
        'PROJECT GUIDELINES (from this repository):',
        rulesText,
        '',
        'CHANGES IN THE LAST COMMIT (review these specifically against the rules):',
        diff.trim().length > 0 ? diff : '(no textual diff captured — nothing to verify)',
        '',
        ...probeGamingEnforceBlock(
            probeGamingFindings,
            'Treat this as a violation and REPORT it (do not fix it): name the gamed check'
                + ' and the requirement left unmet.'
        ),
        'Read each changed file and check it against EVERY rule above. Do NOT attempt',
        'to fix anything — only report what you find.',
        '',
        'When you are done, output EXACTLY ONE of these as the final line:',
        '  ENFORCE: CLEAN              (the changes comply with every rule)',
        '  ENFORCE: VIOLATION <text>  (a rule is violated; say which — do not fix it)',
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
export interface EnforceChildResult extends WorkerFailureInput {
    text: string
}

/**
 * Map the enforcement child's runWorker result to a fatal error message, or null
 * when it finished cleanly enough to parse a verdict from its text.
 *
 * The ORDER is load-bearing and no longer lives here: every kill path also sets
 * `aborted` and a non-zero exit, so the specific causes must be matched before
 * the generic ones, and that precedence is stated once in `classifyWorkerFailure`
 * (workers/worker-failure.ts). This function is now only the enforce-specific
 * half — what each cause MEANS to guideline enforcement.
 *
 * Writing the ladder out by hand here is exactly what cost us the stream-stall
 * bug: `streamStalled` was added to the worker result and to `finalAttemptFailed`
 * but never to this ladder, so a child killed for a dead model stream fell
 * through to `aborted → USER_CANCELLED` and a hung backend was reported to the
 * user as their own cancel. The switch below is exhaustive, so the next cause
 * added to the union is a compile error here rather than a silent mislabel.
 *
 * A loop is NOT fatal: enforce attaches the detector in nudge-then-warn mode, so a
 * loop that survived its restart-with-hint nudges returns null here (the caller
 * logs/notifies it as a warning) and the verdict gate alone decides the outcome.
 * It still has to be matched before `aborted`/`exitCode` so the kill's side
 * effects don't get re-classified as a user cancel or a crash.
 */
export function classifyEnforceChildFailure(r: EnforceChildResult): string | null {
    const failure = classifyWorkerFailure(r)
    if (!failure) return null
    switch (failure.kind) {
        case 'stalled':
            // Otherwise a long silence is reported as a user cancel.
            return 'model server unreachable — the child produced no output and the model endpoint did not respond'
        case 'command-timeout': {
            // Its text is truncated mid-run — the verdict in it is partial and
            // must never be parsed as a real one.
            const mins = Math.max(1, Math.round(failure.timeoutMs / 60_000))
            return (
                `child ran a \`${failure.toolName}\` command that had not returned after `
                + `${mins} minute${mins === 1 ? '' : 's'} and was killed — it never bounded the command`
            )
        }
        case 'stream-stall': {
            // The arm this ladder was missing. Same class as the two above: a
            // watchdog, not the model, ended the run, and the text is partial.
            const secs = Math.max(1, Math.round(failure.idleMs / 1000))
            return (
                `model stream went silent for ${secs}s with no tool running and the child was `
                + 'killed — the backend stopped producing, the child did not stop working'
            )
        }
        case 'worker-timeout':
            return 'enforcement child timed out'
        case 'loop':
            return null // looped past the nudges → warning, handled by caller
        case 'leaked-tool-call':
            return 'enforcement child leaked a tool call'
        case 'aborted':
            return USER_CANCELLED
        case 'exit':
            return `enforcement child exited ${failure.code}`
    }
}

/**
 * The git "empty tree" object — the canonical base for diffing a ROOT commit
 * (one with no parent). Diffing `HEAD` against it renders the whole first commit
 * as additions, so a root commit still produces a verifiable diff.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * Capture the LAST COMMIT's work to verify as text: the unified diff of HEAD
 * against its parent followed by the list of files that commit changed — the set
 * the child should read and is allowed to edit.
 *
 * This runs AFTER the task's auto-commit, so the change set is whatever HEAD
 * introduced (`HEAD~1..HEAD`). New files created by the task appear in that diff
 * as additions, so — unlike the pre-commit working-tree capture this replaced —
 * there is no separate untracked/new-files section to chase. On a root commit
 * (no `HEAD~1`) the diff is taken against the empty tree so the first commit is
 * still fully verifiable.
 *
 * The child has a `read` tool, so file contents are NOT inlined here: it reads
 * each listed file itself (and re-reads after editing to confirm). The list is the
 * scoping signal — it tells the model the closed set of files to touch so it edits
 * only the change set rather than roaming.
 *
 * The `.pi-tasks/` directory is excluded from every git command. Those task files
 * are committable (tracked) by design, so they ride into the commit's diff — git
 * does not honor the fd/ripgrep `.ignore` that keeps them out of the worker's
 * find/grep discovery. Without this pathspec the enforce child is handed its own
 * TASK_*.md / TASK_AUTO_*.md bookkeeping as "changes to verify" and edits them,
 * corrupting the front matter mid-run.
 */
export async function captureCommitDiff(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string> {
    // `:(exclude)<dir>` is a git pathspec that drops everything under the tasks
    // directory from the result, leaving only real source changes to verify.
    const excludeTasks = `:(exclude)${TASKS_DIR_NAME}`
    const run = makeGit(cwd, signal, spawnFn)

    // Diff the last commit against its parent. On a root commit there is no
    // HEAD~1 (rev-parse exits non-zero), so fall back to the empty tree.
    const parent = await run(['rev-parse', '--verify', '--quiet', 'HEAD~1'])
    const base = parent.exitCode === 0 ? 'HEAD~1' : EMPTY_TREE

    const diff = await run(['diff', base, 'HEAD', '--', '.', excludeTasks])
    const names = await run(['diff', base, 'HEAD', '--name-only', '--', '.', excludeTasks])

    const parts: string[] = []
    if (diff.exitCode === 0 && diff.stdout.trim().length > 0)
        parts.push(`UNIFIED DIFF (last commit):\n${diff.stdout.trim()}`)

    const changed =
        names.exitCode === 0 ?
            names.stdout
                .split('\n')
                .map(s => s.trim())
                .filter(Boolean)
                .sort()
        :   []
    if (changed.length > 0)
        parts.push(
            'FILES CHANGED IN THE LAST COMMIT — read each in full and check it against'
                + ' EVERY rule:\n'
                + changed.map(n => `- ${n}`).join('\n')
        )
    return parts.join('\n\n')
}

export interface EnforcementDeps {
    cwd: string
    signal?: AbortSignal
    /**
     * Which capability the pass runs with.
     *  - `'edit'` (default): `read,edit` — the model fixes violations in place. The
     *    caller is responsible for guarding those edits with a differential
     *    verification check (revert on regression), because a bare edit pass
     *    trashes working code.
     *  - `'flag'`: `read` only — the model reports violations but cannot touch the
     *    tree. Used when there is no verification signal to guard an edit against.
     */
    mode?: 'edit' | 'flag'
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
    const getDiff = deps.getDiff ?? ((cwd, signal) => captureCommitDiff(cwd, signal))

    const doc = await discover(deps.cwd)
    if (!doc) return {ok: true, reason: 'no guideline files'}

    const diff = await getDiff(deps.cwd, deps.signal)
    // Deterministic probe-gaming findings (F6) straight from the captured diff — no
    // extra git call, the diff is already in hand. Injected under the CHECK-GAMING
    // rule so the child acts on a concrete line, not on self-discovered intent.
    const probeGaming = findProbeGamingInDiff(diff)
    const flagOnly = deps.mode === 'flag'
    const tools = flagOnly ? ENFORCE_FLAG_TOOLS : ENFORCE_TOOLS
    const prompt =
        flagOnly ?
            buildEnforceFlagPrompt(doc.text, diff, probeGaming)
        :   buildEnforcePrompt(doc.text, diff, probeGaming)
    let text: string
    try {
        text = await deps.runChild(tools, prompt, deps.signal)
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

export {ENFORCE_TOOLS, ENFORCE_FLAG_TOOLS}
