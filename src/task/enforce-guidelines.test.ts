import {expect, test} from 'bun:test'
import {
    discoverGuidelines,
    buildEnforcePrompt,
    parseEnforceVerdict,
    runGuidelineEnforcement,
    classifyEnforceChildFailure,
    GUIDELINE_FILENAMES,
    type EnforceChildResult,
    type GuidelineDoc
} from './enforce-guidelines.js'
import {USER_CANCELLED} from './child-runner.js'

// ─── discoverGuidelines ──────────────────────────────────────────────────────

function fakeReader(files: Record<string, string>) {
    return async (p: string): Promise<string> => {
        const name = p.split('/').pop()!
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

test('classifyEnforceChildFailure: loop-kill is named "looped", NOT user-cancelled', () => {
    // A loop-kill ALSO sets aborted (killProc flips it on every kill path). The
    // specific cause must win over the generic aborted→user-cancel mapping —
    // checking aborted first mislabels the kill as a user cancellation.
    const failure = classifyEnforceChildFailure(childResult({aborted: true, loopHit: 'read x3'}))
    expect(failure).toBe('enforcement child looped')
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

test('classifyEnforceChildFailure: non-zero exit (not aborted) → exited <code>', () => {
    expect(classifyEnforceChildFailure(childResult({exitCode: 2}))).toBe(
        'enforcement child exited 2'
    )
})
