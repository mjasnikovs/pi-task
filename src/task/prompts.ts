/**
 * Prompt templates for every phase of the pi-task pipeline.
 *
 * Each template is a pure function: inputs → prompt string.  No I/O, no side
 * effects, trivially testable.
 */

export const MAX_GRILL_QUESTIONS = 10

/**
 * Qwen3 "soft switch": placing `/no_think` in the prompt disables the model's
 * <think> reasoning trace for that turn and persists across the tool-call loop
 * within the same child session.
 *
 * On a local reasoning model decode is the bottleneck (~50 t/s here) while
 * prefill is ~10x faster, so cost is dominated by *generated* tokens. A runaway
 * think trace can be 10k+ tokens — minutes — even when the phase's real output
 * is a short list or a one-word verdict (an observed triage spent ~384s
 * thinking to emit "CLEAN"). Stripping the monologue does NOT limit the model's
 * exploration: it still calls every tool it wants and takes every step it
 * needs — it just stops narrating between actions.
 *
 * We strip thinking from the mechanical / exploration phases (refine, the four
 * research workers, verify-tooling, triage) and keep it ON for the judgment
 * phases (compose, grill, critique rewrite) where the reasoning earns its
 * decode cost. pi's `--thinking off` flag is a no-op for this provider
 * (`supportsReasoningEffort: false` in models.json), so the in-prompt soft
 * switch is the reliable control.
 */
export const NO_THINK = '/no_think'

/** Append the Qwen3 `/no_think` soft switch to a prompt. See {@link NO_THINK}. */
export function appendNoThink(prompt: string): string {
    return `${prompt}\n\n${NO_THINK}`
}

const REFINE_PROMPT = (
    raw: string
) => `You receive a user's task description for an AI coding agent. Rewrite it to be unambiguous and actionable.

Output structure (four sections, exact headings, in this order):

GOAL
  One paragraph. What done looks like, in the user's domain language.

CONSTRAINTS
  Bullet list. What must not change, what semantics to preserve, what the agent should avoid touching.

KNOWN-UNKNOWNS
  Bullet list. Questions worth asking the user before implementing, inferred from gaps or ambiguities in the raw prompt.

EXTERNAL-DEPENDENCIES
  Bullet list. Third-party APIs, SDKs, services, protocols, or cloud products the task touches. One bullet per dependency. Format each bullet as:
    - <name>  <one-line search-friendly phrase optimized for current-state web search>
  Two or more spaces separate name from phrase.
  Do NOT list npm packages here — they flow through the existing backtick-package path. If the task mentions a service only by its npm SDK name (e.g. \`@twurple/api\`), still list the underlying service (Twitch) here.
  If the task is purely local with no third-party services, leave this section header in place with zero bullets.

Rules:
- Fix spelling and grammar; output in English regardless of input language.
- Preserve every concrete identifier verbatim (paths, function names, ports, env vars, file:line refs).
- Do not invent requirements not implied by the input.
- Do not output any preamble, commentary, or markdown headings beyond the four sections above.

Task: ${raw}`

// ─── Research fan-out prompts ─────────────────────────────────────────────────

const RESEARCH_READ_ONLY_CONSTRAINT = `IMPORTANT: You are ONLY allowed to READ. Do NOT create, modify, or delete any files. Use the read, grep, find, and ls tools to inspect the repo.`

// Shared guard for every research worker. Open-ended tasks ("analyze the code",
// "how would you improve X", "write a report") tempt a worker into producing the
// deliverable itself — e.g. writing the whole code-review report in the CONTEXT
// section, which then runs for many minutes, gets truncated, and poisons every
// downstream phase. Research only gathers INPUTS for a later spec; it must never
// be the deliverable. This also pins the output format (no preamble, no fences,
// no repeated header) that large/open-ended tasks otherwise drift away from.
const RESEARCH_INPUTS_NOT_DELIVERABLE = `CRITICAL — you are gathering INPUTS for a later spec, NOT performing the task. Even if the task asks you to analyze, review, audit, report, plan, design, or write code, you must NOT produce that deliverable here. Do not write the report/analysis/plan/code. Your entire job is to emit the one structured section described below, which feeds a separate phase that writes the spec. Surveying the repo so that section is accurate is right; producing the task's output is wrong and wastes the run.

OUTPUT DISCIPLINE — strict: emit ONLY the raw section lines described below. No preamble (never "I've read the codebase…", never "Here is the … section"), no closing remarks, no Markdown headings, no code fences (no \`\`\`), and do NOT repeat the section name as a header. The first character of your output is the first entry of the list.`

