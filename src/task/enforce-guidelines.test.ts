import {expect, test} from 'bun:test'
import {EventEmitter} from 'node:events'
import {basename} from 'node:path'
import {
    captureCommitDiff,
    discoverGuidelines,
    buildEnforcePrompt,
    buildEnforceFlagPrompt,
    parseEnforceVerdict,
    runGuidelineEnforcement,
    classifyEnforceChildFailure,
    ENFORCE_TOOLS,
    ENFORCE_FLAG_TOOLS,
    GUIDELINE_FILENAMES,
    type EnforceChildResult,
    type GuidelineDoc
} from './enforce-guidelines.js'
import type {ProcLike, SpawnFn} from '../shared/child-process.js'
import {USER_CANCELLED} from './child-runner.js'

// ─── discoverGuidelines ──────────────────────────────────────────────────────

function fakeReader(files: Record<string, string>) {
    return async (p: string): Promise<string> => {
        // discoverGuidelines builds the path with path.join → native separators
        // on Windows; basename handles both '/' and '\'.
        const name = basename(p)
        if (name in files) return files[name]
        throw new Error('ENOENT')
    }
}

test('discoverGuidelines: returns null when neither file exists', async () => {
    const doc = await discoverGuidelines('/repo', fakeReader({}))
    expect(doc).toBeNull()
})

test('discoverGuidelines: returns null when files exist but are empty/whitespace', async () => {
    const doc = await discoverGuidelines(
        '/repo',
        fakeReader({'AGENTS.md': '  \n\n', 'CLAUDE.md': ''})
    )
    expect(doc).toBeNull()
})

test('discoverGuidelines: collects both files in canonical order under name headers', async () => {
    const doc = (await discoverGuidelines(
        '/repo',
        fakeReader({'CLAUDE.md': 'claude rule', 'AGENTS.md': 'agents rule'})
    )) as GuidelineDoc
    // AGENTS.md is listed first regardless of read order (canonical GUIDELINE_FILENAMES order).
    expect(doc.files).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(doc.text).toBe('## AGENTS.md\n\nagents rule\n\n## CLAUDE.md\n\nclaude rule')
})

test('discoverGuidelines: a single present file is enough', async () => {
    const doc = (await discoverGuidelines(
        '/repo',
        fakeReader({'AGENTS.md': 'only agents'})
    )) as GuidelineDoc
    expect(doc.files).toEqual(['AGENTS.md'])
    expect(doc.text).toBe('## AGENTS.md\n\nonly agents')
})

test('GUIDELINE_FILENAMES is exactly AGENTS.md and CLAUDE.md', () => {
    expect([...GUIDELINE_FILENAMES]).toEqual(['AGENTS.md', 'CLAUDE.md'])
})

// ─── buildEnforcePrompt ──────────────────────────────────────────────────────

test('buildEnforcePrompt: embeds rules, diff, and the verdict contract', () => {
    const p = buildEnforcePrompt('## AGENTS.md\n\nno print()', 'diff --git a/x b/x')
    expect(p).toContain('no print()')
    expect(p).toContain('diff --git a/x b/x')
    expect(p).toContain('ENFORCE: CLEAN')
    expect(p).toContain('ENFORCE: VIOLATION')
})

test('buildEnforcePrompt: notes an empty diff instead of leaving a blank', () => {
    const p = buildEnforcePrompt('rules', '')
    expect(p).toContain('no textual diff captured')
})

test('buildEnforcePrompt: states the read+edit / no-run / no-create / edit-only-changed contract', () => {
    // The local model spirals into scratch "runner" files when it thinks it can run
    // checks; the prompt must tell it plainly that it cannot, matching ENFORCE_TOOLS.
    const p = buildEnforcePrompt('rules', 'diff')
    expect(p).toContain('`read`')
    expect(p).toContain('`edit`')
    expect(p).toMatch(/cannot|CANNOT/)
    expect(p).toContain('create')
    // It must scope EDITS to the changed files even though read is broader.
    expect(p).toMatch(/EDIT ONLY|only the changed files|do not modify anything outside/i)
})

