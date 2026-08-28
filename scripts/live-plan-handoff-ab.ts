/**
 * A/B — does the handoff's deliverable rule stop /task from RE-PLANNING a task
 * /task-plan has already planned?
 *
 * The live failure (aiz-client TASK_PLAN_0001 → TASK_0001, 2026-08-05): the
 * handoff led with the user's own words, "Lets plan new tab and report
 * @src/app/reports/". Refine read the verb as the deliverable and produced a task
 * titled "Plan the addition of a new sub-tab…", whose ACCEPTANCE was "a planning
 * document exists that includes clearly marked placeholder sections" and whose
 * VERIFY asserted that no `.ts`/`.tsx` file had changed. It passed, having built
 * nothing.
 *
 * Arms (paired, same scenario, same rep):
 *   BASE — handoff WITHOUT HANDOFF_DELIVERABLE_RULE (what shipped)
 *   FIX  — handoff WITH it
 *
 * Scenarios, because the verb leak and the deferred decision are separate causes
 * and each must be shown to be neutralised on its own:
 *   LIVE  — both decisions exactly as recorded, deferral included
 *   CLEAN — only the first, decisive decision (what defect 1's guard would leave)
 *
 * Scored on refine's own output: a spec that commits to a DOCUMENT rather than to
 * CODE is the defect, however it is worded.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-plan-handoff-ab.ts [REPS] [repo]
 */
import {runChild} from '../src/task/child-runner.js'
import {REFINE_PROMPT} from '../src/task/prompts.js'
import {buildHandoffPrompt, HANDOFF_DELIVERABLE_RULE, type PlanEntry} from '../src/task/plan-io.js'

const TASK = 'Lets plan new tab and report @src/app/reports/'

/** The decisions exactly as TASK_PLAN_0001 recorded them. */
const Q1 =
    'Should the new report be a sub-tab within the existing "Atskaites" (Reports) section, or a brand new top-level side menu item? This determines whether I add to ReportsHeader + nested routes in Reports.tsx, or create an entirely new section with its own entry in SideMenu and top-level route in Router.tsx.'
const A1 =
    'add it as a sub-tab within the existing Reports section (/reports/*), following the established pattern of adding to planningMenuList in ReportsHeader and a nested route in Reports.tsx'
const Q2 =
    'What specific report should this new tab display? The existing reports cover order lines (glue positives, cut lists), workstation groups, user marks, line marks, furnitura, and overview — knowing which business domain this new report serves determines its data source, query shape, filters, and table columns.'
const A2_DEFERRED = 'clarify with the user what the report is meant to show before proceeding'

const LIVE: PlanEntry[] = [
    {kind: 'decision', question: Q1, answer: A1, source: 'chosen'},
    {kind: 'decision', question: Q2, answer: A2_DEFERRED, source: 'accepted'}
]
const CLEAN: PlanEntry[] = [LIVE[0]!]

const SCENARIOS: {name: string; entries: PlanEntry[]}[] = [
    {name: 'LIVE ', entries: LIVE},
    {name: 'CLEAN', entries: CLEAN}
]

/** BASE reconstructs the pre-fix handoff by removing the rule, so the two arms
 *  differ by exactly that paragraph. */
function baseHandoff(entries: PlanEntry[]): string {
    return buildHandoffPrompt(TASK, entries)
        .replace(`\n\n${HANDOFF_DELIVERABLE_RULE}`, '')
        .replace(HANDOFF_DELIVERABLE_RULE, '')
}

/**
 * Did refine commit to a DOCUMENT instead of to code?
 *
 * Written against the live artifact's own wording, then widened to the phrasings
 * that mean the same thing. Any one hit is the defect: the run produces no
 * software.
 */
function isPlanningOnly(spec: string): string | null {
    const s = spec.toLowerCase()
    const patterns: [RegExp, string][] = [
        [/\bgoal\b[^\n]*\n\s*(plan|design|document|draft|outline|propose)\b/i, 'GOAL is to plan'],
        // Missed by the first draft, both in the BASE arm and both unmistakable:
        // "Produce a written implementation plan for adding a new report sub-tab"
        // and "Create a planning outline for a new tab". A GOAL may open with any
        // producing verb and still deliver a document.
        [
            /\bgoal\b[^\n]*\n\s*(produce|create|write|draft|prepare|deliver|develop)\b[^.\n]{0,80}\b(plan|outline|proposal|specification|document)\b/i,
            'GOAL produces a document'
        ],
        [/\b(implementation|written|detailed|concrete) plan\b/, 'a plan is the deliverable'],
        [/\bplanning outline\b/, 'planning outline'],
        [
            /\bplanning (document|output|specification|spec|deliverable|artifact)\b/,
            'planning document'
        ],
        [
            /\b(do not|don'?t|no) (implement|write code|change code|modify (any )?(source|code))/,
            'forbids implementing'
        ],
        [/\bplanning[- ]only\b/, 'planning-only'],
        [/\bthis task is planning\b/, 'planning task'],
        [/\bplaceholder sections?\b/, 'placeholder sections'],
        [
            /\b(wait|waiting) for (the )?user (confirmation|input|to confirm|to specify)/,
            'waits for the user'
        ],
        [/\bpending user (confirmation|input|clarification)\b/, 'pending user input'],
        [/\bno code (changes?|has been|should be)\b/, 'no code changes'],
        [/\bbefore proceeding to implementation\b/, 'defers implementation']
    ]
    for (const [re, label] of patterns) if (re.test(s)) return label
    return null
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '6', 10)
    const cwd = process.argv[3] ?? process.cwd()
    const signal = new AbortController().signal

    const tally = new Map<string, {n: number; bad: number; labels: string[]}>()
    const key = (scenario: string, arm: string) => `${scenario} ${arm}`

    for (let r = 0; r < reps; r++) {
        for (const sc of SCENARIOS) {
            for (const arm of ['BASE', 'FIX'] as const) {
                const handoff =
                    arm === 'BASE' ? baseHandoff(sc.entries) : buildHandoffPrompt(TASK, sc.entries)
                let spec: string
                try {
                    const res = await runChild({
                        cwd,
                        tools: 'read',
                        prompt: REFINE_PROMPT(handoff),
                        signal,
                        onToolCall: () => null
                    })
                    spec = res.text
                } catch (err) {
                    console.log(
                        `rep ${r + 1} · ${sc.name} ${arm} · THREW ${(err as Error).message}`
                    )
                    continue
                }
                const bad = isPlanningOnly(spec)
                const t = tally.get(key(sc.name, arm)) ?? {n: 0, bad: 0, labels: []}
                t.n++
                if (bad !== null) {
                    t.bad++
                    t.labels.push(bad)
                }
                tally.set(key(sc.name, arm), t)
                const goal = (/GOAL\s*\n\s*(.+)/.exec(spec)?.[1] ?? spec.slice(0, 90)).slice(0, 96)
                console.log(
                    `rep ${r + 1} · ${sc.name} ${arm} · ${bad === null ? 'code ' : 'DOC  '} · ${goal}`
                )
                if (bad !== null) console.log(`             ↳ ${bad}`)
            }
        }
    }

    console.log(`\n─── ${reps} rep(s) ───`)
    for (const [k, t] of [...tally.entries()].sort()) {
        console.log(
            `${k}  planning-only ${t.bad}/${t.n}`
                + (t.labels.length > 0 ? `   [${[...new Set(t.labels)].join(', ')}]` : '')
        )
    }
}

void main()
