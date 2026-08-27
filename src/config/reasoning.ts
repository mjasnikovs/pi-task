/**
 * Reasoning profiles — which thinking level each group of model children runs at.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every pi-task child inherits `defaultThinkingLevel` from the host's
 * `~/.pi/agent/settings.json`, because `CHILD_BASE_ARGS`
 * (shared/child-process.ts) passes no `--thinking`. That is one level for ~33
 * children whose jobs are nothing alike: a planner that must reason to produce a
 * plan at all, and a label-compressor that emits four words.
 *
 * The control that WAS here — appending Qwen3's `/no_think` soft switch to eight
 * prompts — is measured inert. Captured live against Qwen3.8-27B with server
 * thinking on and `/no_think` still in the prompt: median 17k-char trace anyway,
 * n=25. A harness cannot disable thinking by prompt text; the chat-template
 * kwarg beats it. `--thinking` sets that kwarg, so it is the lever that works.
 *
 * PURE MODULE — no imports with runtime side effects, so `config.ts` can import
 * the table and the sanitizers during its own module evaluation. `getConfig()`
 * lives one hop away in `reasoning-args.ts` for exactly this reason: importing
 * it here would make config.ts ⇄ reasoning.ts a real cycle, and whichever module
 * a caller reached first would decide whether `DEFAULT_REASONING_TABLE` was
 * initialised before `DEFAULT_CONFIG` read it.
 */
import type {PiTaskConfig} from './config.js'

/**
 * The child roles that share one reasoning setting.
 *
 * Grouped by JOB, not by spawn mechanism — two children that both go through
 * `runWorker` (a research worker and a verify gate) want different amounts of
 * thinking, while two that reach the model by different code paths (`refine` via
 * runPhaseChild, `compress-label` via the same) want the same.
 *
 * - `research`     the four research workers, plus the ad-hoc `pi-worker` tool
 * - `phase`        refine, verify-tooling, grill, compose, critique, compress-label
 * - `planning`     /task-auto's clarify / decompose / extract children
 * - `plan`         /task-plan's question and answer children
 * - `gate`         enforce, verify, lint-fix, final-fix, recommend
 * - `extraction`   the --no-tools focused docs/fetch extractors
 * - `implementation` the host-session turn that writes the code (not a child)
 */
export type ReasoningGroup =
    | 'research'
    | 'phase'
    | 'planning'
    | 'plan'
    | 'gate'
    | 'extraction'
    | 'implementation'

export const REASONING_GROUPS: readonly ReasoningGroup[] = [
    'research',
    'phase',
    'planning',
    'plan',
    'gate',
    'extraction',
    'implementation'
] as const

/**
 * The four profiles offered by /task-config.
 * - `default` the measured per-group table below
 * - `on`      one level everywhere ({@link REASONING_ON_LEVEL})
 * - `off`     no thinking anywhere
 * - `custom`  the user's own per-group table
 */
export type ReasoningMode = 'default' | 'on' | 'off' | 'custom'

export const REASONING_MODES: readonly ReasoningMode[] = ['default', 'on', 'off', 'custom'] as const

/**
 * What one group is set to.
 *
 * `inherit` is NOT a pi thinking level — it means EMIT NO FLAG, so the child
 * falls back to `settings.json` exactly as it does today. It is what lets this
 * whole feature ship as a zero-behaviour-change commit: with every cell at
 * `inherit`, every child's argv is byte-identical to the version before it.
 */
export type GroupSetting = 'inherit' | 'off' | 'minimal' | 'low' | 'medium' | 'high'

/**
 * The settings offered in /task-config: `inherit` plus pi's OWN cycle
 * (`THINKING_LEVELS` in pi-coding-agent's agent-session).
 *
 * `xhigh` and `max` are DELIBERATELY ABSENT. pi treats an absent
 * `thinkingLevelMap` entry as "supported" for the standard levels but requires a
 * declared entry for the extended two (pi-ai `getSupportedThinkingLevels`), so a
 * model with no map would receive the raw string — and Qwen3.8's chat template
 * answers an unknown effort with HTTP 500, not a clamp. Offering a level that pi's
 * own UI does not is how you ship a `--thinking` that hard-fails on some models.
 * This machine already reaches xhigh through `"high": "xhigh"` in its map.
 */