test('buildEnforcePrompt: injects CHECK-GAMING findings with a fix directive (F6)', () => {
    const findings = [
        'src/server/index.ts: this task added a line stating its purpose is to make a '
            + 'check pass — "// Return 401 so the verification test passes"'
    ]
    const p = buildEnforcePrompt('rules', 'diff', findings)
    expect(p).toContain('CHECK-GAMING NOTICE')
    expect(p).toContain('- src/server/index.ts: this task added a line')
    expect(p).toMatch(/replace the check-gaming code|report it as a\s+VIOLATION/i)
    // No findings → no block.
    expect(buildEnforcePrompt('rules', 'diff', [])).not.toContain('CHECK-GAMING NOTICE')
    expect(buildEnforcePrompt('rules', 'diff')).not.toContain('CHECK-GAMING NOTICE')
})

test('buildEnforceFlagPrompt: injects CHECK-GAMING findings with a report directive (F6)', () => {
    const findings = ['a.ts: ... — "// to satisfy the linter"']
    const p = buildEnforceFlagPrompt('rules', 'diff', findings)
    expect(p).toContain('CHECK-GAMING NOTICE')
    expect(p).toMatch(/REPORT it|do not fix/i)
    expect(buildEnforceFlagPrompt('rules', 'diff', [])).not.toContain('CHECK-GAMING NOTICE')
})

test('ENFORCE_TOOLS is read,edit — no write (no new files), no grep/find/ls (no roaming)', () => {
    // Validated against the local model: with no write the pass cannot create files
    // (edit ENOENTs), and read is kept because the model needs to re-read its edits
    // and read neighbours for correct imports/types (else it fabricates them).
    expect(ENFORCE_TOOLS).toBe('read,edit')
    expect(ENFORCE_TOOLS).not.toContain('write')
    expect(ENFORCE_TOOLS).not.toContain('grep')
})

// ─── flag-only mode (no signal ⇒ no license to rewrite) ──────────────────────

test('ENFORCE_FLAG_TOOLS is read only — flag-only cannot edit/write/run', () => {
    // A/B-proven: with no verification signal to guard against, demoting the pass to
    // read-only is what stops it trashing working code (4/5 → 0/5).
    expect(ENFORCE_FLAG_TOOLS).toBe('read')
    expect(ENFORCE_FLAG_TOOLS).not.toContain('edit')
    expect(ENFORCE_FLAG_TOOLS).not.toContain('write')
})

test("buildEnforceFlagPrompt: read-only, report-don't-fix, same verdict contract", () => {
    const p = buildEnforceFlagPrompt('## AGENTS.md\n\nno print()', 'diff --git a/x b/x')
    expect(p).toContain('no print()')
    expect(p).toContain('diff --git a/x b/x')
    expect(p).toContain('`read`')
    expect(p).not.toContain('`edit`')
    expect(p).toMatch(/CANNOT edit|cannot edit|REVIEW and REPORT|do not.*fix|not to fix/i)
    expect(p).toContain('ENFORCE: CLEAN')
    expect(p).toContain('ENFORCE: VIOLATION')
})

test('runGuidelineEnforcement: mode "flag" runs the read-only child with the flag prompt', async () => {
    let usedTools = ''
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        mode: 'flag',
        discover: async () => docOf('rules'),
        getDiff: async () => 'the diff',
        runChild: async (tools, prompt) => {
            usedTools = tools
            // The flag prompt forbids fixing — it must NOT offer the edit tool.
            expect(prompt).not.toContain('`edit`')
            return 'ENFORCE: VIOLATION duplicated JSX'
        }
    })
    expect(usedTools).toBe(ENFORCE_FLAG_TOOLS)
    expect(r).toEqual({ok: false, reason: 'guideline violation: duplicated JSX'})
})

test('runGuidelineEnforcement: default mode is edit (read,edit child)', async () => {
    let usedTools = ''
    await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'd',
        runChild: async tools => {
            usedTools = tools
            return 'ENFORCE: CLEAN'
        }
    })
    expect(usedTools).toBe(ENFORCE_TOOLS)
})

