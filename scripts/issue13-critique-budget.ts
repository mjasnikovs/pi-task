/**
 * ISSUE #13 — "critique child exceeded its 600s budget on all 3 attempt(s)".
 *
 * STAGE 1 (this file, `gen`): drive the REAL spec pipeline — refine → research →
 * grill (YOLO auto-answer, the unattended channel) → compose — over 10 prompts
 * spanning trivial to very hard, against the LIVE local model, and persist every
 * critique INPUT to JSONL so stage 2 never has to regenerate them.
 *
 * STAGE 2 (`ab`): replay phaseCritique from those persisted inputs under two arms
 * over the SAME inputs:
 *   old   timeoutMs = 600_000   (v0.38.11's PHASE_CHILD_TIMEOUT_MS default)
 *   new   timeoutMs = 0         (HEAD's default — cap off, StallDetector instead)
 * Metric: PhaseTimeoutError count per arm, and the wall time of every critique
 * child spawn.
 *
 * Usage: PI_BIN=... bun run scripts/issue13-critique-budget.ts gen [from] [to]
 *        PI_BIN=... bun run scripts/issue13-critique-budget.ts ab [from] [to]
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {ChildProcess, execFileSync, spawn as nodeSpawn} from 'node:child_process'

import {runPhaseWithLoopGuard, prependHint, type PhaseDeps} from '../dist/task/child-runner.js'
import {PhaseTimeoutError} from '../dist/task/child-runner.js'
import {phaseRefine, phaseResearch, phaseVerifyTooling, phaseCompose, phaseCritique, phaseAutoAnswer, dropRefutedConstraints} from '../dist/task/phases.js'
import {GRILL_GEN_PROMPT} from '../dist/task/prompts.js'
import {parseGrillQuestions} from '../dist/task/parsers.js'
import {yoloPickAutoAnswer, YOLO_STAMP} from '../dist/task/yolo.js'
import {isDuplicateQuestion} from '../dist/task/question-dedup.js'
import {stripInlineMarkdown} from '../dist/task/inline-markdown.js'
import {validateSpecShape, parseVerifyBlock} from '../dist/task/spec-validation.js'
import {writeTaskFile} from '../dist/task/task-io.js'

const OUT = '/home/edgars/tmp/issue13'
const REPO = '/home/edgars/.pi/agent/extensions/pi-task'
/** Grill is capped here (production cap is 20); the spec only needs realistic Q&A. */
const GRILL_CAP = 3

/** Ten prompts, easiest first. 1-3 are one-liners; 8-10 are multi-subsystem. */
const TASKS: {level: number; label: string; prompt: string}[] = [
    {level: 1, label: 'typo', prompt: 'Fix the typo in the README where it says "verifed" instead of "verified".'},
    {level: 2, label: 'const', prompt: 'Add a MAX_PLAN_QUESTIONS-style named constant for the grill question cap instead of the bare number, and use it.'},
    {level: 3, label: 'log-line', prompt: 'Log the elapsed milliseconds of each research worker to the debug log so a slow worker is visible in the trail.'},
    {level: 4, label: 'flag', prompt: 'Add a config flag that turns the deep-render check off, defaulting to on, wired through /task-config like the other toggles.'},
    {level: 5, label: 'parser', prompt: 'The VERIFY block parser should accept a fenced ```sh block as well as a bare command list, without breaking any existing spec.'},
    {level: 6, label: 'retry', prompt: 'Give the docs worker the same connection-error retry ladder the phase children have, with exponential backoff and a bounded strike budget.'},
    {level: 7, label: 'cache', prompt: 'Add an on-disk, per-package cache for npm version lookups with TTL-based invalidation, shared by enrichment and the research workers, safe under concurrent writes from several children.'},
    {level: 8, label: 'gate', prompt: 'Add a new final-gate check that boots the built artifact, requests the health endpoint, and FAILs on a non-2xx or a blank body, with a capability degrade when no boot command has provenance.'},
    {level: 9, label: 'resume', prompt: 'Make a /task-auto run fully resumable after a hard kill: persist per-phase progress, detect a half-written task file, replay only the phases that did not complete, and prove it with a crash-injection test across every phase boundary.'},
    {level: 10, label: 'multi', prompt: 'Design and implement a second orchestration mode where several tasks run concurrently against the same checkout: a file-level lease registry, a conflict detector that blocks two tasks writing the same path, a merge step that reconciles their diffs, per-task gates that still run in isolation, and a remote web view that shows all lanes live. Include the failure policy for a lane that dies mid-write.'}
]