const RESEARCH_FILES_PROMPT = (
    refined: string
) => `You are doing targeted research for an AI coding agent. Use the read, grep, find, and ls tools to locate every path on disk the agent will read, edit, or reference for the following task. This includes source code AND configuration, schemas, fixtures — any file the agent needs to know exists.

FILES owns paths. APIS owns symbols. Do not omit a path because it "feels like config" — if the agent will touch or read it, list it here.

When a task operates across a whole directory tree (e.g. lint, typecheck, build, format, test-all), list the root directory entry (\`src/  one-line purpose\`) instead of enumerating every file under it. Enumerate individual files only when they need to be singled out — modified specifically, called out by name in the task, or distinct from their siblings in some material way.

RELEVANCE — read carefully: list ONLY paths this specific task touches — the files the agent will read, edit, or must be aware of to complete THIS task. Do NOT inventory the whole repo or list files just because they exist. A file the agent will never open does not belong here. Aim for the smallest sufficient set: include every path the task genuinely reaches and nothing more. There is no fixed limit — a broad task may need many entries, a narrow one only a few. Right-size to the task, not to a number, and collapse directories to their root entry where the task spans a whole tree.

${RESEARCH_INPUTS_NOT_DELIVERABLE}

${RESEARCH_READ_ONLY_CONSTRAINT}

Output ONLY the content of a FILES section — one entry per line, format:
  <path>[:<line>]  <one-line purpose>

No section header. No other sections. No preamble.

Task:
${refined}`

const RESEARCH_APIS_PROMPT = (
    refined: string
) => `You are doing targeted research for an AI coding agent. Use the read, grep, find, and ls tools — and \`pi-worker-docs\` for installed npm packages — to identify the commands, functions, types, and interfaces the agent will use for the following task.

NPM PACKAGES — use pi-worker-docs, NOT file reads: for any third-party npm package (e.g. "zod", "hono", "drizzle-orm"), call \`pi-worker-docs(module, query)\` to get its type signatures and API surface. Do NOT open node_modules source files directly — those reads are expensive and produce far more noise than the tool. The tool returns a compact, focused excerpt in a fraction of the token cost.

PROJECT SOURCE — use pi-worker-docs with module ".", NOT file reads: for any function, class, type, or interface defined in THIS project's own .ts/.tsx source (e.g. "what does requireAuth check?", "what does CreateListingSchema look like?", "what does the listings query module export?"), call \`pi-worker-docs(".", query)\` instead of reading the file. The tool indexes all git-tracked source files and returns only the relevant chunks — far cheaper than reading whole files.

APIS owns symbols and commands BY NAME ONLY. Do NOT include any file path or path fragment — no \`package.json\`, no \`./src/foo.ts\`, no \`package.json#scripts.lint\`. If the symbol is a script defined in package.json, write the invocation (\`npm run lint\`), not its location. If the symbol is a config file, it does not belong in APIS at all — it belongs in FILES.

RELEVANCE — read carefully: list ONLY the symbols the agent will call, implement, modify, or directly depend on for THIS task. Do NOT enumerate the project's entire public surface or dump every exported function in a touched file. A symbol unrelated to the task does not belong here just because it sits in the same module. Keep the smallest sufficient set: include every symbol the task actually exercises and nothing more. There is no fixed limit — list as many as the task truly needs and no padding beyond that.

${RESEARCH_INPUTS_NOT_DELIVERABLE}

${RESEARCH_READ_ONLY_CONSTRAINT}

Output ONLY the content of an APIS section — one entry per line, format:
  <name>  <one-line signature or use>

No section header. No other sections. No preamble.

Task:
${refined}`

