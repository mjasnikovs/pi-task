/**
 * Prompts for /task-auto's two feature-level child calls. These produce a task
 * LIST only; all research/spec depth is /task's job, run per-title later.
 */

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
 */
export const AUTO_DECOMPOSE_PROMPT = (feature: string, clarifications: string): string =>
    `Split this feature into an ordered list of implementation tasks. Each task
will be handed, by its title, to a separate pipeline that does its own research
and writes its own spec — so here you produce TITLES ONLY, not specs.

FEATURE REQUEST:
${feature.trim()}

CLARIFICATIONS:
${clarifications.trim() || '(none)'}

RULES:
- One task per line, as a markdown checkbox: "- [ ] <title>".
- Each title is a short imperative phrase; optionally add " — <one key detail>".
- Order tasks so earlier ones unblock later ones (foundations first).
- Each task should be independently implementable as a single /task run.
- Prefer a handful of substantial tasks over many trivial ones.
- Output the checkbox list and NOTHING else (no preamble, no numbering).`
