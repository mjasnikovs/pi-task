/**
 * An output-contract clause for the APIS research prompt that is NOT wired in.
 *
 * READ THIS FIRST: nothing splices this into `RESEARCH_APIS_PROMPT`. The only
 * references to `APIS_SEMANTICS_CONTRACT` in the tree are its own tests and a
 * regression guard in prompts.test.ts that asserts the shipped prompt does NOT
 * contain it. The text is kept, and pinned by tests, so the lever can be read and
 * re-tried — not because it is in use.
 *
 * WHAT IT WOULD CHANGE. `worker:apis` treats an entry as finished once it has a
 * SIGNATURE, because that is what its output format asks for. A signature says
 * nothing about what an argument MEANS, and the implementing agent has to guess —
 * a plausible wrong guess about a base URL or a default is the most damaging thing
 * this section can carry. The clause moves the completion bar: an entry is
 * unfinished until it also carries a SEMANTICS field.
 *
 * STEP 3 OF THE FALLBACK IS LOAD-BEARING. DO NOT "CLOSE" IT. The `UNVERIFIED:`
 * escape is mandatory and is not a loophole: a worker that may not abstain has
 * nowhere to put an uncheckable fact except into a confident claim. A lever that
 * buys behaviour questions with fabrication is a regression, not a win.
 *
 * Wording notes, each answering something the shape of the prompt forces. All four
 * are present in the string below, checked:
 *  - "NOT DONE WHEN THEY HAVE A SIGNATURE" is the whole lever. The worker stops by
 *    format, so the change has to move the format's bar, not add advice.
 *  - the worked example (`hc(baseUrl: Prefix, …)`) shows an entry that does NOT
 *    satisfy the rule. A rule with no counter-example reads as satisfied by
 *    anything.
 *  - step 2 says escalation is EXPECTED — "Expect this:" — rather than permitted.
 *    Bundled `.d.ts` files genuinely carry no semantics, and "you may escalate"
 *    tells a worker nothing it did not already have.
 *  - step 3 is stated as "A CORRECT AND REQUIRED OUTCOME", in those words, so the
 *    field cannot be closed by guessing.
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
