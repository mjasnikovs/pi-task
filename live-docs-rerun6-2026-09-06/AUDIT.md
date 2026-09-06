# Live docs run — audit

## ts (npm) — **HARD FAIL**

- stale API in config.schema.ts: zod 4 uses z.email() / z.url() / z.uuid()
- stale API in config.ts: zod 4 uses z.email() / z.url() / z.uuid()

| | |
|---|---|
| docs calls (trail) | 9 |
| docs answers (jsonl) | 10 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 1 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 8/9 |
| web lookup after a docs call | 0 |
| pins intact | 2/2 |
| build/test | green |

Invented symbols:

- zod: age

## rs (cargo) — **HARD FAIL**

- `cargo test` failed

| | |
|---|---|
| docs calls (trail) | 12 |
| docs answers (jsonl) | 12 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 2 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 7/10 |
| web lookup after a docs call | 0 |
| pins intact | 3/3 |
| build/test | RED |

Invented symbols:

- serde_json: msg
- axum: config
- axum: config

```
ry/src/index.crates.io-1949cf8c6b5b557f/tower-service-0.3.3/src/lib.rs:355:8
    |
355 |     fn call(&mut self, req: Request) -> Self::Future;
    |        ---- the method is available for `Router` here
    |
    = help: items from traits can only be used if the trait is in scope
help: trait `Service` which provides `call` is implemented but not in scope; perhaps you want to import it
    |
 15 + use tower_service::Service;
    |
help: there is a method `call_all` with a similar name
    |
 85 |     let mut future = router.call_all(request);
    |                                 ++++

For more information about this error, try `rustc --explain E0599`.
error: could not compile `docs-live-rs` (test "config") due to 2 previous errors
warning: build failed, waiting for other jobs to finish...
```

## hs (hackage) — **INCOMPLETE**

Stopped mid-run: 0/1 tasks completed, 0 docs calls. No verdict — the numbers below would be a prefix of a run that never happened.