function deps(cwd: string, signal: AbortSignal, timeoutMs?: number, trail?: string[]): PhaseDeps {
    return {
        cwd,
        taskId: 'TASK_0001',
        signal,
        ...(timeoutMs === undefined ? {} : {timeoutMs}),
        ...(trail === undefined ? {} : {logDebug: (m: string) => trail.push(m)})
    }
}

/** The unattended grill loop: gen -> auto-answer -> YOLO pick. */
async function grill(d: PhaseDeps, refined: string, research: string): Promise<{qa: string; ms: number[]}> {
    const qa: string[] = []
    const asked: string[] = []
    const ms: number[] = []
    for (let n = 0; n < GRILL_CAP; n++) {
        const t0 = Date.now()
        const raw = await runPhaseWithLoopGuard(d, 'grill-gen', 'read', hint =>
            prependHint(hint, GRILL_GEN_PROMPT(refined, research, qa.join('\n')))
        )
        ms.push(Date.now() - t0)
        const qs = parseGrillQuestions(raw)
        if (qs.length === 0) break
        const q = stripInlineMarkdown(qs[0]!)
        if (isDuplicateQuestion(asked, q)) break
        asked.push(q)
        const t1 = Date.now()
        const auto = await phaseAutoAnswer(d, refined, research, qs[0]!)
        ms.push(Date.now() - t1)
        const pick = yoloPickAutoAnswer(true, auto)
        const answer =
            pick === null ? '(no answer)'
            : pick.kind === 'answer' ? stripInlineMarkdown(pick.answer)
            : `(skipped — ${pick.note})`
        qa.push(`Q${n + 1}: ${q}\nA${n + 1}: ${answer} ${YOLO_STAMP}`)
    }
    return {qa: qa.length ? qa.join('\n') : '(no questions produced)', ms}
}

async function gen(from: number, to: number): Promise<void> {
    await fsp.mkdir(OUT, {recursive: true})
    for (const t of TASKS) {
        if (t.level < from || t.level > to) continue
        const dest = path.join(OUT, `repo-${t.level}`)
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, {recursive: true})
            execFileSync('bash', ['-c', `git -C ${REPO} archive HEAD | tar -x -C ${dest}`])
            execFileSync('bash', ['-c', `cd ${dest} && git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm base`])
        }
        // The phases read/write .pi-tasks/TASK_0001.md the way a real run does.
        const now = new Date().toISOString()
        await writeTaskFile(
            dest,
            {id: 'TASK_0001', state: 'in_progress', phase: 'refine', created_at: now, updated_at: now, title: t.prompt},
            `## prompt\n\n${t.prompt}\n`
        )
        const ac = new AbortController()
        const trail: string[] = []
        const d = deps(dest, ac.signal, undefined, trail)
        const rec: Record<string, unknown> = {level: t.level, label: t.label, prompt: t.prompt}
        const t0 = Date.now()
        try {
            let m = Date.now()
            const refined0 = await phaseRefine(d, t.prompt)
            rec.refineMs = Date.now() - m
            m = Date.now()
            const research = await phaseVerifyTooling(d, await phaseResearch(d, refined0))
            rec.researchMs = Date.now() - m
            m = Date.now()
            const g = await grill(d, refined0, research)
            rec.grillMs = Date.now() - m
            rec.grillSpawnMs = g.ms
            m = Date.now()
            const refined = await dropRefutedConstraints(d, refined0, research)
            const draft = await phaseCompose(d, refined, research, g.qa)
            rec.composeMs = Date.now() - m
            rec.refined = refined
            rec.research = research
            rec.qa = g.qa
            rec.draft = draft
            rec.draftHasVerify = parseVerifyBlock(draft) !== null
            rec.draftShape = validateSpecShape(draft)
            rec.ok = true
        } catch (e) {
            rec.ok = false
            rec.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
        }
        rec.totalMs = Date.now() - t0
        rec.trail = trail
        await fsp.appendFile(path.join(OUT, 'inputs.jsonl'), JSON.stringify(rec) + '\n')
        console.log(
            `[gen] L${t.level} ${t.label} ok=${rec.ok} refine=${rec.refineMs}ms research=${rec.researchMs}ms grill=${rec.grillMs}ms compose=${rec.composeMs}ms total=${rec.totalMs}ms ${rec.error ?? ''}`
        )
    }
}