const RESEARCH_CONTEXT_PROMPT = (
    refined: string
) => `You are doing targeted research for an AI coding agent. Use the read, grep, find, and ls tools to gather background knowledge and architectural context the agent will need for the following task.

RELEVANCE — read carefully: keep it tight. Each bullet must be an architectural fact that changes HOW the agent implements THIS task — a constraint, a non-obvious data flow, a gotcha, a hidden coupling. No general project tour, no restating the task, no facts the agent would not act on. If a bullet would not change a single implementation decision, drop it. There is no fixed bullet count — include every fact that bears on the task and no filler; fewer sharp bullets beat many shallow ones. If the task is itself an analysis or review, these bullets capture facts that analysis will rely on — they are NOT the analysis; do not write findings or recommendations here.

${RESEARCH_INPUTS_NOT_DELIVERABLE}

${RESEARCH_READ_ONLY_CONSTRAINT}

LIVE-DATA RULE:
- If EXTERNAL CONTEXT contains an "### npm: <pkg>" block, those version numbers are LIVE registry data. Cite them verbatim if you mention versions at all.
- If EXTERNAL CONTEXT contains a "### service: <name>" block, those search results are LIVE web data and are authoritative over training data for that service's current API surface, deprecation status, and replacement systems. Do not contradict them from memory. If you must cite a version, status, or API name for that service, take it from the block.
- If EXTERNAL CONTEXT contains a "### freshness-check skipped" block, you have no current data for the listed services. Do NOT claim their current state from memory; say "current state not verified" and recommend the user verify before implementation.
- Do NOT write bullets like "X is the latest stable" or "version Y is current" from memory — your training data goes stale. Either quote from EXTERNAL CONTEXT or omit the claim entirely.

Output ONLY the content of a CONTEXT section — bullet list, one bullet per line, format:
  - <bullet>

No section header. No other sections. No preamble.

Task:
${refined}`

const RESEARCH_TOOLING_PROMPT = (
    refined: string
) => `You are doing targeted research for an AI coding agent. Inspect the repo to identify the verification tools (lint, typecheck, test, build, e2e, container, dev-server) the project actually has.

${RESEARCH_INPUTS_NOT_DELIVERABLE}

${RESEARCH_READ_ONLY_CONSTRAINT}

Look at package.json scripts, Makefile, pyproject.toml, go.mod, Dockerfile, docker-compose.y*ml, playwright.config.*, .eslintrc*, tsconfig.json, etc. Use exact commands, not guesses. If a tool isn't present in the repo, omit it — don't invent.

Output ONLY the content of a TOOLING section — one entry per line, format:
  <category>  <exact command to invoke>

Categories: lint, typecheck, test, build, e2e/browser, container, dev-server

No section header. No other sections. No preamble. May be empty if no verification tools are found.

Task:
${refined}`

const GRILL_GEN_PROMPT = (
    refined: string,
    research: string,
    priorQA: string
) => `You are preparing clarifying questions for the user, based on a refined task description, the research that follows, and the answers gathered so far. Ask ONE question at a time.

Output the SINGLE most important clarifying question that REMAINS — the one whose answer most changes the work — or NONE if no genuine ambiguity is left.

Start from the KNOWN-UNKNOWNS bullets in the task. Add any new ambiguity surfaced by the research. Drop any unknowns the research already resolved.

ACCOUNT FOR THE ANSWERS SO FAR — read carefully:
- Never re-ask something already answered below.
- If an answer introduced a NEW fork or contradicts an assumption in the task/research (e.g. the user chose a tool or approach the task did not anticipate), ask about the most important consequence of that choice next.
- Drop questions the answers have made irrelevant.

SCOPE RULES — read carefully:
- Questions must clarify the EXISTING scope. Do NOT propose new deliverables, enhancements, modernizations, or "while I'm here" cleanups.
- Forbidden patterns: "should I also…", "should we modernize…", "do you want me to update X while I'm at it…", "should I integrate Y…", "would you like guidance on Z…".
- Allowed patterns: "by 'X' do you mean A or B?", "should failure mode Y be treated as Z?", "which of <files matching the task> applies here?".
- If nothing genuinely ambiguous remains, output NONE. Zero questions is a valid and preferred outcome. Do not pad.

Output format — read carefully:
- One question as a single numbered line: "1. ...", and nothing else.
- If no question remains: emit the single literal token NONE on its own line. Do NOT emit empty output — an empty response is treated as a crash, not as "no questions". The NONE sentinel is the only way to signal an intentional empty list.

Refined task:
${refined}

Research:
${research}

Answers so far:
${priorQA.trim() || '(none yet)'}`

