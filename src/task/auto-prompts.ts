/**
 * Prompts for /task-auto's two feature-level child calls. These produce a task
 * LIST only; all research/spec depth is /task's job, run per-title later.
 */

/**
 * Clarify: output MUST match parseGrillQuestions — a numbered list, or the
 * literal token NONE when no clarification is needed.
 */
export const AUTO_CLARIFY_PROMPT = (feature: string): string =>
    `You are planning how to split a feature into separate implementation tasks.

FEATURE REQUEST:
${feature.trim()}

List ONLY the clarifying questions whose answers would change how this feature
is split into tasks (scope boundaries, which subsystems are in/out, ordering,
key technical choices that fork the task breakdown). Skip anything /task will
naturally resolve per-task during its own research.

OUTPUT FORMAT (exact):
- A numbered list, one question per line: "1. ...", "2. ...".
- Keep it short — only genuinely decision-changing questions, at most a handful.
- If no clarification is needed, output exactly:
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
