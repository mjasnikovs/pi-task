/**
 * Work verification for /task-auto.
 *
 * The root failure this addresses: pi-task never *runs* any verification. Each
 * task's composed spec carries a VERIFY block (and ACCEPTANCE criteria), but that
 * block is only authored and presence-checked — never executed. The task is then
 * marked `completed` at handoff. So a task whose implementation does not actually
 * work (a SPA that won't build, a route wired to a dead stub, a CI file nobody
 * runs) is indistinguishable from one that does.
 *
 * This pass closes that gap WITHOUT assuming any particular shape of project. It
 * does NOT hardcode `build`, an HTTP probe, a server boot, or a test command —
 * many tasks have none of those. Instead it hands the just-committed spec (GOAL /
 * ACCEPTANCE / VERIFY) to a fresh child of the SAME local model, gives it a `read`
 * and a `bash` tool in the real workspace, and lets the model do its job: run the
 * verification the spec already declares, observe the REAL output, and report a
 * PASS / FAIL verdict. If the spec's VERIFY is legitimately a no-op (config-only
 * change, re-read of a file), the model says so and that is a PASS.
 *
 * It runs as a GATE right after the implementation turn, BEFORE the task is
 * checked off or committed. A FAIL stops the /task-auto run exactly like an
 * implementation failure: the task is left unchecked and uncommitted so
 * /task-auto-resume re-runs it, rather than blessing work that does not run.
 *
 * Tools: `read` + `bash` only. No `edit`/`write` — verification observes, it does
 * not fix (fixing committed work is the enforcement pass's job, and a verify pass
 * that also edits would blur "did it work" with "make it work"). `bash` is what
 * makes this real: it is the difference between reading the VERIFY block and
 * RUNNING it.
 *
 * Gated by the `verifyWork` config flag. With the flag off, or with no spec to
 * verify, this is a pass (ok: true).
 */
import {USER_CANCELLED} from './child-runner.js'

/**
 * The verification child gets exactly two tools: `read` and `bash`.
 *
 *  - `bash` IS the point: it lets the child actually execute the spec's VERIFY
 *    commands (or whatever check the ACCEPTANCE criteria imply) and see the real
 *    exit codes and output, rather than reasoning about whether the code "looks"
 *    correct.
 *  - `read` lets it inspect a file the VERIFY output points at (a build error's
 *    source line, a config it just validated) to characterise a failure precisely.
 *  - No `edit`/`write`: this pass reports a verdict, it does not change the tree.
 *    Keeping it read-only means a verify run can never itself introduce a change
 *    that needs re-verifying, and never scaffolds the junk-file runaway that the
 *    enforce pass had to drop `write` to stop.
 */
const VERIFY_TOOLS = 'read,bash'

export interface VerifyOutcome {
    /** true → the work verified (or verification disabled / nothing to verify).
     *  false → the child reported the work does NOT satisfy its spec, or the pass
     *  could not run / produced no verdict. */
    ok: boolean
    /** Short, human-readable reason. Always set when ok === false; on the pass
     *  path set to the no-op cause ('disabled', 'no spec to verify'). */
    reason?: string
}

/**
 * Slice the delivered spec (GOAL / CONSTRAINTS / ACCEPTANCE / VERIFY) out of a
 * task file body. The composed spec lives under a `## spec` header and runs until
 * the next top-level `## ` section (`## phase timings`). Returns null when no spec
 * section is present (e.g. a task that never reached compose), which the caller
 * treats as a pass — there is nothing to verify against.
 */
export function extractSpecForVerification(taskBody: string): string | null {
    const lines = taskBody.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
        if (/^##\s+spec\s*$/i.test(lines[i])) {
            start = i + 1
            break
        }
    }
    if (start === -1) return null
    let end = lines.length
    for (let i = start; i < lines.length; i++) {
        if (/^##\s+\S/.test(lines[i])) {
            end = i
            break
        }
    }
    const spec = lines.slice(start, end).join('\n').trim()
    return spec.length > 0 ? spec : null
}

/**
 * Build the verification child's prompt. Kept pure so the wording is unit-tested
 * without spawning pi. The contract: run the spec's own verification in the real
 * workspace, judge against ACCEPTANCE, and end on exactly one verdict line.
 */