const GRILL_AUTO_ANSWER_PROMPT = (
    refined: string,
    research: string,
    question: string
) => `You are pre-answering a clarifying question for an AI coding task. You have the refined task and the research notes. You may use the read tool on files mentioned in the research (e.g. package.json) if it helps.

Your job is to produce a recommended default. If the default is one the user would almost certainly accept without thinking, tag it ANSWER and skip the user. Otherwise tag it UNKNOWN. YOU MUST PROPOSE A DEFAULT — never refuse, never leave it empty.

LIVE-DATA RULE:
- "### npm: <pkg>" blocks in EXTERNAL CONTEXT are LIVE registry data; use those version numbers, do NOT invent them from memory.
- "### service: <name>" blocks are LIVE web data; authoritative over training data for that service.
- "### freshness-check skipped" → tag UNKNOWN and say current state needs verification.
- No npm block + question is about latest/current version → tag UNKNOWN (training data goes stale).

REVERSIBILITY TEST:
  ANSWER: cheap to undo (output style, policy, report format, obvious scope, standard convention).
  UNKNOWN: costly to reverse (file mutations, tool/dependency choice, approach/algorithm, format that shapes downstream artifacts).

When the question is a binary "A or B?" choice, emit BOTH options:
  UNKNOWN: <primary recommendation>
  ALT: <alternative>

Output — no preamble, no markdown:
  ANSWER: <one-line answer>
  UNKNOWN: <primary option>
  ALT: <secondary option>     ← required when question is "A or B?"; omit otherwise

Examples:
  ANSWER: report a summary with counts and representative examples
  ANSWER: treat all warnings and errors as genuine issues
  UNKNOWN: use npm
  ALT: use pnpm
  UNKNOWN: write output to ./report.md
  UNKNOWN: extract with a post-processing regex step
  ALT: rewrite the system prompt

Refined task:
${refined}

Research:
${research}

Question: ${question}`

function composeRetryEmphasis(problem: string): string {
    if (
        problem === 'spec does not start with GOAL'
        || problem === 'spec starts with a markdown fence'
        || problem === 'spec is wrapped in a cat heredoc'
    ) {
        return '\nPREVIOUS ATTEMPT VIOLATED THESE RULES. The very first characters of your output MUST be the letters G-O-A-L. Not a backtick, not `cat`, not a heredoc — the literal word GOAL.\n'
    }
    if (problem.startsWith('spec missing required section:')) {
        const section = problem.replace('spec missing required section: ', '')
        return `\nPREVIOUS ATTEMPT was missing the ${section} section. All four sections are required and must be non-empty: GOAL, CONSTRAINTS, ACCEPTANCE, VERIFY.\n`
    }
    return `\nPREVIOUS ATTEMPT was invalid (${problem}). Ensure all four sections are present and the output starts with the literal word GOAL.\n`
}

