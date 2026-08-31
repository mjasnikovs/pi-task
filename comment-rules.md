# Comment rules

How every comment in this repo gets judged. One file at a time. One claim at a
time. Nothing is decided by guessing.

## The reader we write for

Someone who just installed this extension on their own machine. They have the
source, the tests, `pi`, and a local model. They have none of the author's past
runs, corpora, ledgers, or notes.

A comment they cannot check is not documentation. It goes.

## Verification environment

Checked on 2026-08-29, not assumed:

| what | value |
| --- | --- |
| model | `Qwen3.8-27B-NVFP4-MTP-VERY-HIGH.gguf` |
| llama.cpp build | `b10665-ca3d5a3e1` |
| endpoint | `http://127.0.0.1:8080` |
| context | 120064 |
| pi on PATH | `0.84.4` |
| pi packages in `node_modules` | `0.84.2` |

## The loop

ONE FILE AT A TIME. ONE COMMENT AT A TIME. ONE CLAIM AT A TIME.

Take the first row in `comment-leg.md` whose `verified` column is `false`.
Open that file. Read every comment in it, top to bottom. For each claim:

1. **Name the claim.** Write it as one sentence. A comment usually makes
   several; each one is judged on its own.
2. **Route it** to a verify channel below.
3. **Run the check.** Not read about it. Not reason about it. RUN it — the
   command, the request, the grep.
4. **Proven** — rewrite the comment to say only what the check showed.
5. **Not proven** — delete the claim.
6. The file is done when every claim in it is proven or gone.
7. Run `bun run lint:check` and `bun run test`. Commit.
8. THEN flip that one row to `verified = true`.

Then the next file. Do not batch. Do not move to file two before file one is
committed.

## What verifying is NOT

These are the shortcuts that get taken when the file count looks large. None
of them is verification, and none of them may flip a row:

- Deleting a banned token (`mx5`, `run 14`) and leaving the sentence.
- Running a script across many files at once.
- Passing `scripts/comment-residue.py`. That checker finds banned WORDS. It
  cannot tell whether a claim is true.
- Reading a diff and thinking it looks right.
- Reasoning from the code without running anything, when the claim is about
  `pi`, the model, git, or a package.

A row is `true` only when every claim in that file was named and checked.

## Rate

Roughly 6,000 claims over 25,773 comment lines. It does not fit in one session,
and that is fine — SCOPE IS NOT THE PROBLEM. The whole repo gets done. It takes
as many sessions as it takes.

- Report the real rate after the first ten files: claims checked, files done.
- Being slow is correct. Going faster by changing method is not.
- Running out of session is expected. Leave the ledger honest and the next
  session picks up the first `false` row.
- Never describe a file as verified in a commit message unless it went through
  the loop above.

## Heartbeat

A session doing this work runs a 15-minute heartbeat that re-issues the
instruction. Its only jobs are to keep going and to keep the method honest —
it is not permission to speed up. If the heartbeat fires and the answer is
"nothing left to do", check the ledger before believing it.

## Verify channels

| claim is about | how it is proven |
| --- | --- |
| this repo's code | read the code it describes; run the test that covers it |
| `pi` behaviour | run `pi`, or read `node_modules/@earendil-works/` source |
| the model | send a real request to `127.0.0.1:8080` and read the real reply |
| a package API | read the installed package in `node_modules` |
| the filesystem or git | run the command |
| anything else | it is not proven |

## Always deleted

No exceptions. These cannot be checked by the reader we write for.

- **Past runs.** `mx5`, `nexttask N`, `gofer-pixel`, `run 14`, `TASK_0017`,
  `~/hub/…`, any path under `/home/edgars`.
- **Statistics.** p-values, `n=NN/arm`, `12/20`, percentages, means, medians,
  standard deviations, confidence intervals, Fisher tests, A/B verdicts, RUNG.
- **Clocks and rates.** `16m23s`, `610-927s`, `2.9h`, `~596 KB/s`,
  `median 17k-char trace`, tokens per second, "finishes in N", any number that
  moves when the model or the machine changes. Assume the model runs at
  1 token/sec.
- **Hardware and model identity.** `.gguf` filenames, `llama.cpp bNNNNN`, GPU
  names, quantisation.
- **Version and commit refs.** `v0.38.15`, commit SHAs, CI run IDs.
- **History.** "used to be", "no longer", "previously", "we changed",
  "OVERRIDDEN BY USER DECISION 2026-08-27", dated decision entries.
- **Restatement.** `// kind === 'ok'` above `if (kind === 'ok')`.
- **Windows-only claims.** This box is Linux. They cannot be run here, so they
  cannot be proven here. The tests that cover the behaviour stay and keep
  enforcing it.

## Kept, once proven

- An invariant the reader can check against the code beside it.
- An ordering or teardown requirement whose failure mode is silent.
- A third-party API quirk, proven against the installed package.
- Why a test is shaped the way it is.
- What a function guarantees its callers.

Rewrite it to state the mechanism and nothing else. No provenance, no numbers,
no story.

### Shape

