# pi-task benchmark — state as of 2026-08-09 22:45

Measuring what pi-task is worth, against the Prompt-Vault corpus, on one fixed local model.
This file is the resume point. Live results land in `~/hub/bench-test/SCOREBOARD.md`.

---

## START HERE — resuming after a shutdown

The machine was powered off, so the matrix is stopped. Nothing auto-starts by design.
Whatever run was in flight is discarded; `run-arm.sh` wipes its directory and redoes it.

**1. Bring the model up and wait for a real 200.**

    docker start llama-turboquant
    curl -sf http://127.0.0.1:8080/v1/models        # must return 200 before anything else

A 27B model takes ~15s to load. Starting a run against a dead endpoint burns a whole prompt.

**2. Restart the driver.** It reads `~/hub/bench-test/.done` and skips everything finished.

    systemctl --user reset-failed bench-driver.service 2>/dev/null
    cd ~/hub/bench-test/harness
    systemd-run --user --unit=bench-driver --working-directory="$PWD" \
      --setenv=BRAVE_API_KEY_BENCH=BSA3QEIZE-v0Om36PtWEiXv50WLpSKW \
      /bin/bash ./driver.sh

Lingering is already enabled (`loginctl enable-linger edgars`), so this survives the terminal
closing and the session dying. It does NOT survive a power off, and is deliberately not enabled
at boot.

**3. Watch it.**

    journalctl --user -u bench-driver -f
    tail -f ~/hub/bench-test/results.tsv
    docker ps --filter name=bench-

**4. As each prompt finishes, grade it.** Blind the three arms, then dispatch three subagents:

    ~/hub/bench-test/harness/blind.sh <slug>      # prints the private S1/S2/S3 → arm map

Give each subagent one build path, the matching frozen rubric from `harness/rubrics/<slug>.md`,
and the grading conventions in the "Grading method" section below. Hold the map until all three
report, then unblind and append to `~/hub/bench-test/SCOREBOARD.md`.

**5. After the matrix, run the four redos by hand** (see the redo queue below).

---

## The three arms

One prompt per run. `Implement prompt.md`. The run ends when the agent stops.

| arm | invocation | meaning |
|---|---|---|
| **A** | `pi -ne -p "Implement prompt.md"` | no pi-task at all |
| **B** | `pi -p "Implement prompt.md"` | pi-task installed, its tools available |
| **C** | `pi -p "/task-auto Implement prompt.md"` | pi-task orchestrating |

---

## The rig

- **Image** `bench-golden:v1`, committed from the `bench-test` container. This matters: the base
  `agent-sandbox` image does NOT carry the pi-task config, the Brave key, or pi 0.84.1. A fresh
  container from the base image would silently run a different rig.
- **One throwaway container per run**, `--network host`, workdir bind-mounted from
  `~/hub/bench-test/runs/<slug>/<arm>/rep1`.
- **Model** local Qwen3.6-27B NVFP4 via llama.cpp on `127.0.0.1:8080`, container
  `llama-turboquant`, `--parallel 2`, 240k ctx.
- **Runs are strictly sequential.** llama-server has 2 slots; concurrent arms would corrupt every
  wall-clock number in the table.
- **Config immutability** the golden `~/.config/pi-task/config.json` is sha256'd before and after
  every run. Hash `9b3180f9…`. Unchanged on all 29 runs so far.

### Scripts — `~/hub/bench-test/harness/`

    driver.sh          walks the whole matrix, skips whatever .done lists
    run-arm.sh         one run: container, watchdogs, metadata, guards
    blind.sh           shuffles the three arms into S1/S2/S3 for grading
    rubrics/           12 frozen rubrics, one per prompt
    pv/                the Prompt-Vault checkout the runs are fed from

These were originally in a session scratchpad that would have vanished. They are durable now.

### State files — `~/hub/bench-test/`

    .done              one line per completed run, e.g. `kanban/C/1`. The driver's resume index.
    .redo              runs invalidated by an instrument fault. NOT automatic.
    results.tsv        one row per run: outcome, wall, tool calls, commits, config/model guards
    SCOREBOARD.md      the graded findings, appended per prompt
    runs/<slug>/<arm>/rep1/   the artifact tree, plus rep1.jsonl / .meta beside it

