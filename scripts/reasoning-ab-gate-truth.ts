/**
 * GROUND TRUTH FOR THE GATE GROUP — what a correct verify child must answer.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The gate cell has now been measured twice and both times the axis was
 * saturated, which means it could not have separated the arms whatever they did:
 *
 *   scorer 1  /\b(PASS|FAIL)\b/ over a hand-written prompt   37/40 usable
 *   scorer 2  emittedVerdict, production's own parser        10/10 usable
 *
 * Scorer 2 is CORRECT and still useless. It asks "did the child state a verdict
 * at all", and a competent model states one every time. The old comment beside
 * it explained why the verdict itself was not scored: the trials replayed
 * recorded specs against one corpus tree that may or may not contain the work,
 * so a FAIL was a fact about the tree rather than about the arm. That reasoning
 * is right, and the fix is not to stop scoring the verdict — it is to STOP
 * GUESSING WHICH TREE. Hand the child a tree whose correct answer is known.
 *
 * WHAT A KNOWN ANSWER LOOKS LIKE
 * ------------------------------
 * The recorded run brackets every task with two commits: the tree the turn
 * started from and the tree it shipped. `impl-ab-corpus.ts` already extracts
 * both and runs the task's own VERIFY script in either. So for a screened task:
 *
 *   before-tree   VERIFY fails   ⇒ the only correct verdict is FAIL
 *   after-tree    VERIFY passes  ⇒ the only correct verdict is PASS
 *
 * The base rate is 50/50 BY CONSTRUCTION, so a child that always says PASS
 * scores 50%, and so does one that always says FAIL. Neither the ceiling nor
 * the floor is reachable by a degenerate answer. That is the property both
 * previous gate scorers lacked.
 *
 * THE SCREEN IS THE WHOLE POINT AND IT IS NOT OPTIONAL.
 * A VERIFY that passes on the before-tree proves nothing was required, and a
 * VERIFY that fails on the after-tree is a broken script, not a failed turn.
 * MEASURED on this corpus by the implementation run: only 20 of 51 tasks
 * survive. Screening is what makes the remaining 20 a ground truth instead of
 * an assumption — see [[ab-verify-must-fail-before]].
 *
 * No model is involved in anything in this file.
 */
import fs from 'node:fs'
import path from 'node:path'
import {implTasks, extractTree, runVerify, type ImplTask} from './impl-ab-corpus.js'

/** One (task, tree) pair whose correct verify verdict is known. */
export interface GateStimulus {
    /** `TASK_0002`. */
    id: string
    /** Which of the task's two trees this is. */
    condition: 'before' | 'after'
    /** The commit to extract for this trial. */
    commit: string
    /** The `## spec` the real verify child was handed. */
    spec: string
    /** The word `parseVerifyVerdict` must produce for this trial to score. */
    truth: 'PASS' | 'FAIL'
}

/** What the screen decided about one task, so the log can say why. */
export interface ScreenOutcome {
    id: string
    usable: boolean
    detail: string
}

/**
 * Extract a task's two trees, run its VERIFY in each, and say whether the pair
 * is a usable ground truth.
 *
 * A task is usable ONLY when VERIFY fails before and passes after. Anything else
 * — passes before, fails after, or both — means the script does not discriminate
 * the work, and a trial built on it would score the child against noise.
 */
export function screenTask(
    t: ImplTask,
    treeRoot: string,
    verifyTimeoutMs: number
): ScreenOutcome {
    const after = path.join(treeRoot, `${t.id}-after`)
    const before = path.join(treeRoot, `${t.id}-before`)
    try {
        extractTree(t.postCommit, after)
        const a = runVerify(t.verify, after, verifyTimeoutMs)
        if (!a.pass) {
            return {
                id: t.id,
                usable: false,
                // The scorer, not the turn, is what failed here: this VERIFY
                // cannot pass on the work the real run actually shipped.
                detail: `VERIFY fails on the SHIPPED tree (exit ${a.exitCode}) — broken scorer`
            }
        }
        extractTree(t.preCommit, before)
        const b = runVerify(t.verify, before, verifyTimeoutMs)
        if (b.pass) {
            return {
                id: t.id,
                usable: false,
                detail: 'VERIFY passes on the BEFORE tree — it does not require the work'
            }
        }
        return {id: t.id, usable: true, detail: `before fail exit=${b.exitCode}, after pass`}
    } finally {
        fs.rmSync(after, {recursive: true, force: true})
        fs.rmSync(before, {recursive: true, force: true})
    }
}

/**
 * Every screened task, as two stimuli each — one per tree.
 *
 * `only` restricts the screen to an already-known list (the implementation run
 * published one). It is a SPEED knob, never a trust knob: every task named is
 * still screened here, because a screen result is a fact about a tree plus its
 * node_modules, and both move. A named task that no longer screens is dropped
 * and logged, not believed.
 */
export function gateStimuli(
    opts: {
        treeRoot: string
        verifyTimeoutMs: number
        only?: readonly string[]
        limitTasks?: number
        log?: (line: string) => void
    }
): {stimuli: GateStimulus[]; screened: ScreenOutcome[]} {
    const log = opts.log ?? ((l: string) => console.log(l))
    const all = implTasks()
    const candidates =
        opts.only && opts.only.length > 0 ? all.filter(t => opts.only!.includes(t.id)) : all
    if (opts.only && opts.only.length > 0) {
        const missing = opts.only.filter(id => !all.some(t => t.id === id))
        if (missing.length > 0) log(`  named but not in the corpus: ${missing.join(', ')}`)
    }
    log(
        `screening ${candidates.length} task(s): VERIFY must FAIL on the before-tree`
            + ' and PASS on the after-tree'
    )
    const screened: ScreenOutcome[] = []
    const usable: ImplTask[] = []
    for (const t of candidates) {
        // Stop screening once enough tasks are in hand. The screen runs two real
        // VERIFY scripts per task, so on a 51-task corpus it is the slowest
        // GPU-free step in the run.
        if (opts.limitTasks !== undefined && usable.length >= opts.limitTasks) break
        const o = screenTask(t, opts.treeRoot, opts.verifyTimeoutMs)
        screened.push(o)
        log(`  ${o.id} ${o.usable ? 'usable' : 'UNUSABLE'} (${o.detail})`)
        if (o.usable) usable.push(t)
    }
    const stimuli: GateStimulus[] = []
    for (const t of usable) {
        // Interleaved before/after per task, so a run truncated at any point
        // still holds both conditions in roughly equal number rather than every
        // PASS first and every FAIL never.
        stimuli.push({
            id: t.id,
            condition: 'before',
            commit: t.preCommit,
            spec: t.spec,
            truth: 'FAIL'
        })
        stimuli.push({
            id: t.id,
            condition: 'after',
            commit: t.postCommit,
            spec: t.spec,
            truth: 'PASS'
        })
    }
    return {stimuli, screened}
}