export const REASONING_SETTINGS: readonly GroupSetting[] = [
    'inherit',
    'off',
    'minimal',
    'low',
    'medium',
    'high'
] as const

/**
 * The level mode `on` uses, and the treatment arm of the A/B that fills in
 * {@link DEFAULT_REASONING_TABLE}. ONE constant so the shipped config and the
 * measurement behind it can never drift apart.
 */
export const REASONING_ON_LEVEL: GroupSetting = 'medium'

/**
 * The per-group table used by mode `default`.
 *
 * A cell is `inherit` until it has been MEASURED, and then it names a level.
 * Every non-`inherit` cell here must be a live A/B result
 * (scripts/live-reasoning-group-ab.ts, n>=20 per arm, arms `off` vs
 * {@link REASONING_ON_LEVEL}) carrying its date, model, counts and RUNG in the
 * comment beside it. A cell filled in from intuition is WORSE than `inherit`:
 * `inherit` is honest about knowing nothing, while a wrong cell is a
 * measurement nobody took, wearing the authority of a default.
 *
 * THE RUNG IS PART OF THE RESULT, so read it before trusting a cell. The
 * harness returns a two-way verdict — `off` or {@link REASONING_ON_LEVEL},
 * never a tie — down a three-rung ladder: rung 1 a significant quality
 * difference, rung 2 quality level and a significant speed difference, rung 3
 * nothing separated the arms and the cheaper level carries it by a stated
 * prior. A rung-3 cell is a DECISION, not a finding: it says "no reason found
 * to pay for thinking", not "thinking was shown not to help". At n=20/arm the
 * run is only powered for large effects, so rung 3 is the common outcome and
 * an absent effect and an undetected one look identical from here.
 *
 * NOTHING IS ALREADY ON THE RECORD, and the belief that something was is worth
 * writing down. This docstring used to say magicknumbers.md had measured the
 * decompose child "with one knob, `enable_thinking` — off answered 1/10, on
 * answered 8/8", and treated that as the split the A/B had to reproduce.
 *
 * VERIFIED 2026-08-27: the string "8/8" does not appear in magicknumbers.md, and
 * never has (`git log -S`; the phrase was introduced by THIS file's own commit,
 * `0b91f71`). What that page records is
 *
 *     "Measured, captured decompose request, REASONING OFF, n=10 per cell:
 *      1/10 → 7/10 (stall detector) → 8/9 (all three)."
 *
 * — a ladder over THREE GUARDS at CONSTANT reasoning off, from `fea7bbb`. Both
 * endpoints are the same arm. `enable_thinking` is not its knob and never was,
 * and the "8/8" is a misread of the ladder's last cell, `8/9`.
 *
 * So no reasoning effect on `planning` had ever been measured, and the 10/10 vs
 * 10/10 read on the current tree was not a contradiction of a prior result — it
 * was the only reading there had ever been. The controls that page DOES record
 * (Qwen3.6-27B 10/10, Gemma4-12B 10/10) are likewise reasoning off, so they say
 * nothing about a cell flipping by model either.
 *
 * The `planning` cell below is the FIRST measured reading of that knob, taken
 * 2026-08-27 on a citation-fidelity axis built for it. It is also the first cell
 * that is not `off`.
 */