### Driver lifecycle

Runs as a transient systemd user unit with lingering on, so it survives the terminal closing and
the session crashing. The desktop crashed twice during the first day and killed it both times
before this was set up.

It is deliberately NOT enabled at boot. Restart it by hand with the command in START HERE.

### Watchdogs

- **Stale** no write ANYWHERE in the run dir for 420s → kill, record STALE.
  Watching stdout alone was wrong: pi-task child workers run for many minutes while the parent
  session emits no JSON events. That bug killed a healthy `palette/C` at 1892s.
- **Hard cap** 43200s (12h) on every arm. Effectively no cutting, per the decision that we need
  full runs. Started at 2400s for A/B and 7200s for C — an asymmetry that unfairly cut two feedagg
  runs, which are queued for redo.
- **Model restart** llama's `StartedAt` is stamped either side of each run. If it moved, the run is
  marked `+MODELRESTART` and auto-queued for redo. pi retries transparently, so a model outage can
  otherwise leave no trace at all.

---

## Grading method

1. **Rubric frozen before any artifact exists.** One per prompt, in `~/hub/bench-test/harness/rubrics/`. Every
   item quotes prompt.md verbatim and is classed static / dynamic / judge.
2. **Blind.** The three arms are shuffled into S1/S2/S3. Graders never learn which is which.
3. **Three independent graders per prompt**, one per build. Each drives the real thing — Playwright
   for web, venv + import for Python, `cargo check` + stubbed Tauri IPC for Rust. Never grades from
   source alone. Never trusts a test suite the build ships with.
4. **Boot gate.** G1 gates G2. A build that will not start scores 0 compliance regardless of item
   count. Added after ocr, where a flat count ranked two apps that never launch ABOVE the one that
   does.
5. **UNMEASURED is a real verdict.** Never guess a PASS.

Rubric sizes: 398 items total across 12 prompts, 33 judge-only (8%). Single-HTML prompts are
near-fully objective (bubblesort 1/13 judge-only); the prose ones are not (speedometer 7/24).

**Graders must not launch GUI applications.** One did, and opened a window on the operator's live
desktop.

---

## State

**29 of 36 runs recorded. 9 of 12 prompts graded.**

| | wall clock total |
|---|---|
| A no pi-task | 76 min |
| B tools | 64 min |
| C /task-auto | **7h 16m** |

Outcomes: 25 CLEAN, 1 CRASH, 1 STALE, 2 HARDCAP. Config hash unchanged on all 29.

### Redo queue — `~/hub/bench-test/.redo`

    palette/C/1     my stale detector killed a live run
    mdeditor/A/1    overlapped the 18:36 llama restart
    feedagg/A/1     cut at the old 2400s cap while still working
    feedagg/B/1     same

These are NOT re-run automatically — the driver only walks `.done`. Run them by hand after the
matrix finishes, one at a time, never concurrently:

    cd ~/hub/bench-test/harness
    export BRAVE_API_KEY_BENCH=BSA3QEIZE-v0Om36PtWEiXv50WLpSKW
    ./run-arm.sh C pv/Easy/Color_Palette_Generator.md palette 1
    ./run-arm.sh A pv/Hard/Markdown_Editor_Desktop.md mdeditor 1
    ./run-arm.sh A pv/Advanced/Feed_Aggregator.md feedagg 1
    ./run-arm.sh B pv/Advanced/Feed_Aggregator.md feedagg 1

Each appends a fresh row to `results.tsv`; the old row stays, so read the LAST row per run.

### Remaining

- **feedagg/C** — was ~1h in when the machine went down. Restarts from scratch.
- **hanta ×3** — Rust + Bevy 0.18
- **filelist ×3** — biggest prompt in the set, 97 rubric items
- then the four redos
- then grade feedagg, hanta, filelist, palette

Roughly 10 hours of runs left, plus about an hour of grading.