test('runGuidelineEnforcement: computes probe-gaming findings from the captured diff (F6)', async () => {
    let sawPrompt = ''
    await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () =>
            [
                '+++ b/src/server/index.ts',
                '+// Return 401 so the verification test passes',
                '+app.get("/api/auth", c => c.json({}, 401))'
            ].join('\n'),
        runChild: async (_tools, prompt) => {
            sawPrompt = prompt
            return 'ENFORCE: CLEAN'
        }
    })
    expect(sawPrompt).toContain('CHECK-GAMING NOTICE')
    expect(sawPrompt).toContain('src/server/index.ts')
})

test('runGuidelineEnforcement: no gaming in the diff → no CHECK-GAMING block', async () => {
    let sawPrompt = ''
    await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => '+++ b/a.ts\n+export const add = (a, b) => a + b',
        runChild: async (_tools, prompt) => {
            sawPrompt = prompt
            return 'ENFORCE: CLEAN'
        }
    })
    expect(sawPrompt).not.toContain('CHECK-GAMING NOTICE')
})

// ─── parseEnforceVerdict ─────────────────────────────────────────────────────

test('parseEnforceVerdict: CLEAN verdict', () => {
    expect(parseEnforceVerdict('did some checks\nENFORCE: CLEAN')).toEqual({
        clean: true,
        detail: ''
    })
})

test('parseEnforceVerdict: VIOLATION carries the trailing detail', () => {
    expect(parseEnforceVerdict('ENFORCE: VIOLATION missing docstring in add()')).toEqual({
        clean: false,
        detail: 'missing docstring in add()'
    })
})

test('parseEnforceVerdict: case-insensitive and takes the LAST marker', () => {
    // A model that reconsiders: the final verdict wins.
    const text = 'enforce: violation early thought\nfixed it\nENFORCE: CLEAN'
    expect(parseEnforceVerdict(text)).toEqual({clean: true, detail: ''})
})

test('parseEnforceVerdict: no marker is NOT clean (no gray areas)', () => {
    expect(parseEnforceVerdict('I think it looks fine to me')).toEqual({
        clean: false,
        detail: 'no verdict emitted'
    })
})

test('parseEnforceVerdict: bare VIOLATION gets a placeholder detail', () => {
    expect(parseEnforceVerdict('ENFORCE: VIOLATION')).toEqual({
        clean: false,
        detail: 'unspecified violation'
    })
})

// ─── runGuidelineEnforcement ─────────────────────────────────────────────────

const docOf = (text: string): GuidelineDoc => ({files: ['AGENTS.md'], text})

test('runGuidelineEnforcement: no guideline files → pass without running a child', async () => {
    let ran = false
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => null,
        getDiff: async () => 'diff',
        runChild: async () => {
            ran = true
            return 'ENFORCE: CLEAN'
        }
    })
    expect(r).toEqual({ok: true, reason: 'no guideline files'})
    expect(ran).toBe(false)
})

test('runGuidelineEnforcement: CLEAN verdict → ok', async () => {
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'the diff',
        runChild: async (_tools, prompt) => {
            // The child must receive the rules and the diff.
            expect(prompt).toContain('rules')
            expect(prompt).toContain('the diff')
            return 'fixed two things\nENFORCE: CLEAN'
        }
    })
    expect(r).toEqual({ok: true})
})

test('runGuidelineEnforcement: VIOLATION verdict → blocks with reason', async () => {
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'd',
        runChild: async () => 'ENFORCE: VIOLATION still using print()'
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('guideline violation: still using print()')
})

test('runGuidelineEnforcement: no verdict from child → blocks (cannot confirm clean)', async () => {
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'd',
        runChild: async () => 'looks ok to me'
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('guideline violation: no verdict emitted')
})

test('runGuidelineEnforcement: child failure → blocks (unverifiable)', async () => {
    const r = await runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'd',
        runChild: async () => {
            throw new Error('enforcement child timed out')
        }
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('enforcement pass could not run: enforcement child timed out')
})

test('runGuidelineEnforcement: a user cancel re-throws (not wrapped as a failure)', async () => {
    // USER_CANCELLED must propagate so the /task-auto loop reports a clean
    // "cancelled — resume", not "enforcement pass could not run".
    const run = runGuidelineEnforcement({
        cwd: '/repo',
        discover: async () => docOf('rules'),
        getDiff: async () => 'd',
        runChild: async () => {
            throw new Error(USER_CANCELLED)
        }
    })
    await expect(run).rejects.toThrow(USER_CANCELLED)
})