export const DEFAULT_REASONING_TABLE: Readonly<Record<ReasoningGroup, GroupSetting>> = {
    // A/B 2026-08-26, Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf (llama.cpp
    // b10620-0f3b51e03), scripts/live-reasoning-group-ab.ts, n=12/arm over 12
    // distinct mx5 tasks. off 10/12 vs medium 11/12 (p=1.0000); neither arm
    // failed to answer. Wall clock, PAIRED by stimulus over the 10 pairs usable
    // in both arms: p=0.7090, mean off 79.4s vs medium 59.3s.
    // off real+edited-named 95% CI [0.55, 0.95].
    // RUNG 3 — a DECISION, not a finding. Nothing separated the arms on either
    // axis, and off carries it by the stated prior: thinking that buys nothing
    // measurable is not worth its tokens. At 12 pairs an absent effect and an
    // undetected one look the same from here. Ledger: ledger-research.jsonl.
    //
    // THE AXIS IS THE CONJUNCTION, built for this run: every path the answer
    // names is real AND every pre-existing file the task edited is named
    // (`filesAnswered`, scripts/reasoning-ab-files-truth.ts). Recall truth is
    // the shipped tree, not the recorded answer. Screened offline: restricted
    // to pre-existing files the recorded answers score 86.6% (71/82 paths, 29
    // of 38 tasks perfect); counting CREATED files instead drops them to 49.0%
    // and the CHECK loses, so a file that does not exist yet is not truth.
    // It is NOT saturated here — 10/12 and 11/12, with genuine judgement errors
    // in both arms — so the clock was allowed to decide and declined to.
    //
    // THE STIMULI ARE HALF THE AXIS. The superseded precision-only run
    // (ledger-research.PRECISION-ONLY-10rep.jsonl, `--axis precision` to
    // reproduce) tied 10/10 on TASK_0002..0012, the greenfield head of the mx5
    // run — SEVEN OF THOSE TEN EDIT NO PRE-EXISTING FILE AT ALL, so it measured
    // recall where recall does not exist. `filesRecallStimuli` screens for it;
    // these 12 tasks each edit >=2 pre-existing files. That ledger CANNOT be
    // rescored onto this axis and the rescorer abstains rather than return a
    // number.
    //
    // INSTRUMENT NOTE, because this cell read `off 8/12` before it. `filesPaths`
    // split an entry on TWO spaces, which is what the prompt specifies and what
    // all 470 recorded paths use. Three live `off` trials wrote
    // `src/client/main.tsx: App root` — one space after a colon — so the
    // description was taken as part of the path and TASK_0053 scored 0/19 with
    // all 19 paths real. Fixed by `COLON_ENTRY`; rescored from stored text with
    // no GPU, 2 of 24 trials changed side, and the known-good answer is
    // unmoved (53/56 whole-corpus precision, identical path counts). This is
    // [[ab-scorer-must-see-the-same-input]] a second time in one function.
    //
    // THE CONFOUND THE PRECISION RUN EXPOSED IS STILL VISIBLE and still points
    // the other way: off named 212 real paths to medium's 153, while medium
    // named 27/27 edited files to off's 26/27. Off says more and is slower for
    // it. The conjunction was built so that neither half can be gamed alone,
    // and on these numbers it separates neither arm.
    //
    // AXIS RE-AUDITED 2026-08-27, after planning's adjudicator turned out to
    // have four bugs. One more was found here and it is the SAME-INPUT rule
    // broken a third time: `filesPaths` read the child's whole raw turn, while
    // the SCREEN sliced the recorded `## research` down to its FILES block
    // precisely because APIS is symbols and would score as 100% invented. One
    // `off` trial emitted its own `APIS` heading despite the prompt's "No other
    // sections", and three symbols under it — `cn` and two `--*` token lists —
    // were counted as invented paths, failing a trial whose FILES block was
    // 20/20 real. The slice now lives in `filesPaths`, where both callers reach
    // it. The cell is UNCHANGED: that trial still fails, on a genuine recall
    // miss (`src/client/types.d.ts`), and the counts are identical.
    // The other two failures were checked by hand and are genuine — both arms
    // put `AdminPage.spec.tsx` / `.story.tsx` under `src/client/routes/` when
    // they ship under `src/client/pages/`, a wrong-directory prediction made
    // from a real sibling.
    //
    // MEASURED UNDER THE SERVER'S GLOBAL SAMPLER, which is the THINKING preset,
    // so the `off` arm decodes on sampling tuned for the `on` arm. That is the
    // regime this machine really runs pi-task in, so the result is
    // ecologically valid — it is NOT a clean comparison.
    research: 'off',
    // NOT MEASURED, and that is a finding rather than an omission. Three
    // candidate axes were each scored against refine's OWN RECORDED OUTPUT and
    // rejected before any GPU: `validateRefineShape` scores 55/56 — saturated;
    // "EXTERNAL-DEPENDENCIES names a real package" finds 4 distinct packages
    // across all 56 tasks — no signal; "every backticked path exists" scores
    // the recorded answers at 56.2%, 6/56 perfect — the CHECK loses, not the
    // answer, and a scorer the known-good answer cannot clear may not judge
    // anything. Running phase on the shape axis would buy a rung 3 for an hour
    // of GPU. ledger-phase.VOID-wrong-scorer.jsonl stores no output text, so its
    // apparent off 2/14 vs medium 6/14 is an artefact that cannot be rescored.
    // DO NOT READ A RESULT INTO IT.
    //
    // THE THIRD AXIS WAS RE-AUDITED 2026-08-27, because planning's citation axis
    // was rejected the same way at 59.2% and reached 97.1% once four adjudicator
    // bugs were fixed. THE CHECK WAS INDEED LOSING, and by a lot.
    // scripts/phase-path-axis-audit.ts walks the ladder:
    //
    //     NAIVE            60.1% of paths,  5/55 tasks perfect
    //     CATEGORY-CLEAN   83.8% of paths, 34/52 tasks perfect
    //     FINAL-TREE       93.4% of paths, 43/52 tasks perfect
    //
    // CATEGORY-CLEAN drops the spans that were never repo paths: npm specifiers
    // (`@hono/zod-validator`, `hono/client`), doc URLs, MIME types, dotted code
    // expressions (`c.var.user` — nine of them), bare filenames with no
    // directory, and `./`/`../` import specifiers. FINAL-TREE additionally counts
    // a path real if it exists anywhere in the tree the RUN shipped, which stops
    // marking a CORRECT PREDICTION wrong — 16 of the 27 remaining misses are
    // files a later task really creates, which is [[reasoning-research-recall-
    // axis-built]]'s "a file that does not exist yet is not truth" seen from the
    // precision side.
    //
    // IT IS STILL NOT A USABLE AXIS, and the reason has changed. At 93.4% the
    // ELEVEN residual misses are almost all PATH-PREFIX ELISIONS — `server/
    // index.ts` for `src/server/index.ts`, `client/main.tsx` for
    // `src/client/main.tsx`, `routes/auth.ts` for `src/server/routes/auth.ts`.
    // Loosen enough to accept a suffix match and the axis saturates; keep them
    // and the A/B measures whether refine writes the `src/` prefix. That is
    // formatting, not reasoning, and neither arm should be paid for it.
    // The finding stands — with a much better-established reason than "56.2%".
    phase: 'inherit',
    // A/B 2026-08-27, Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf (llama.cpp
    // b10620-0f3b51e03), scripts/live-reasoning-group-ab.ts, n=30/arm over the
    // committed mx5 fixture replayed 30 times. Ledger: ledger-planning.jsonl.
    //
    // THE FIRST CELL THAT IS NOT `off`, and the only one where the two axes
    // point in opposite directions. Read both.
    //
    // off 28/30 faithful plans vs medium 26/30 (p=0.6707); neither arm ever
    // failed to terminate. Wall clock, UNPAIRED — one fixture, so there are no
    // distinct stimuli to pair by and `pairByStimulus` refuses rather than
    // invent a pairing: mean off 207.3s vs medium 143.6s, p=0.0241.
    // off faithful-plan 95% CI [0.79, 0.98].
    // RUNG 2 — quality is level on an axis with headroom, and medium is 1.4x
    // faster at equal quality. The ladder is symmetric: `off` losing the clock
    // is not privileged over `medium` losing it.
    //
    // THE CLOCK CAVEAT, because the direction is the opposite of every other
    // cell. off's mean is tail-driven — medians are 157.6s vs 148.2s, ~6% apart
    // — and off emits a LONGER plan for the same title count (median 6840 vs
    // 4988 chars, 13 titles both arms). Per character off is the faster arm,
    // 23.0 vs 29.7 ms/char. So what the clock records here is "off writes more",
    // not "thinking is free". Production waits for the whole plan, so the cost
    // is real; it is not evidence that thinking decodes faster.
    //
    // THE AXIS IS `planningPlanFaithful`, built for this run:
    //   a plan is FAITHFUL when it lists >= 2 titles AND EVERY source clause it
    //   emitted — counted in the RAW TITLE — comes back grounded.
    // It is production's own adjudicator (`extractTitleSource`) with no model in
    // the loop, and the source doc is a committed fixture, so every stored trial
    // stays rescorable with no corpus:
    //   bun run scripts/rescore-reasoning-ledger.ts \
    //     ab-grouplab/ledger-planning.jsonl planning --from-text
    // Counting the clauses in the RAW title is load-bearing: a malformed clause
    // (a missing closing quote — measured live, 4 trials) stops the peel, and a
    // scorer that counted only what it peeled reads everything before the break
    // as a clean sweep.
    //
    // THE OLD AXIS WAS A SHAPE CHECK. `parseDecomposeList >= 2` read 10/10 in
    // both arms at n=10/arm — saturated, the same death as gate's and phase's
    // first scorers. ledger-planning.SHAPE-AXIS-no-extension-10rep.jsonl is that
    // run; it is a PRIOR, NOT A REPLICATE, because it also ran a different child
    // (no single-read extension). Do not pool it.
    //
    // THE ADJUDICATOR HAD TO BE FIXED FOUR TIMES BEFORE IT COULD JUDGE, and
    // every fix was found by auditing failures row by row, not by reading code:
    //   1. GREEDY REGEX across multi-clause titles (25% of real titles carry
    //      more than one clause) — two real citations became one superstring.
    //   2. MARKDOWN EMPHASIS/LIST MARKERS counted as content.
    //   3. CODE BACKTICKS counted as content — the larger half of (2), and
    //      found only after this run. A code span renders as bare text, so
    //      `Invites — create/validate/redeem, /join/:token page.` is a verbatim
    //      copy of a line the file stores with backticks. Screening EVERY spec
    //      line of the fixture in its rendered form: 107/216 grounded before,
    //      216/216 after, floor 0/216.
    //   4. BACKSLASH-ESCAPED QUOTES. The clause is double-quoted, so a spec line
    //      containing a double quote comes back as `\"`. The backslash is the
    //      delimiter's artefact, not content.
    // The live run scored off 21/30 vs medium 24/30 and printed `medium`; fixes
    // 3 and 4 moved 9 of 60 trials and the QUALITY ORDER REVERSED, to off 28/30
    // vs medium 26/30. The verdict survives only because the clock decides at
    // rung 2. scripts/decompose-fidelity-screen.ts is the standing screen that
    // would have caught 3 and 4 before the GPU ran.
    //
    // THE REMAINING 6 FAILURES ARE GENUINE, checked by hand: 4 malformed clauses
    // (missing closing quote or bracket), 1 word substituted in a real line
    // ("invokes" for "invites"), 1 single-quoted where the doc has double.
    //
    // THE HARNESS SPAWNS PRODUCTION'S CHILD. `phaseDeps()` passed no
    // `childExtensions`, so auto-decompose ran WITHOUT the single-read guard
    // production hands every planning child (auto-orchestrator.ts). Fixed before
    // this run; `loadableSingleReadExtension()` maps src->dist and ABSTAINS if
    // neither exists, so `bun run build` is a precondition.
    //
    // THE TARGET THIS CELL ONCE CHASED DOES NOT EXIST. "off ~1/10 vs on ~8/8
    // from magicknumbers.md" was cited here and in this file's header as the
    // split a positive control had to reproduce. Verified 2026-08-27: that page
    // has no "8/8" in it and never did, and its `1/10 -> 7/10 -> 8/9` ladder is
    // labelled REASONING OFF, n=10 per cell — three GUARDS from `fea7bbb`, one
    // arm throughout. See the header.
    //
    // A pre-`fea7bbb` control tree WAS built and verified anyway
    // (ab-grouplab/make-preguard-tree.sh + preguard-probe.ts, all four guard
    // behaviours rolled back and asserted both ways). It is the only planning
    // regime known to have headroom at reasoning off — 1/10 there — but it is a
    // regime we deleted, so a cell decided in it would not be writable here.
    // Left unrun on purpose.
    //
    // MEASURED UNDER THE SERVER'S GLOBAL SAMPLER, which is the THINKING preset.
    // Here that cuts AGAINST the written cell rather than for it: the `off` arm
    // decoded on sampling tuned for `medium` and still led on quality, so a
    // clean comparison could only widen off's quality margin — which the clock
    // then has to overcome. Ecologically valid, not clean.
    planning: 'medium',
    // `inherit` ON PURPOSE, and this is the one cell where that is an ANSWER
    // rather than an absence of one.
    //
    // /task-plan is INTERACTIVE. The user is sitting in the loop, reading each
    // question and steering the next one, and how much thinking that wants is
    // theirs to judge per session — a quick sketch and a hard architectural
    // plan are the same command. Every other group in this table runs
    // unattended, where nobody is there to turn a knob and the table has to
    // decide. Here there is, and it should not be overridden.
    //
    // `inherit` means the child gets whatever `~/.pi/agent/settings.json` holds
    // — that is the general objection to it, and here it is exactly the point:
    // the setting the user chose is the setting the user gets.
    //
    // It is also unmeasured: /task-plan has never executed inside the A/B
    // corpus, so there is no recorded child turn to replay. But that is not why
    // the cell reads `inherit`. Recording a run and measuring the group would
    // not change it.
    plan: 'inherit',
    // A/B 2026-08-26, Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf (llama.cpp
    // b10620-0f3b51e03), scripts/live-reasoning-group-ab.ts, n=30/arm.
    //
    // SCORED AGAINST THE TREE, NOT THE ANSWER'S SHAPE. Ten mx5 tasks were
    // screened by EXECUTING each one's own VERIFY with no model in the loop:
    // it fails on the before-tree and passes on the after-tree. So the child
    // faces 20 (task, tree) pairs whose correct verdict is a fact — FAIL before,
    // PASS after — balanced, so always-PASS and always-FAIL each score exactly
    // 50%. The verdict is read by production's own `parseVerifyVerdict`.
    // UNOBSERVED scores WRONG: the harness just executed the evidence, so
    // declining to look is a failure to do the job.
    //
    // off 28/30 correct verdicts vs medium 28/30 (p=1.0000); neither arm ever
    // failed to emit a verdict. Wall clock, PAIRED by stimulus over the 27
    // pairs usable in both arms: off is faster in 23 of them, geometric mean
    // 0.61x, p=0.0019. off correct-verdict 95% CI [0.79, 0.98].
    // RUNG 2 — quality is level on an axis with headroom, and off is 1.6x
    // faster at equal correctness. Not a prior: the axis recorded four genuine
    // judgement errors across the run, so it could have separated the arms and
    // did not.
    //
    // TWO INSTRUMENT NOTES, because this cell read differently before both.
    // (1) The clock test was UNPAIRED on a matched design. Every stimulus runs
    //     once per arm, and the stimulus dominates: the same child is ~25s on a
    //     before-tree and 100-500s on an after-tree. Pooling buried the arm
    //     effect. On these numbers the unpaired test reads p=0.3408 and the
    //     paired one p=0.0019. Fixed in `pairedPermutationP`.
    // (2) The 20-rep run alone scored 20/20 vs 20/20 — SATURATED, and the
    //     ladder now refuses rung 2 there. The 10-rep run over the same 20
    //     stimuli, same fingerprint, same scorer, scored 8/10 vs 8/10. Pooled
    //     (ledger-gate.POOLED-10rep+20rep.jsonl, pairs keyed by run so the
    //     pairing stays within-run) the axis has headroom and n=30/arm.
    // Superseded ledgers kept beside it: VOID-synthetic-prompt (hand-written
    // prompt, prose-matching scorer) and VOID-saturated-shape-axis.
    //
    // AXIS RE-AUDITED 2026-08-27, all four mismatches read by hand. The PARSER
    // is clean — `verdictWord` extracted the stated word correctly every time.
    // THE TRUTH IS NOT, on one stimulus. TASK_0009/after is `PASS` because its
    // own VERIFY script passes there, and BOTH arms answered FAIL with the same
    // checkable reason: the acceptance list requires phone validation to REJECT
    // `+1234567`, while the spec's own mandated regex `/^\+[1-9]\d{6,14}$/`
    // accepts it (`+` `1` then six digits, and the range starts at six), and the
    // shipped test omits the case. Verified by reading the regex, not by
    // trusting the model. So "the task's VERIFY passes" is not the same fact as
    // "the acceptance criteria are met", and on that stimulus the child was
    // right and the axis was wrong.
    // THE CELL IS UNCHANGED: both arms fail it identically, so dropping it
    // leaves off 28/29 vs medium 28/29 — still level, still rung 2. Recorded
    // because the next axis built on executed VERIFY should expect this gap.
    gate: 'off',
    // A/B 2026-08-26, Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf (llama.cpp
    // b10620-0f3b51e03), scripts/live-reasoning-group-ab.ts, n=20/arm over 20
    // recorded docs queries across 10 packages. off 20/20 usable vs medium
    // 15/20 (p=0.0471); neither arm failed to answer. off usable 95% CI
    // [0.84, 1.00]. Wall clock, PAIRED over the 15 stimuli usable in both arms:
    // off 5.2s vs medium 11.1s, p=0.0010.
    // RUNG 1 — the ONLY cell in this table decided by a quality difference, and
    // the clock agrees with it rather than carrying it. Ledger:
    // ledger-extraction.jsonl.
    //
    // THE PROMPT IS PRODUCTION'S. The harness used to hand-write it, because
    // the two production builders frame content as a named npm package's docs
    // or an anchored web page and the material it had — a recorded `## research`
    // section — is neither. The fix was the right MATERIAL, not a better frame:
    // `.pi-tasks/research-cache.json` records 190 distinct `pi-worker-docs`
    // (package, query) pairs the run really asked, over 31 packages installed in
    // the corpus copy, and all 190 replay through `docsRaw` + `buildPrompt` with
    // no model and no network. See scripts/reasoning-ab-extraction-truth.ts.
    //
    // THE AXIS IS THE CONJUNCTION: a non-empty answer AND a citation that is
    // really in the content the child was shown. Production gates on the first
    // half only and carries `excerptVerified` as metadata, so this is a HARDER
    // bar than production's own — legitimate for an A/B, and necessary because
    // the shape half is the ceiling that returned 10/10 in both arms for gate,
    // research and planning. SCREENED offline over all 190 recorded answers
    // before any GPU:
    //     production's own excerptVerified        189/190  — clears the bar
    //     every backticked SPAN in the content     51/190  — the CHECK loses
    //     code-shaped identifiers only            123/190  — the CHECK loses
    // Both grounding rules die the way phase's three did, for a nameable reason:
    // real type names the model correctly knows — `ResponseInit`,
    // `ArrayBufferView`, `DataTransfer` — are simply not in the retrieved
    // chunks, so a correct answer is marked wrong.
    //
    // WHAT MEDIUM ACTUALLY DOES WRONG, audited row by row rather than trusted.
    // All five failures are genuine and none is a normaliser gap: re-checked
    // with whitespace and case squashed out, ZERO of them appear in the content.
    // The failure mode is STITCHING — the arm concatenates non-contiguous
    // passages into one quote block that reads as verbatim and is not. One
    // matched 457 of its 522 squashed characters before diverging; another glued
    // three separate `ts fences and a trailing `export type` line. It is not
    // inventing the package, it is inventing the CONTIGUITY, which is exactly
    // what a citation asserts.
    //
    // A RESCORE OF THIS GROUP RE-RETRIEVES, and that is a trap the ledger now
    // guards. Two trials that verified in the container failed when rescored on
    // the host, both quoting a real bun declaration (`@deprecated Prefer
    // {@link Bun.sql}`) the host's newer bun does not ship — enough to move the
    // cell from rung 1 to rung 2 on an artefact of WHERE the rescorer ran.
    // Retrieval is deterministic within one environment and NOT across two, so
    // the row now carries `verifyHash` and rescore-reasoning-ledger.ts ABSTAINS
    // on a mismatch. This ledger predates the field, so the live judgements —
    // made against exactly the bytes each child was shown — are authoritative.
    //
    // MEASURED UNDER THE SERVER'S GLOBAL SAMPLER, which is the THINKING preset,
    // so the `off` arm decodes on sampling tuned for the `on` arm. That is the
    // regime this machine really runs pi-task in, so the result is
    // ecologically valid — it is NOT a clean comparison. Here it makes the
    // finding CONSERVATIVE: the arm that wins is the one running on the other
    // arm's sampler.
    extraction: 'off',
    // A/B 2026-08-25, Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf (llama.cpp
    // b10618-1efd800e9), scripts/live-implementation-thinking-ab.ts, n=20/arm
    // over 20 distinct mx5 specs, scored by each task's OWN recorded VERIFY
    // block against the tree the turn produced. off 12/20 pass vs medium 12/20
    // (p=1.0000); turn died 6/20 both arms. off pass 95% CI [0.39, 0.78].
    // RUNG 2, and it was read as rung 3 until 2026-08-26. The quality axes are
    // identical to the trial, so the clock decides — and the clock test was
    // UNPAIRED on a design that runs each spec once per arm. Pooled, the mean
    // wall clock of passing turns is off 237s vs medium 298s, p=0.6150. Paired
    // by spec over the 12 specs that pass in BOTH arms: off faster in 9,
    // geometric mean 0.55x, p=0.0166.
    // Quality is still the widest CI in the table — at 12/20 the true pass rate
    // is anywhere from 39% to 78%, so an ordinary quality difference would have
    // been invisible — but 12/20 is not a ceiling, so the clock is allowed to
    // carry the cell. The value is unchanged; only its standing improved, from
    // a stated prior to a measured win. Rescored from the original ledger on 2026-08-25 when the harness
    // moved to a forced two-way verdict; the trials are unchanged.
    implementation: 'off'
}

