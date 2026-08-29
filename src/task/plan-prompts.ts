/**
 * Prompts for /task-plan's two planning children.
 *
 * /task-plan plans ONE task interactively before any spec work happens. Its
 * question generator is deliberately the SAME SHAPE as /task-auto's clarify head
 * (`AUTO_CLARIFY_PROMPT` in auto-prompts.ts): one numbered question, a required
 * `SUGGESTED:` line, an optional `ALT:` line for a binary fork, the literal token
 * NONE when nothing remains. That is not a coincidence — it means
 * {@link parseClarifyList} parses this output UNCHANGED, and the boxed picker,
 * the duplicate backstop and the YOLO picker all work here with no new code.
 *
 * What differs is the JOB. /task-auto's clarify asks for what most changes how a
 * feature is SPLIT INTO TASKS — scope boundaries, which subsystems are in or out,
 * ordering, the cross-cutting choices that fork the breakdown. /task-plan is
 * planning a single unit of work that /task will implement in one run, so a "how
 * do we split this" question is off-topic here, and the SCOPE RULES below rule it
 * out explicitly.
 */

/**
 * Ask the SINGLE most important remaining question about ONE task.
 *
 * `priorQA` carries every decision made so far — model questions the user
 * answered, answers the user volunteered, and the Q&A from questions the user
 * asked the model — so each next question adapts to them. Output MUST match
 * parseClarifyList.
 */
export const PLAN_QUESTION_PROMPT = (task: string, priorQA: string): string =>
    `You are helping a user plan ONE implementation task before it is built, one clarifying question at a time.

TASK:
${task.trim()}

DECISIONS SO FAR:
${priorQA.trim() || '(none yet)'}

READ FIRST. Use the read tool on the repo and any referenced docs before you
decide what to ask — open the files this task would touch. A question you could
have asked without opening anything is almost always the wrong one: the good
question is the fork you can only see once you know what is already there, and
the SUGGESTED default has to name real, existing things to be worth accepting.
Reading is expected and costs you nothing; only your REPLY is short.

Output the SINGLE most important question that REMAINS — the one whose answer
would most change HOW THIS ONE TASK IS BUILT: what is in and out of its scope,
which approach or data shape it commits to, which existing code it changes versus
leaves alone, how it behaves at the edges the request does not pin down. Account
for the decisions so far:
- Never re-ask something already decided above.
- If a decision introduced a new fork or contradicts an assumption in the request
  (for example, the user picked an approach the request did not anticipate), ask
  about the most important consequence of that choice next.
- Drop questions the decisions have made irrelevant.

SCOPE RULES — read carefully:
- This is ONE task, implemented in ONE run. Do NOT ask how the work should be
  split, sequenced, phased, or broken into separate tasks, milestones, or PRs —
  that decision is not on the table here.
- Questions must clarify the EXISTING request. Do NOT propose new deliverables,
  enhancements, migrations, or "while we're here" cleanups.
- Skip anything the implementer will naturally resolve by reading the code
  (where a file lives, what a function is currently called, which test runner the
  repo uses).
- Ask about decisions that are costly to reverse once the code is written.

YOU MUST propose a default answer for the question — every question you emit
carries exactly one SUGGESTED line. Never omit it, never leave it blank, never
refuse. Infer the most sensible, concrete, decisive default from the request, the
repo, and any stated constraints; it is shown to the user as a recommendation they
accept or override. When the question is a genuine binary "A or B?" fork, also give
the single best alternative as an ALT line; otherwise emit only the one SUGGESTED.

The SUGGESTED must DECIDE. Never recommend asking, clarifying, confirming, or
checking with the user, and never recommend waiting, deferring, or leaving the
question open — the user is answering this very question right now, so "find out
from the user" is not an answer, it is the question you just asked. If you truly
cannot tell which way to go, still commit to the option you would take if it were
your call, and let the user override it. A default that could not be implemented
as written is not a default.

OUTPUT FORMAT (exact) — read as much as you like, but your written REPLY is 2 or
3 lines and nothing else:
- Do NOT report what you read. No preamble, no analysis, no findings, no numbered
  notes about files. The FIRST line of your reply is the question itself.
  (Measured failure: a reply that opened with a numbered observation about a file
  was read as the question.) What you learned belongs INSIDE the question and its
  SUGGESTED line, as concrete names — not in a summary of your investigation.
- One question as a single numbered line: "1. ...".
- On the NEXT line (never inline), a line that begins with "SUGGESTED: <your recommended default>". This line is REQUIRED for every question.
- If your question names two alternatives — ANY question of the form "should it be X or Y?" — you MUST add a third line beginning with "ALT: <the option your SUGGESTED did not take>". Only a question with no second alternative (a genuinely open "what should X be?") omits the ALT line. Do not offer a choice in the question and then leave the user only one card.
- Put the core question in **bold**, followed by a short one-line rationale in plain prose. Backticks around code/identifiers are fine. Avoid other markdown (headings, bullet lists, links).
- Only when nothing decision-changing is left to ask — the request and the decisions above already pin down how this task is built — output exactly the single token NONE on its own line (and no SUGGESTED line).

EXAMPLES (format only — your wording will differ):

Open-ended question:
1. **Which existing callers must keep working unchanged?** This decides whether the change can alter the exported signature or must add a new one alongside it.
SUGGESTED: keep every current caller working — add the new option with a default that preserves today's behaviour

Binary "A or B?" fork:
1. **Should the retry live in the client wrapper or in each call site?** This decides whether one shared code path owns the backoff or every caller repeats it.
SUGGESTED: put it in the client wrapper so every call site inherits the same backoff
ALT: retry at each call site, so a caller can opt out

No question remains:
NONE`

/**
 * Answer a question the USER asked the model during planning.
 *
 * This is the one channel /task-plan adds that no existing phase has: everywhere
 * else in pi-task the model asks and the user answers. Here the user asks. The
 * answer is advisory — it is recorded in the plan file as a note, and it does NOT
 * by itself decide anything; the user still answers the model's own questions.
 *
 * The abstention rule matters more here than anywhere else in the pipeline: a
 * planning answer that invents a file, a flag, or an API reads exactly like a
 * grounded one, and the user is asking BECAUSE they do not know. Saying "I could
 * not confirm this" is a correct answer; a confident guess is not.
 */
export const PLAN_ANSWER_PROMPT = (task: string, priorQA: string, question: string): string =>
    `You are helping a user plan ONE implementation task. The user has asked YOU a question about it. Answer it.

TASK:
${task.trim()}

DECISIONS SO FAR:
${priorQA.trim() || '(none yet)'}

THE USER'S QUESTION:
${question.trim()}

Use the read tool to check the repo before you answer. Ground the answer in what
is actually there.

RULES — read carefully:
- Answer the question that was asked. Do not answer a different, easier one.
- Name only files, symbols, commands, and options you have VERIFIED exist — by
  reading them, or because they appear in the task above. Never name a path or an
  API from memory.
- If you cannot confirm the answer from the repo, say so plainly and say what you
  would need to check. "I could not confirm X" is a correct answer here; a
  confident guess is not.
- If the question asks for a recommendation, give ONE, and say in a sentence what
  it costs.
- Do not start implementing, do not write code blocks longer than a few lines, and
  do not restate the task back to the user.

OUTPUT:
- Plain prose, at most 8 short lines. No preamble, no headings, no bullet lists
  longer than 4 items, no code fences.`
