/**
 * Prompts for /task-auto's two feature-level child calls. These produce a task
 * LIST only; all research/spec depth is /task's job, run per-title later.
 */
import {DECOMPOSE_SOURCE_RULE} from './decompose-fidelity.js'
import {DECOMPOSE_NO_BATCH_TESTS_RULE} from './batch-test-task.js'

/**
 * Clarify: asks ONE question at a time. Output MUST match parseClarifyList — a
 * single numbered question followed by a "SUGGESTED: <default>" line, an optional
 * "ALT: <alternative>" line for binary "A or B?" forks, or the literal token NONE
 * when no clarification remains. priorQA carries the questions already answered so
 * each next question adapts to them.
 */
export const AUTO_CLARIFY_PROMPT = (feature: string, priorQA: string): string =>
    `You are planning how to split a feature into separate implementation tasks, one clarifying question at a time.

FEATURE REQUEST:
${feature.trim()}

ANSWERS SO FAR:
${priorQA.trim() || '(none yet)'}

You may use the read tool to inspect the repo and any referenced docs so your
question and recommendation are grounded in what already exists.

Output the SINGLE most important clarifying question that REMAINS — the one whose
answer would most change HOW this feature is split into tasks (scope boundaries,
which subsystems are in/out, ordering, the cross-cutting technical choices that
fork the breakdown). Account for the answers so far:
- Never re-ask something already answered above.
- If an answer introduced a new fork or contradicts an assumption (for example,
  the user chose a framework or tool the request did not anticipate), ask about
  the most important consequence of that choice next — how it is built, what
  extra dependencies it pulls in, how it changes the other subsystems.
- When the feature spans multiple subsystems, work through its forks one at a
  time (file/blob storage, client/rendering strategy, auth and session model,
  real-time vs polling transport, search, deployment).
- Skip anything /task will naturally resolve per-task during its own research.
- Stay grounded in the referenced spec. If a design/spec doc is included above, do NOT propose a new subsystem, dependency, or requirement it does not call for, and do NOT re-ask a choice the spec already settles. Ask only about genuine forks the spec leaves open.
- If the question or your SUGGESTED default locks the task breakdown to ONE part or structure of the spec (e.g. "follow the milestone list", "one task per section"), the SUGGESTED line must ALSO name the spec's other REQUIRED content that structure does not represent (a testing/security/quality section, cross-cutting rules) and state how each is carried — folded into every applicable task, or as its own task. Never present a structure-lock as settling the whole spec.

YOU MUST propose a default answer for the question — every question you emit
carries exactly one SUGGESTED line. Never omit it, never leave it blank, never
refuse. Infer the most sensible, concrete, decisive default from the repo, the
referenced docs, and any stated philosophy or constraints; it is shown to the
user as a recommendation they accept or override. When the question is a genuine
binary "A or B?" fork, also give the single best alternative as an ALT line;
otherwise emit only the one SUGGESTED.

OUTPUT FORMAT (exact):
- One clarifying question as a single numbered line: "1. ...".
- On the NEXT line (never inline), a line that begins with "SUGGESTED: <your recommended default>". This line is REQUIRED for every question.
- ONLY for a binary "A or B?" fork, on the line after that, a line beginning with "ALT: <the alternative option>". Omit the ALT line entirely for open-ended questions.
- Put the core question in **bold**, followed by a short one-line rationale in plain prose. Backticks around code/identifiers are fine. Avoid other markdown (headings, bullet lists, links).
- Only when the spec already pins down every choice that would change the task breakdown — nothing decision-changing is left to ask — output exactly the single token NONE on its own line (and no SUGGESTED line).

EXAMPLES (format only — your wording will differ):

Open-ended question:
1. **Where should uploaded files be stored?** This forks whether an early storage-abstraction task is needed.
SUGGESTED: store on local disk under ./uploads, served by the existing static handler

Binary "A or B?" fork:
1. **Should the Zod schemas live in a shared module imported by both server and client, or stay server-only with manual client types?** This decides whether a "shared schema" task must land before any route or API-client work.
SUGGESTED: a shared schema module imported by both, so \`hc()\` gets typed RPC for free
ALT: server-only schemas with hand-written client types

No question remains:
NONE`