### Prompts still needing grades

feedagg, hanta, filelist, palette. Rubrics are already frozen for all of them.

---

## Findings so far

### Score by prompt

| prompt | tier | A | B | C | winner |
|---|---|---|---|---|---|
| bubblesort | Easy | 13/13 | 13/13 | 11/13 | A, B |
| todo | Easy | 18/19 | 18/19 | 18/19 | tie |
| sortviz | Medium | 12/20 | **19/20** | 18/20 | B |
| pixelart | Medium | 25/26 | **25/26** | 23/26 | B |
| kanban | Hard | 33/37 | 35/37 | **36/37** | **C** |
| ocr | Hard | 0 (dead) | 0 (dead) | **29/36** | **C** |
| mdeditor | Hard | 12/26 | **17/26** | 5/26 (crashed) | B |
| speedometer | Advanced | 4/24 | 12/24 | **18/24** | **C** |
| palette | Easy | — | — | redo | — |

**The trend is the headline.** `/task-auto` loses on Easy and Medium, wins on Hard and Advanced.
On speedometer it was the only arm whose Rust crate compiled at all. On ocr it was the only build
that opened a window.

### The actionable pi-task defect

`mdeditor/C` died at 841s with:

    FATAL ERROR: Ineffective mark-compacts near heap limit
    Allocation failed - JavaScript heap out of memory

pi's node process hit the ~4GB V8 ceiling and segfaulted after 670 tool calls, with ONE planned
task finished. The workspace held 8,409 files / 4.3 GB — a Tauri project drags in node_modules plus
a cargo registry. Arms A and B ran the same prompt on the same machine and both finished CLEAN.
It is the orchestration path, not the prompt or the host. The crash cost C the whole prompt: it
scored 5/26 on a 50-line scaffold.

### pi-task's own verification does not verify

On bubblesort, C's VERIFY blocks are regex greps over the HTML source:

    const uniqueColors = new Set(colorMatches …)
    if (uniqueColors.size < 2) FAIL

Three hex codes exist in the CSS, so it passed — while the page rendered exactly one colour,
because an inline `style.backgroundColor` overrode all three classes. The check tested the file,
not the page. The final gate then recorded the truth and shipped anyway:

> UNOBSERVED — NOT a pass: no integration, lockfile or boot command was discoverable here, so the
> gate ran nothing at all.

A `file://` single-page build gives the final gate nothing to boot. That hits 7 of the 12 prompts.

### Cost

C runs 20–105 minutes against 30–140 seconds for the other arms. On pixelart it was 60x arm B's
wall clock to land two points below it. C also installs Playwright and writes its own test suites,
which is much of where the time goes — and on pixelart that habit leaked into the deliverable as a
shadow DOM grid of 4096 divs kept in sync "for test selectors".

### The base model has stereotyped bugs

Three prompts where two arms independently wrote the SAME defect:
- todo — Clear All removes the storage key, loader re-seeds defaults on reload (A and B)
- pixelart — `restoreFromStorage()` then an unconditional grid rebuild that discards it (A and B)
- ocr — `client.list()` parsed as `m["name"]`, but ollama-python ≥0.4 exposes `model` (all three)

That is the model, not the arm. A benchmark that does not run all three arms would misattribute it.

---

## Open questions for tomorrow

1. **n=1.** Every number here is a single run. C's mdeditor crash and A's sortviz collapse could
   both be bad rolls. Nothing is established until this is repeated.
2. **Arm B may be a null arm on easy prompts.** On bubblesort it made zero pi-worker calls and
   scored identically to A in the same 45s. It only becomes distinct when the prompt is hard.
3. **Easy tier does not discriminate.** Two arms hit the ceiling on bubblesort. Three of twelve
   prompts may be dead weight.
4. **Cross-grader agreement is untested.** Every prompt got three different graders writing three
   different probes. Grading the same build twice would measure that.
5. **The JSON event stream carries no timestamps** (1 of 2124 events had one), so inter-event gaps
   cannot be reconstructed after the fact. The runner should stamp arrival time on write.
