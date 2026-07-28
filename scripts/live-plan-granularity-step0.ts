/**
 * STEP 0 — base rate of the plan-GRANULARITY fork at /task-auto's clarify head.
 *
 * mx5 ran the same spec twice from the same base commit and the clarify-triage
 * child auto-resolved the same fork in OPPOSITE directions, both times labelled
 * "already settled by the spec" (so the user never saw either):
 *   run 17 → "subdivide into ~30+ fine-grained tasks" → 41-task plan
 *   run 18 → "follow the milestones in §12 as-is"     → 11-task plan
 *
 * This script drives the REAL pipeline head — auto-clarify (question gen, with
 * the read tool) → triageClarifyQuestion (GRILL_AUTO_ANSWER triage, with the
 * existing-files block) — N times over the same spec, and reports:
 *   • how often the FIRST question is a plan-shape/granularity fork at all
 *   • how often the triage AUTO-RESOLVES it (ANSWER) vs surfaces it (UNKNOWN)
 *   • which direction the auto-resolution goes (coarse vs fine)
 *
 * It measures a base rate; it decides nothing. The direction split is what says
 * whether the 41→11 collapse is a coin flip inside the triage or a one-off.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-plan-granularity-step0.ts <specRepo> [REPS]
 */
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {expandFeatureMentions} from '../src/task/auto-orchestrator.js'
import {AUTO_CLARIFY_PROMPT} from '../src/task/auto-prompts.js'
import {GRILL_AUTO_ANSWER_PROMPT, GRILL_AUTO_FORMAT_HINT} from '../src/task/prompts.js'
import {parseClarifyList, parseAutoAnswer, autoAnswerHasTag} from '../src/task/parsers.js'
import {stripInlineMarkdown} from '../src/task/inline-markdown.js'
import {refineExistingFilesBlock} from '../src/task/phases.js'
import {findPhantomImports, rewritePhantomSpecifiers} from '../src/workers/phantom-imports.js'

const FEATURE = 'Implement @DESIGN/PROJECT.md'

/** Is this question about how finely the FEATURE is cut into tasks? */
function isGranularityQuestion(q: string): boolean {
    const s = q.toLowerCase()
    const shape =
        /\b(one task per|per[- ]milestone|task per milestone|milestones? .*(as-is|as is)|breakdown|decompos|split(ting)? (the )?(feature|work|spec|tasks?)|granular|fine[- ]grained|subdivid|separate tasks?|its own task|standalone task|own prerequisite task)\b/
    return shape.test(s)
}

type Dir = 'coarse' | 'fine' | 'unclear'

/** Which way does an answer cut? Coarse = follow the spec's own big sections;
 *  fine = split below them. Deliberately literal — printed alongside the text so
 *  a misread is visible. */
function direction(answer: string): Dir {
    const s = answer.toLowerCase()
    const coarse =
        /(as-is|as is|one task per milestone|per milestone|milestone-level|keep .*milestone|follow the (12 |9 )?milestones|handful of|fold(ing)? .* into (the )?(first )?milestone|single (implementation )?task per)/.test(
            s
        )
    const fine =
        /(subdivid|fine[- ]grained|30\+|per[- ]route|per[- ]component|smaller tasks|its own (prerequisite )?task|separate (prerequisite )?tasks?|split .* more granularly|granular)/.test(
            s
        )
    if (coarse && !fine) return 'coarse'
    if (fine && !coarse) return 'fine'
    return 'unclear'
}

async function main() {
    const repoArg = process.argv[2]
    if (repoArg === undefined) {
        console.error('usage: live-plan-granularity-step0.ts <specRepo> [REPS]')
        process.exit(2)
    }
    const reps = parseInt(process.argv[3] ?? '8', 10)
    const deps: PhaseDeps = {cwd: repoArg, taskId: '', signal: new AbortController().signal}

    const raw = await expandFeatureMentions(repoArg, FEATURE)
    const phantoms = findPhantomImports(raw, repoArg)
    const featureForModel = phantoms.length === 0 ? raw : rewritePhantomSpecifiers(raw, phantoms)
    const existingFilesBlock = await refineExistingFilesBlock(deps).catch(() => '')
    console.log(
        `spec ${featureForModel.length} chars; existing-files block ${existingFilesBlock.length} chars\n`
    )

    let granQ = 0
    let autoResolved = 0
    const dirs: Record<Dir, number> = {coarse: 0, fine: 0, unclear: 0}
    const rows: string[] = []

    for (let r = 1; r <= reps; r++) {
        try {
            const qRaw = await runPhaseChild(
                deps,
                'auto-clarify',
                'read',
                AUTO_CLARIFY_PROMPT(featureForModel, '')
            )
            const parsed = parseClarifyList(qRaw)
            if (parsed.length === 0) {
                rows.push(`rep ${r}: NONE (no question)`)
                continue
            }
            const plainQ = stripInlineMarkdown(parsed[0].question)
            const gran = isGranularityQuestion(plainQ)
            if (gran) granQ++

            // triageClarifyQuestion, transcribed (same prompts, same stub research).
            const source =
                existingFilesBlock.length > 0 ?
                    `${existingFilesBlock}\n\n${featureForModel}`
                :   featureForModel
            const basePrompt = GRILL_AUTO_ANSWER_PROMPT(
                source,
                '(none — clarify runs before decomposition; each task researches itself later)',
                plainQ
            )
            let text = await runPhaseChild(deps, 'clarify-triage', 'read', basePrompt)
            if (!autoAnswerHasTag(text)) {
                text = await runPhaseChild(
                    deps,
                    'clarify-triage',
                    'read',
                    prependHint(GRILL_AUTO_FORMAT_HINT, basePrompt)
                )
            }
            const a = parseAutoAnswer(text)
            const resolved = a.kind === 'answered'
            if (gran && resolved) autoResolved++
            const dir = resolved ? direction(a.text) : 'unclear'
            if (gran && resolved) dirs[dir]++
            rows.push(
                `rep ${r}: ${gran ? 'GRANULARITY' : 'other      '} | `
                    + `${resolved ? `AUTO-RESOLVED(${dir})` : 'surfaced to user'}\n`
                    + `    Q: ${plainQ.replace(/\s+/g, ' ').slice(0, 220)}\n`
                    + `    A: ${(resolved ? a.text : '(UNKNOWN — user decides)').replace(/\s+/g, ' ').slice(0, 220)}`
            )
            console.log(rows[rows.length - 1])
        } catch (e) {
            rows.push(`rep ${r}: ERROR ${String(e).slice(0, 160)}`)
            console.log(rows[rows.length - 1])
        }
    }

    console.log('\n=== STEP 0: plan-granularity fork at the clarify head ===')
    console.log(`reps                                : ${reps}`)
    console.log(`first question IS a granularity fork: ${granQ}/${reps}`)
    console.log(`  ↳ auto-resolved (never shown)     : ${autoResolved}/${granQ}`)
    console.log(
        `  ↳ direction of those auto-resolutions: coarse ${dirs.coarse}, fine ${dirs.fine}, unclear ${dirs.unclear}`
    )
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
