# Live docs run — audit

## ts (npm) — **HARD FAIL**

- stale API in src/config.ts: zod 4 uses z.email() / z.url() / z.uuid()

| | |
|---|---|
| docs calls (trail) | 18 |
| docs answers (jsonl) | 18 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 3 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 13/15 |
| web lookup after a docs call | 0 |
| pins intact | 2/2 |
| build/test | green |

Invented symbols:

- node:fs/promises: promises
- zod: stringify

## rs (cargo) — **PASS**

| | |
|---|---|
| docs calls (trail) | 9 |
| docs answers (jsonl) | 9 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 2 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 5/7 |
| web lookup after a docs call | 0 |
| pins intact | 3/3 |
| build/test | green |

Invented symbols:

- axum: error_value
- tower: router

## hs (hackage) — **PASS**

| | |
|---|---|
| docs calls (trail) | 13 |
| docs answers (jsonl) | 13 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 6 |
| retrieval recall | 3/4 |
| answers with 0 invented symbols | 7/7 |
| web lookup after a docs call | 0 |
| pins intact | 2/2 |
| build/test | green |

Recall misses: scotty:ActionM