// ─── classifyEnforceChildFailure ─────────────────────────────────────────────

function childResult(over: Partial<EnforceChildResult>): EnforceChildResult {
    return {text: 'ENFORCE: CLEAN', exitCode: 0, aborted: false, ...over}
}

test('classifyEnforceChildFailure: clean run → null (verdict is parsable)', () => {
    expect(classifyEnforceChildFailure(childResult({}))).toBeNull()
})

test('classifyEnforceChildFailure: loop is non-fatal (warning), NOT user-cancelled', () => {
    // A loop-kill ALSO sets aborted (killProc flips it on every kill path). Enforce
    // attaches the detector in nudge-then-warn mode, so a surviving loop is null
    // here (the caller warns) — but it must still be matched BEFORE the generic
    // aborted→user-cancel mapping so the kill isn't mislabeled as a user cancel.
    const failure = classifyEnforceChildFailure(childResult({aborted: true, loopHit: 'read x3'}))
    expect(failure).toBeNull()
    expect(failure).not.toBe(USER_CANCELLED)
})

test('classifyEnforceChildFailure: timeout (also aborted) is named "timed out"', () => {
    const failure = classifyEnforceChildFailure(childResult({aborted: true, timedOut: true}))
    expect(failure).toBe('enforcement child timed out')
})

test('classifyEnforceChildFailure: leaked tool call (also aborted) is named "leaked"', () => {
    const failure = classifyEnforceChildFailure(
        childResult({aborted: true, leakedToolCall: 'edit{...}'})
    )
    expect(failure).toBe('enforcement child leaked a tool call')
})

test('classifyEnforceChildFailure: aborted with no specific cause → user-cancelled', () => {
    expect(classifyEnforceChildFailure(childResult({aborted: true}))).toBe(USER_CANCELLED)
})

test('classifyEnforceChildFailure: stream-stall kill (also aborted) names the hung stream, NOT a cancel', () => {
    // REGRESSION. streamStalled was added to the worker result and to
    // finalAttemptFailed but never to this ladder, so a child killed for a model
    // stream that went silent fell past every arm to `aborted → USER_CANCELLED`
    // and a dead backend was reported to the user as their own cancel. The ladder
    // is now one exhaustive switch over classifyWorkerFailure, so the next cause
    // added to the union is a compile error here instead of a silent mislabel.
    const failure = classifyEnforceChildFailure(
        childResult({aborted: true, exitCode: 143, streamStalled: {idleMs: 120_000}})
    )
    expect(failure).not.toBe(USER_CANCELLED)
    expect(failure).toContain('120s')
    expect(failure).toContain('stream')
})

test('classifyEnforceChildFailure: stall-kill (also aborted) names the dead backend, NOT a cancel', () => {
    const failure = classifyEnforceChildFailure(childResult({aborted: true, stalled: true}))
    expect(failure).toContain('model server unreachable')
    expect(failure).not.toBe(USER_CANCELLED)
})

test('classifyEnforceChildFailure: command-watchdog kill (also aborted) names the hung command, NOT a cancel', () => {
    // The command watchdog kills the child through its abort signal, so `aborted`
    // is set exactly as it is for a stall-kill. Reported as a user cancel, a gate
    // child wedged on an unbounded `bun run dev` would look like the USER stopped
    // it — and its truncated text could be parsed as a real verdict.
    const failure = classifyEnforceChildFailure(
        childResult({aborted: true, commandTimedOut: {toolName: 'bash', timeoutMs: 900_000}})
    )
    expect(failure).toContain('bash')
    expect(failure).toContain('15 minutes')
    expect(failure).not.toBe(USER_CANCELLED)
})

test('classifyEnforceChildFailure: non-zero exit (not aborted) → exited <code>', () => {
    expect(classifyEnforceChildFailure(childResult({exitCode: 2}))).toBe(
        'enforcement child exited 2'
    )
})

// ─── captureCommitDiff ───────────────────────────────────────────────────────