```
BEFORE
 * WHY (mx5 run 14): three implementation turns died mid-turn — the session
 * jsonl's last event is an ordinary assistant message, then nothing.
 * Cost in run 14: ~2.9h of dead air awaiting manual restarts.
 * WHAT THIS MEASURES: time since the LAST stream event of ANY kind.
 * NOT wall-clock, and NOT "time to first token". One token every 30s is a
 * working local model and must never be killed.

AFTER
 * Fires when a stream emits NO event of any kind for the whole window.
 * A hung stream throws nothing, so no error path catches it.
 * Not wall-clock and not time-to-first-token: a slow but live model must
 * never be killed.
```

## Code is not touched

Comments only. No constant, timeout, threshold or default changes value.

One exception was agreed: `test/config/reasoning.test.ts` had a `describe` block,
`every shipped cell is measured or inherit`, whose three tests **required** a
comment matching `A/B`, `n=\d+/arm`, `\.gguf` and `RUNG [123]` beside every
reasoning cell. That block enforced the thing these rules delete. It is already
gone — removed in `9979c07`, before this pass started — and every behavioural
test in that file stayed. Nothing is owed here.

## Never edited mechanically

These hold comments that are not TypeScript comments, or are data.

- **Template-literal bodies.** `src/remote/ui-script.ts`, `ui-styles.ts`,
  `ui-render.ts`, `ui-highlight.ts`, `sw.ts`. Almost the whole file is one
  string holding the browser client. Its comments ship to the browser.
- **Prompt text.** `src/task/prompts.ts`, `auto-prompts.ts`,
  `plan-prompts.ts`. They contain `###` markers and fenced blocks the model is
  told to look for. `src/workers/docs-chunk.ts` and `docs-core.ts` build
  `// ${path}` headers inside template literals.
- **`test/workers/__fixtures__/`.** Its JSDoc and `/// <reference>` lines are
  the data under test.
- **Four `// eslint-disable-next-line` comments** in `orchestrator.ts`,
  `auto-orchestrator.ts`, `bridge.ts`, `register.ts`. Removing the one in
  `register.ts` re-enables a `no-control-regex` failure.
- **The shebang** on `scripts/comment-ledger.mjs`.

## After each file

```
bun run lint:check
bun run test
```

`bun run test`, not `bun test`. The `--isolate` flag is load-bearing.

Green, then commit, then flip the row.

## Done

Every row in `comment-leg.md` reads `verified = true`.

`git grep -niE 'mx5|nexttask|gofer-pixel|/home/edgars'` is NOT clean, and cannot
be while this pass is comments-only. Every remaining hit is a STRING, not a
comment:

- test titles and `describe` names (`artifact-closure.test.ts`,
  `auto-orchestrator.test.ts`, and others)
- prompt and UI text shipped to the model (`task/verify-work.ts`,
  `workers/worker-profiles.ts`'s `why` strings, `task/foreign-path.ts`)
- test fixture data (`test/task/__fixtures__/mx5-read-traces.json`)
- the banned-word patterns in `scripts/comment-residue.py` themselves
- one line of README prose, and one `.gitignore` glob

Those need their own decision, because changing them changes what ships or what
a test is named. See the section below.

## State

DONE. 432 of 432 rows verified, one file at a time, each committed on its own.

What the pass found, beyond deleting unverifiable text:

- Comments that were FALSE, not merely unprovable — a "does not spawn pi" that
  does spawn, a "three of five error returns" where there are seven, a
  `planning: 'medium'` said to be the only cell asking for thinking where five
  do, a "seven groups" where there are eleven, a stale `src/` path that does not
  exist, a `gate-child.ts:178-186` citation pointing at nothing, and a
  "reachable by no test" that four tests now reach.
- Two rows already marked `verified = true` were reopened when a claim in them
  turned out to be unchecked, and one of those reopenings was itself wrong: pi's
  print/json mode DOES exit 143 on SIGTERM, so "every kill path sets a non-zero
  exit" is true for the children this code classifies. Running `sleep` proved
  the wrong thing; running real `pi` proved the right one.
- One structurally broken block: two JSDoc comments stacked above one test in
  `worker-profiles.test.ts`, the first documenting a different test entirely.

### What this pass did NOT touch

**Prompt and UI strings.** The comments-only rule leaves string literals alone,
and three still name things a new developer does not have:

- `src/task/verify-work.ts` — four lines of shipped prompt text say
  "mx5 run 13" and "mx5 runs 7 and 13" to the model.
- `src/workers/worker-profiles.ts` — the `why` strings name mx5 runs,
  nexttask items and `magicknumbers.md`.
- `src/config/reasoning.ts` — `REASONING_GROUP_HELP`, shown in
  `/task-config`, says "Measured: the two arms tie" and "the last full run".
- `src/task/foreign-path.ts` — `foreignPathDefectText`, the critique/enforce
  defect block, says "mx5 run 13" and "63 tests collected, 0 run" to the model.

That last one is INVISIBLE to the usual checks. The file contains a real NUL
byte (`` `${file}\0${abs}` ``, a key separator in `findForeignPaths`), so tools
treat it as binary: plain `grep -n mx5` on it exits 1 with no output, and
`git grep` prints only `Binary file … matches` with no line. Use `grep -a`, or
read it in Python, before believing a clean scan of this repo.

Changing these changes what ships, so they need their own decision.
