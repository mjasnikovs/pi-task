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
| model | `Qwen3.6-27B-NVFP4-MTP.gguf` |
| llama.cpp build | `b10665-ca3d5a3e1` |
| endpoint | `http://127.0.0.1:8080` |
| context | 120064 |
| pi on PATH | `0.84.4` |
| pi packages in `node_modules` | `0.84.2` |

## The loop

For each file, for each comment, for each claim inside it:

1. **Name the claim.** One sentence. A comment usually makes several.
2. **Route it** to a verify channel below.
3. **Run the check.** Not read about it. Run it.
4. **Proven** — rewrite the comment to say only what the check showed.
5. **Not proven** — delete the claim.
6. File is done when every claim in it is proven or gone.
7. Then, and only then, flip its row to `verified = true` in `comment-leg.md`.

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

One exception, already agreed: `test/config/reasoning.test.ts` has a `describe`
block, `every shipped cell is measured or inherit`, whose three tests **require**
a comment matching `A/B`, `n=\d+/arm`, `\.gguf` and `RUNG [123]` beside every
reasoning cell. That block enforces the thing these rules delete, so it goes.
Every behavioural test in that file stays.

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

`git grep -niE 'mx5|nexttask|gofer-pixel|/home/edgars'` returns nothing outside
this file and `comment-leg.md`.

Every row in `comment-leg.md` reads `verified = true`.