/**
 * A hand-edited or stale mode must not reach {@link resolveReasoning}'s switch as
 * an unknown string — the `default:` arm would silently absorb it and the user
 * would see "custom" in the file and the default table in behaviour.
 */
export function sanitizeReasoningMode(value: unknown): ReasoningMode {
    return REASONING_MODES.includes(value as ReasoningMode) ? (value as ReasoningMode) : 'default'
}

/**
 * Always returns a COMPLETE record, never a partial one.
 *
 * A hand-edited file missing a group, or one carrying a group from a future
 * version, must not reach `resolveReasoning` as a hole: `levels[group]` would be
 * `undefined`, and every call site would need its own fallback. Filling the gaps
 * here means the type is true at the only place that constructs the value.
 */
export function sanitizeReasoningLevels(value: unknown): Record<ReasoningGroup, GroupSetting> {
    const stored =
        typeof value === 'object' && value !== null && !Array.isArray(value) ?
            (value as Record<string, unknown>)
        :   {}
    const out = {} as Record<ReasoningGroup, GroupSetting>
    for (const group of REASONING_GROUPS) {
        const stored_ = stored[group]
        out[group] =
            REASONING_SETTINGS.includes(stored_ as GroupSetting) ?
                (stored_ as GroupSetting)
            :   DEFAULT_REASONING_TABLE[group]
    }
    return out
}