/** One `gen` row, as it is read back by `ab`. */
interface RecordedInput {
    level: number
    label: string
    ok: boolean
    refined: string
    research: string
    qa: string
    draft: string
}

async function ab(from: number, to: number): Promise<void> {
    const lines = (await fsp.readFile(path.join(OUT, 'inputs.jsonl'), 'utf8')).trim().split('\n')
    const inputs = lines.map(l => JSON.parse(l) as RecordedInput).filter(r => r.ok)
    for (const inp of inputs) {
        if (inp.level < from || inp.level > to) continue
        for (const arm of ['new', 'old'] as const) {
            const dest = path.join(OUT, `repo-${inp.level}`)
            const ac = new AbortController()
            const trail: string[] = []
            const spawns: {name: string; ms: number}[] = []
            /** Exact per-PROCESS wall time: the only way to know whether ONE spawn
             *  crossed 600s, which is what the old cap actually measured. */
            const procs: number[] = []
            // `ProcLike.kill` takes a plain `string`; node's takes a `Signals`
            // union, so the child is adapted rather than cast.
            const timedSpawn: NonNullable<PhaseDeps['spawn']> = (command, args, options) => {
                const started = Date.now()
                const child = nodeSpawn(command, [...args], options)
                child.once('close', () => procs.push(Date.now() - started))
                return Object.assign(child, {
                    kill: (signal: string): boolean =>
                        ChildProcess.prototype.kill.call(child, signal as NodeJS.Signals)
                })
            }
            const d: PhaseDeps = {
                ...deps(dest, ac.signal, arm === 'old' ? 600_000 : 0, trail),
                spawn: timedSpawn
            }
            const t0 = Date.now()
            let spec = ''
            let err = ''
            try {
                spec = await phaseCritique(
                    {...d, recordSubStep: (label, ms) => spawns.push({name: label, ms})},
                    inp.draft,
                    inp.refined,
                    inp.qa,
                    undefined,
                    inp.research
                )
            } catch (e) {
                err =
                    e instanceof PhaseTimeoutError ? `PhaseTimeoutError: ${e.message}`
                    : e instanceof Error ? `${e.name}: ${e.message}`
                    : String(e)
            }
            const totalMs = Date.now() - t0
            const out = {
                level: inp.level,
                label: inp.label,
                arm,
                totalMs,
                spawns,
                procs,
                maxProcMs: procs.length ? Math.max(...procs) : 0,
                timedOut: err.startsWith('PhaseTimeoutError'),
                err,
                specShape: err ? null : validateSpecShape(spec),
                specLen: spec.length,
                trail,
                spec
            }
            await fsp.appendFile(path.join(OUT, 'ab.jsonl'), JSON.stringify(out) + '\n')
            console.log(
                `[ab] L${inp.level} ${inp.label} arm=${arm} total=${totalMs}ms procs=${JSON.stringify(procs)} sub=${JSON.stringify(spawns)} timedOut=${out.timedOut} ${err}`
            )
        }
    }
}

const mode = process.argv[2] ?? 'gen'
const from = Number(process.argv[3] ?? '1')
const to = Number(process.argv[4] ?? '10')
if (mode === 'gen') await gen(from, to)
else await ab(from, to)
