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
 * What is already on the record, and why it is not enough to fill a cell in:
 * magicknumbers.md measured the /task-auto decompose child (group `planning`) on
 * Qwen3.8-27B NVFP4 with one knob, `enable_thinking` — off answered 1/10, on
 * answered 8/8. But the same page records the controls at reasoning off:
 * Qwen3.6-27B 10/10 and Gemma4-12B 10/10. A cell that flips by model cannot be a
 * constant, so `planning` stays `inherit` until Stage 2 of the A/B says whether
 * the Qwen3.8 result generalises.
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
    phase: 'inherit',
    // MEASURED 2026-08-26, n=10/arm, and NOT WRITTEN: off 10/10 vs medium 10/10
    // on `parseDecomposeList >= 2 titles`, a SHAPE check, saturated in both
    // arms. Its clock (p=0.1974) is the unpaired test on purpose — planning
    // replays one fixture ten times, so there are no distinct stimuli to pair
    // by and `pairByStimulus` refuses rather than invent a pairing.
    // The old target for this cell — off ~1/10 vs on ~8/8 from magicknumbers.md
    // — is STALE. It predates `fea7bbb`, which shipped three progress-based
    // planning guards; the same page records 8/9 with reasoning off after them,
    // which is what 10/10 reproduces. Reviving it as a positive control means
    // measuring against the PRE-`fea7bbb` guards (parent `42359f8`).
    planning: 'inherit',
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
    gate: 'off',
    // NEVER MEASURED. The PROMPT blocker is closed as of 2026-08-26; the AXIS
    // one is not.
    // The harness used to hand-write this group's prompt, because the two
    // production builders frame their content as an npm package's docs or an
    // anchored web page and the material it had — a recorded `## research`
    // section — is neither. The fix was the right MATERIAL, not a better frame:
    // `.pi-tasks/research-cache.json` records 190 real `pi-worker-docs` queries
    // over 31 packages, all installed in the corpus copy, and all 190 replay
    // through production's own `docsRaw` + `buildPrompt` with no model and no
    // network (median prompt 17.3 KB). See scripts/reasoning-ab-extraction-truth.ts.
    // WHAT STILL BLOCKS IT: the scorer. `GROUP_SCORERS.extraction` is "ok plus a
    // non-empty answer" — production's own gate, and a SHAPE check of exactly
    // the class that returned 10/10 in both arms for gate, research and
    // planning. `excerptVerified` is the nearest candidate with headroom and is
    // already carried down this path; screen it before writing a cell.
    extraction: 'inherit',
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