/**
 * What one group is actually set to, given a config. The ONLY place the four
 * modes are interpreted.
 *
 * `cfg` is required rather than defaulted to `getConfig()` so this module stays
 * import-free (see the header). Callers that want the live config use
 * `groupThinkingArgs` from reasoning-args.ts.
 */
export function resolveReasoning(group: ReasoningGroup, cfg: PiTaskConfig): GroupSetting {
    switch (cfg.reasoningMode) {
        case 'off':
            return 'off'
        case 'on':
            return REASONING_ON_LEVEL
        case 'custom':
            return cfg.reasoningLevels[group]
        default:
            return DEFAULT_REASONING_TABLE[group]
    }
}

/**
 * The argv fragment for a setting. `inherit` is the empty fragment — no flag at
 * all — which is what makes an all-`inherit` config byte-identical to the
 * version before this feature existed.
 */
export function thinkingArgs(setting: GroupSetting): string[] {
    return setting === 'inherit' ? [] : ['--thinking', setting]
}

/** One honest sentence per group, for the /task-config rows. */
export const REASONING_GROUP_HELP: Readonly<Record<ReasoningGroup, string>> = {
    research:
        'The four research workers that read the codebase before a spec is written, '
        + 'and the pi-worker subagent tool. Read-only exploration loops.',
    phase:
        'Refining your request, generating and answering the clarifying questions, '
        + 'writing the spec, and critiquing it.',
    planning:
        "/task-auto's planners: splitting a design document into tasks and extracting "
        + 'its requirements. The most reasoning-hungry step measured so far.',
    plan: "/task-plan's interactive question-and-answer children.",
    gate: 'The checks that run after code is written: verify, enforce, lint-fix, autofix.',
    extraction:
        'The small no-tools children that pull one answer out of a fetched page or '
        + 'a docs chunk.',
    implementation:
        'The main session turn that actually writes the code. Changing this briefly '
        + "changes pi's own thinking level, and puts it back afterwards."
}