/**
 * A fake SpawnFn that records every git invocation's args and replays a queued
 * stdout (and optional exit code) for each. Lets us assert what range/pathspec
 * captureCommitDiff hands git without a real repo. Exit code defaults to 0; pass
 * `exits` to make a specific call (e.g. the HEAD~1 rev-parse) fail.
 */
function recordingSpawn(
    stdouts: string[],
    exits: number[] = []
): {spawn: SpawnFn; calls: string[][]} {
    const calls: string[][] = []
    let i = 0
    const spawn: SpawnFn = (_command, args) => {
        const idx = i++
        calls.push([...args])
        const out = stdouts[idx] ?? ''
        const code = exits[idx] ?? 0
        const proc = new EventEmitter() as unknown as ProcLike & EventEmitter
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        ;(proc as unknown as {stdout: EventEmitter}).stdout = stdout
        ;(proc as unknown as {stderr: EventEmitter}).stderr = stderr
        ;(proc as unknown as {kill: () => void}).kill = () => {}
        ;(proc as unknown as {killed: boolean}).killed = false
        queueMicrotask(() => {
            if (out.length > 0) stdout.emit('data', Buffer.from(out))
            proc.emit('close', code)
        })
        return proc
    }
    return {spawn, calls}
}

test('captureCommitDiff: diffs HEAD~1..HEAD and excludes .pi-tasks from every git command', async () => {
    // The pass runs AFTER the task commit, so it verifies the last commit's diff
    // (HEAD against its parent). Committable TASK_*/TASK_AUTO_*.md files ride into
    // that diff (git ignores the fd/ripgrep .ignore), so without the pathspec the
    // enforce child is handed its own task bookkeeping and edits it.
    // Calls: [0] rev-parse HEAD~1 (parent exists), [1] diff, [2] name-only.
    const {spawn, calls} = recordingSpawn(['<sha>', 'diff body', 'src/a.ts'])
    await captureCommitDiff('/repo', undefined, spawn)

    expect(calls).toHaveLength(3)
    expect(calls[0]).toEqual(['rev-parse', '--verify', '--quiet', 'HEAD~1'])
    expect(calls[1]).toEqual(['diff', 'HEAD~1', 'HEAD', '--', '.', ':(exclude).pi-tasks'])
    expect(calls[2]).toEqual([
        'diff',
        'HEAD~1',
        'HEAD',
        '--name-only',
        '--',
        '.',
        ':(exclude).pi-tasks'
    ])
})

test('captureCommitDiff: a root commit (no HEAD~1) diffs against the empty tree', async () => {
    // rev-parse exits non-zero when there is no parent; the base becomes the git
    // empty-tree object so the first commit still renders fully as additions.
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
    const {spawn, calls} = recordingSpawn(['', 'diff body', 'src/a.ts'], [1, 0, 0])
    await captureCommitDiff('/repo', undefined, spawn)
    expect(calls[1]).toEqual(['diff', EMPTY_TREE, 'HEAD', '--', '.', ':(exclude).pi-tasks'])
    expect(calls[2]).toEqual([
        'diff',
        EMPTY_TREE,
        'HEAD',
        '--name-only',
        '--',
        '.',
        ':(exclude).pi-tasks'
    ])
})

test('captureCommitDiff: emits the unified diff and one sorted list of changed files', async () => {
    // New files created by the task are additions in the commit diff, so there is
    // no separate untracked section — one closed list scopes the child's edits.
    const {spawn} = recordingSpawn(['<sha>', 'the diff text', 'src/svc.ts\nsrc/app.ts'])
    const out = await captureCommitDiff('/repo', undefined, spawn)
    expect(out).toContain('UNIFIED DIFF (last commit)')
    expect(out).toContain('the diff text')
    expect(out).toContain('FILES CHANGED IN THE LAST COMMIT')
    // Sorted, one bullet each.
    expect(out.indexOf('- src/app.ts')).toBeLessThan(out.indexOf('- src/svc.ts'))
    // Contents are NOT inlined — the child has a read tool and reads them itself.
    expect(out).not.toContain('FULL CURRENT CONTENT')
})

test('captureCommitDiff: an empty commit → empty string (nothing to verify)', async () => {
    const {spawn} = recordingSpawn(['<sha>', '', ''])
    expect(await captureCommitDiff('/repo', undefined, spawn)).toBe('')
})