const COMPOSE_PROMPT = (
    refined: string,
    research: string,
    qa: string,
    retryProblem: string | null
) => `You are composing the final implementation spec for an AI coding agent. Combine the refined task, the research, and the user's Q&A answers into one spec.

CRITICAL FORMAT RULES (read first):
- Output the spec as plain markdown text. Do NOT wrap your entire output in a code block, shell fence, or heredoc. Do NOT prefix with \`\`\`sh / \`\`\`bash. Do NOT use \`cat << EOF > file\` patterns. Your response begins literally with "GOAL" on the first line.
- The ONLY fenced code block in your output is the one immediately following \`VERIFY:\` — and that fence must be \`\`\`sh, not \`\`\`bash, not anything else.
- No preamble, no commentary, no trailing summary.
${retryProblem ? composeRetryEmphasis(retryProblem) : ''}
Output exactly four top-level sections in this order. Every section must be present and non-empty.

GOAL
  <one paragraph>

CONSTRAINTS
  - <bullet>
  - …

ACCEPTANCE
  - <human-readable success criterion>
  - …

VERIFY:
\`\`\`sh
<runnable shell command 1>
<runnable shell command 2>
\`\`\`

VERIFY must contain real, runnable commands the receiving agent can execute via \`bash -c\`. No placeholders. No "TODO". No "your test here".

VERIFY must exercise the surface area the task actually touches. Draw VERIFY commands only from VERIFIED-TOOLING (the pre-validated subset of the research TOOLING section) — do not invent tools the repo does not have. Apply these rules:
- HTML / CSS / client-side JS / UI changes → MUST include a browser-driving check. If the repo has playwright, use it (e.g. \`npx playwright test\`). If not, at minimum start the dev server and curl the affected route to confirm it serves 200 and the expected markup. A bare "open the page" instruction is not acceptable — it must be a shell command.
- Dockerfile / docker-compose changes → MUST include a real build (\`docker build …\` or \`docker compose build\`) and, where feasible, a smoke run that proves the container starts (e.g. \`docker run --rm <img> <cmd>\` or \`docker compose up -d && docker compose ps\`).
- TypeScript / JavaScript source changes → MUST include the project's typecheck, lint, and test commands when those scripts exist in TOOLING. Include build only if the change could affect the build output.
- Python / Go / Rust / other source changes → MUST include the language's standard verification from TOOLING (e.g. \`pytest\`, \`go test ./...\`, \`cargo test\`) plus lint/typecheck if configured.
- Config / infra-only changes with no executable verification → state that explicitly with a single command that re-reads or validates the config (e.g. \`docker compose config\`, \`nginx -t\`, \`yamllint file.yml\`). Never leave VERIFY with only \`true\` or \`echo ok\`.

If TOOLING is empty for a category the change clearly touches, still include the best-effort standard command for that ecosystem (e.g. \`npx tsc --noEmit\` for a TS repo with no script) and note that the receiving agent may need to install it.

Refined task:
${refined}

Research:
${research}

User Q&A:
${qa}`

// Fast triage pass run before the (expensive) full rewrite. It produces either
// the single token CLEAN — meaning the compose draft needs no rewrite — or a
// short defect list. When CLEAN, the orchestrator returns the draft unchanged
// and skips the rewrite entirely; otherwise the defects are fed into
// CRITIQUE_PROMPT as a focus list so the rewrite targets real problems instead
// of re-deriving them from scratch.
const CRITIQUE_TRIAGE_PROMPT = (
    spec: string,
    refined: string,
    qa: string
) => `You are triaging an implementation spec for an AI coding agent. Decide whether it needs a rewrite. Do NOT rewrite it — only judge it.

The refined task and the user's Q&A below are GROUND TRUTH. Judge the spec against them. Look for SUBSTANTIVE defects only:
- ambiguity that would let the agent build the wrong thing
- acceptance criteria that are vague, unmeasurable, or missing
- a VERIFY block that is missing, unrunnable, full of placeholders, or does not exercise the surface the task touches
- scope drift: requirements, files, or deliverables not implied by the refined task or Q&A
- a dropped or weakened CONSTRAINT from the refined task

Do NOT flag cosmetic wording, style, or anything you would change only to "polish" prose. The bar is: would this defect change what the agent builds or whether the work can be verified?

Output format — read carefully:
- If the spec has NO substantive defects, output the single literal token CLEAN on its own line. Nothing else.
- Otherwise output a short plain list, one defect per line, naming the section and the problem (e.g. "ACCEPTANCE: criterion 3 is unmeasurable — 'works well' has no check"). No rewrite, no preamble, no fixed spec.

Refined task (ground truth):
${refined}

User Q&A (ground truth):
${qa}

Spec to triage:
${spec}`