/**
 * Decompose: output a markdown checkbox list of task titles (one line each).
 * `requirementsLedger` is buildRequirementsLedger's grounded quote list (goal E's
 * belt): the spec's obligations ride into decompose explicitly, so mirroring the
 * spec's own milestone/section structure cannot silently discharge them. '' ⇒
 * the prompt is unchanged.
 *
 * `noBatchTests` adds the anti-batch-test rule (batch-test-task.ts) — emitted ONLY
 * when the decisions mandate tests-in-the-same-change, so every other run sees the
 * prompt it always saw. It is the belt; the host-side rewrite is the lever.
 */
export const AUTO_DECOMPOSE_PROMPT = (
    feature: string,
    clarifications: string,
    requirementsLedger = '',
    noBatchTests = false
): string =>
    `Split this feature into an ordered list of implementation tasks. Each task
will be handed, by its title, to a separate pipeline that does its own research
and writes its own spec — so here you produce TITLES ONLY, not specs.

FEATURE REQUEST:
${feature.trim()}

CLARIFICATIONS:
${clarifications.trim() || '(none)'}
${requirementsLedger.trim().length > 0 ? `\n${requirementsLedger.trim()}\n` : ''}
RULES:
- One task per line, as a markdown checkbox: "- [ ] <title>".
- Each title is a short imperative phrase; optionally add " — <one key detail>".
- Order tasks so earlier ones unblock later ones (foundations first).
- Each task should be independently implementable as a single /task run.
- Prefer a handful of substantial tasks over many trivial ones.
- When a CLARIFICATION decision governs a task, append it to that task's line as
  "[decisions: <directive>]" — include ONLY the decisions that bear on that task,
  and attach a cross-cutting decision to EACH task it governs. Most tasks carry
  none. These are explicit user choices that may contradict the referenced spec
  doc; phrase them as imperative directives (e.g. "use Bun's built-in bundler, do
  not add vite"). Do NOT invent decisions — only restate ones from CLARIFICATIONS.
${DECOMPOSE_SOURCE_RULE}${noBatchTests ? `\n${DECOMPOSE_NO_BATCH_TESTS_RULE}` : ''}
- Output the checkbox list and NOTHING else (no preamble, no numbering).`

/**
 * Coverage triage: judge whether a decomposed task list covers the whole
 * feature. Guards the plan — the highest-leverage artifact in /task-auto —
 * against a degenerate-but-nonempty decompose completion (live mx5: the model
 * emitted ONE task for an 18KB design doc with a natural EOS, and the only
 * existing gate was `titles.length === 0`, so the run "completed" after one
 * task). Pure judgment over text already in hand, so it runs with --no-tools.
 * Output MUST match parseCoverageVerdict.
 */
export const DECOMPOSE_COVERAGE_PROMPT = (
    feature: string,
    clarifications: string,
    list: string[]
): string =>
    `You are auditing a task decomposition for completeness. Below is a FEATURE
REQUEST (with any referenced design spec inlined), the CLARIFICATIONS the user
settled, and the proposed ordered TASK LIST that is supposed to implement ALL
of it. Each listed task will later get its own research and spec — so judge
coverage only, not wording or level of detail.

FEATURE REQUEST:
${feature.trim()}

CLARIFICATIONS:
${clarifications.trim() || '(none)'}

TASK LIST:
${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Judge ONE thing: taken together, do these tasks cover the whole feature end to
end? An area is MISSING only when NO task plausibly covers it — do not flag
wording, ordering, task size, or detail a task's own research will fill in.

Output — no preamble, no markdown:
COVERAGE: COMPLETE
or
COVERAGE: INCOMPLETE
MISSING: <feature area no task covers>
(one MISSING line per uncovered area, most important first, at most 8)`