export function buildVerifyPrompt(spec: string): string {
    return [
        'You are a strict verification pass running right after an AI coding agent',
        'finished a task and committed it. The agent is known to mark work "done"',
        'without ever running it, so DO NOT trust that the implementation works —',
        'prove it by running the verification this task ships with.',
        '',
        'You have a `read` tool and a `bash` tool — nothing else. You can run any',
        'command and read any file, but you CANNOT edit or create files. Your job is',
        'to VERIFY, not to fix.',
        '',
        'THE TASK SPEC (its ACCEPTANCE criteria and VERIFY block are the contract):',
        spec.trim(),
        '',
        'How to verify:',
        "1. Run the commands in the spec's VERIFY block, in order, with your `bash`",
        '   tool, from the repository root. Observe the REAL exit codes and output —',
        '   do not assume success.',
        '2. Treat the ACCEPTANCE criteria as the bar. If a VERIFY command fails, or',
        '   its output contradicts an ACCEPTANCE criterion, the work has NOT verified.',
        '3. If a VERIFY command depends on something this environment genuinely lacks',
        '   (a service, a network resource) and that is clearly an environment gap',
        '   rather than a defect in the code, note it and judge the rest. Do not fail',
        '   the task for a missing external service it cannot control.',
        '4. If the spec legitimately has no runnable verification (a config-only or',
        '   docs-only change whose VERIFY just re-reads or validates a file), running',
        '   that re-read/validation cleanly is a PASS.',
        '5. Do NOT edit anything to make a check pass. Report what you actually saw.',
        '',
        'When you are done, output EXACTLY ONE of these as the final line:',
        '  WORK-VERIFIED: PASS              (every check ran and the work meets its spec)',
        '  WORK-VERIFIED: FAIL <text>      (a check failed or the work does not meet its spec; say what failed)',
        'Output the verdict line verbatim — it is parsed mechanically.'
    ].join('\n')
}

/**
 * Parse the child's verdict. Scans for the LAST `WORK-VERIFIED: PASS|FAIL` marker
 * (the model discusses before concluding, and bash output may echo the word
 * "VERIFY", so a distinct token and last-match win matter).
 *
 * No marker at all is NOT a pass: a verification that cannot state a verdict is a
 * gray area, and the contract is that unverified work is reported as such.
 */
export function parseVerifyVerdict(text: string): {pass: boolean; detail: string} {
    const re = /WORK-VERIFIED:\s*(PASS|FAIL)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {pass: false, detail: 'no verdict emitted'}
    const pass = last[1].toUpperCase() === 'PASS'
    return {pass, detail: pass ? '' : last[2].trim() || 'unspecified failure'}
}

export interface VerificationDeps {
    cwd: string
    signal?: AbortSignal
    /** The composed spec (GOAL/ACCEPTANCE/VERIFY) of the task just committed. When
     *  null/empty the pass is a no-op (ok: true). */
    spec: string | null
    /** Runs the verification child and returns its assistant text. Injected so
     *  the orchestrator wires the real child runner and tests use a fake. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
}

/**
 * Run the verification pass for one task. A missing spec is a pass. Otherwise run
 * the child against the real workspace and turn its verdict into an ok/blocked
 * outcome. Never throws (except a user cancel, which propagates so the loop's
 * USER_CANCELLED handler reports a clean "cancelled — resume").
 */
export async function runWorkVerification(deps: VerificationDeps): Promise<VerifyOutcome> {
    if (!deps.spec || deps.spec.trim().length === 0) {
        return {ok: true, reason: 'no spec to verify'}
    }
    let text: string
    try {
        text = await deps.runChild(VERIFY_TOOLS, buildVerifyPrompt(deps.spec), deps.signal)
    } catch (err) {
        if (err instanceof Error && err.message === USER_CANCELLED) throw err
        const msg = err instanceof Error ? err.message : String(err)
        return {ok: false, reason: `verification pass could not run: ${msg}`}
    }
    const verdict = parseVerifyVerdict(text)
    if (verdict.pass) return {ok: true}
    return {ok: false, reason: `work did not verify: ${verdict.detail}`}
}

export {VERIFY_TOOLS}