const CRITIQUE_PROMPT = (
    spec: string,
    refined: string,
    qa: string,
    addVerifyEmphasis: boolean,
    triageDefects: string | null = null
) => `You are reviewing the implementation spec below for ambiguity, weak acceptance criteria, and missing or unrunnable VERIFY commands.

CRITICAL FORMAT RULES (read first):
- Output the rewritten spec as plain markdown. Do NOT wrap your entire output in a code block, shell fence, or heredoc. Do NOT prefix with \`\`\`sh / \`\`\`bash. Do NOT use \`cat << EOF > file\` patterns. Your response begins literally with "GOAL" on the first line.
- The ONLY fenced code block in your output is the one immediately following \`VERIFY:\` — and that fence must be \`\`\`sh.
- No separate critique section, no preamble, no trailing summary — just the rewritten spec.

SCOPE RULES (equally critical — do not break these):
- The refined task and the user's Q&A below are GROUND TRUTH. The rewritten spec must stay faithful to them.
- Do NOT introduce new requirements, deliverables, files, scripts, hooks, configs, or acceptance criteria that are not explicitly implied by the refined task or the Q&A.
- Do NOT broaden scope. If the refined task says "run X and report", do not turn it into "build a toolchain around X with hooks, docs, and reports".
- CONSTRAINTS from the refined task MUST be preserved in spirit. Do not silently drop or weaken them.
- If the spec below is malformed, empty, or wrapped in a heredoc, reconstruct it from the refined task and Q&A — not from your own invention.
- Your job is to tighten language, sharpen acceptance criteria, and ensure VERIFY is runnable. Not to redesign the task.

Rewrite the spec in the same four-section format (GOAL, CONSTRAINTS, ACCEPTANCE, VERIFY). Fix any issues you find within the scope rules above.

VERIFY QUALITY CHECK (apply during the rewrite):
- VERIFY must exercise the surface the task touches, using tools the repo actually has (see research notes).
- Frontend / HTML / CSS / UI tasks → must include a browser-driving step (playwright if available; otherwise a dev-server + curl smoke test). Reject bare "open browser and check" instructions.
- Dockerfile / compose tasks → must include a real \`docker build\` (or \`docker compose build\`) and, where feasible, a container smoke run.
- Source-code tasks → must include the project's typecheck, lint, and tests when those exist. Do not drop them to "simplify".
- If the existing VERIFY is missing or too thin for the change being described, expand it using commands consistent with the research notes. Do not invent tooling that isn't present.
- Never accept \`true\`, \`echo ok\`, or other no-op commands as VERIFY content.

${addVerifyEmphasis ? 'REQUIRED: The output MUST include a VERIFY: section followed by a ```sh fenced block of runnable shell commands. The previous attempt was missing this.' : ''}
${
    triageDefects ?
        `FOCUS — a triage pass already found these specific defects. Fix every one of them in your rewrite (without breaking the scope rules above):\n${triageDefects}\n`
    :   ''
}
Refined task (ground truth):
${refined}

User Q&A (ground truth):
${qa}

Spec to rewrite:
${spec}`

const VERIFY_TOOLING_PROMPT = (
    tooling: string
) => `You receive a TOOLING list of candidate verification commands for an AI coding task.

YOU MAY ONLY READ. Do NOT execute any of the listed commands, not even with --help or --dry-run. Use ls/cat/grep/find/which/command -v (the BUILTIN command -v, NOT executing the candidate binary) to inspect static evidence:
  - package.json scripts
  - Makefile targets
  - the presence of config files (tsconfig.json, playwright.config.*, .eslintrc*, etc.)
  - binaries inside node_modules/.bin/
  - system binaries in PATH (via command -v)

Output exactly two sections:

VERIFIED
  <command>  <one-line evidence: where it was found>
  ...

REJECTED
  <command>  <one-line reason it can't be confirmed>
  ...

Do not add other sections, preamble, or commentary.

TOOLING (one command per line):
${tooling}`

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
    REFINE_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_TOOLING_PROMPT,
    RESEARCH_READ_ONLY_CONSTRAINT,
    GRILL_GEN_PROMPT,
    GRILL_AUTO_ANSWER_PROMPT,
    COMPOSE_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT,
    VERIFY_TOOLING_PROMPT,
    composeRetryEmphasis
}
