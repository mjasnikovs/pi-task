/**
 * STAGE 2 LEVER — the APIS OUTPUT CONTRACT.
 *
 * ── WHAT STAGE 1 MEASURED, AND WHY THIS IS THE ONLY VARIABLE LEFT ─────────────────────────
 *
 * worker:apis terminates when every entry on its output list has a SIGNATURE. That is not an
 * inference; it is what 16 live reps say (commit 807ffad, raw data ~/tmp/apis-stopping-point):
 *   - it does not stop at a budget — docs calls/rep mean 8.5, sd 3.8, cv 0.45, range 3-14;
 *   - it does not stop because it is circling — near-repeats 2/45 = 4.4% over the last three
 *     calls, LOWER than the 10.2% whole-trajectory rate;
 *   - it does not stop because nothing new is arriving — the FINAL answer of a rep still
 *     returns 39 symbols no earlier answer in that rep carried;
 *   - it does not stop with holes in its own output — ungrounded symbols 2/588 = 0.3%,
 *     strict open-gap entries 2/277 = 0.7%.
 * What it does instead: 95.3% of its lookups reach the emitted section and 72.2% of emitted
 * entries were themselves asked about. The trajectory and the output are the SAME LIST. And
 * the list's format is `<name>  <one-line signature or use>` — so of 61 package queries across
 * 15 reps, 52 (85.2%) are signature questions and THREE are behaviour questions.
 *
 * The worker stops because the artifact it was asked for is complete by the standard its
 * format sets, and a signature satisfies that standard. "What does this parameter MEAN" is not
 * a field of the thing it is building, so nothing in its output is ever left unfilled by not
 * asking it. That is why it never escalates: escalation answers a question it has no reason to
 * ask.
 *
 * ── WHY THIS BLOCK AND NOT A THIRD INSTRUCTION ────────────────────────────────────────────
 *
 * Two levers have already failed against this seam, and they failed for the same reason:
 *   PROMPT 2  conditioned on RECOGNISING an answer as inadequate (type-only). Reach 9/1680 =
 *             0.54% of answers. But a type signature is not an inadequate answer to the
 *             question actually being asked — it is exactly the requested field.
 *   PROMPT 4  conditioned on nothing at all, and pointed the worker at the exact page that
 *             would have prevented the fatal bug. 2/20 vs 3/20, Fisher p = 0.50, with delivery
 *             of the block into the assembled prompt PROVEN separately. A pointer only helps a
 *             worker that has an unmet slot to fill.
 * Both acted on the ANSWER side or the TARGET side. This one adds a FIELD A SIGNATURE CANNOT
 * FILL, which is the variable that is not flat.
 *
 * ── STEP 3 OF THE FALLBACK IS LOAD-BEARING. DO NOT "CLOSE" IT ─────────────────────────────
 *
 * The `UNVERIFIED:` escape is mandatory and is not a loophole. Forbidding abstention is
 * precisely how F-1 manufactured the confident wrong claim that killed run 15: worker:context,
 * holding one true citable fact (the pinned hono version), fused it with an uncheckable one
 * (what `hc`'s base URL means) under a single attribution — `hc<AppType>('/api')` — and every
 * request in the shipped product went to /api/api/… and 404'd. A lever that buys behaviour
 * questions with fabrication is a FAIL, not a win. The A/B asserts it: excerptVerified===false
 * and the ungrounded-symbol rate must not rise.
 *
 * Exported unwired first, wired into RESEARCH_APIS_PROMPT in the same series; the STEP A
 * feasibility probe splices this exact text into a patched dist so the probe and the shipped
 * lever can never drift apart.
 */

/**
 * The extra output-contract clause for RESEARCH_APIS_PROMPT.
 *
 * Wording notes, because each of these is answering something measured:
 *  - "NOT DONE WHEN THEY HAVE A SIGNATURE" is the whole lever. Stage 1's mechanism is
 *    completion-by-format, so the change has to move the completion bar, not add advice.
 *  - the worked example is the run-15 fatal case verbatim (`hc(baseUrl: Prefix, …)`), because
 *    a rule without an instance of what does NOT satisfy it reads as satisfied by anything.
 *  - step 2 says escalation is EXPECTED rather than permitted: bundled .d.ts files genuinely
 *    do not carry semantics, and a worker that reads "you may escalate" has been told nothing
 *    it did not already have (PROMPT 4 measured what permission alone achieves: nothing).
 *  - step 3 is stated as CORRECT and REQUIRED, in those words, so the field cannot be closed
 *    by guessing. See the header.
 */
export const APIS_SEMANTICS_CONTRACT = `THIRD-PARTY PACKAGE ENTRIES ARE NOT DONE WHEN THEY HAVE A SIGNATURE. For every entry whose symbol comes from a third-party npm package — not this project's own source, not a runtime builtin — the line carries a SECOND field saying what the thing MEANS in use: what one of its arguments stands for, what it defaults to, what a path/URL/prefix it is handed is relative to, or what its return value actually is. Format:
  <name>  <one-line signature or use>  — SEMANTICS: <what it means in use>

A TYPE SIGNATURE IS NOT A SEMANTICS CLAUSE, and restating one in prose does not make it one. \`hc(baseUrl: Prefix, options?: ClientRequestOptions)\` names the argument and says nothing about whether that argument is an origin, or a mount prefix, or how it is joined to each route path — which is the fact the implementing agent actually needs, and the one it will otherwise guess wrong. An entry whose SEMANTICS field is missing is UNFINISHED, and your section is not ready to emit while any package entry is unfinished.

HOW TO FILL THAT FIELD — in this order. Do not skip a step, and do not stop after step 1 because you already hold the declaration:
  1. ASK \`pi-worker-docs\` A BEHAVIOUR QUESTION about that package. NOT "what is X's signature", NOT "what types does X export" — those return the declaration you already have. Ask what an argument MEANS, what it DEFAULTS to, what it is RELATIVE to, what HAPPENS when it is given a particular value. For example: \`pi-worker-docs("hono/client", "what does the baseUrl argument to hc MEAN — an origin or a mount prefix — and how is it joined to each route path?")\`.
  2. IF THE PACKAGE TEXT DOES NOT ANSWER IT, ESCALATE. Expect this: bundled \`.d.ts\` declarations frequently carry no semantics at all, because the semantics live in the package's documentation. Call \`pi-worker-search\` with the question, or \`pi-worker-fetch\` on a documentation URL — including any \`@see {@link https://…}\` link that appeared in the text \`pi-worker-docs\` just returned to you.
  3. ONLY IF BOTH FAIL, WRITE THE OPEN QUESTION DOWN, in this exact form:
       <name>  <signature>  — SEMANTICS: UNVERIFIED: <the exact question you could not answer>
     THIS IS A CORRECT AND REQUIRED OUTCOME, not a failure. A named open question is worth far more to the implementing agent than a confident guess, and it is the only acceptable way to finish an entry you could not verify. NEVER fill this field from memory, from what the symbol is named, or from what the API "obviously" does: a plausible wrong semantics clause is the single most damaging thing this section can carry.`
