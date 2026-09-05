# Live docs run — audit

## ts (npm) — **PASS**

| | |
|---|---|
| docs calls (trail) | 16 |
| docs answers (jsonl) | 17 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 4 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 13/13 |
| web lookup after a docs call | 0 |
| pins intact | 2/2 |
| build/test | green |

## rs (cargo) — **HARD FAIL**

- `cargo test` failed

| | |
|---|---|
| docs calls (trail) | 11 |
| docs answers (jsonl) | 17 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 5 |
| retrieval recall | 3/3 |
| answers with 0 invented symbols | 12/12 |
| web lookup after a docs call | 0 |
| pins intact | 3/3 |
| build/test | RED |

```
available for `Router` here
    |
    = help: items from traits can only be used if the trait is in scope
help: there is a method `nest` with a similar name, but with different arguments
   --> /home/agent/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/axum-0.8.9/src/routing/mod.rs:209:5
    |
209 |     pub fn nest(self, path: &str, router: Router<S>) -> Self {
    |     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
help: trait `ServiceExt` which provides `oneshot` is implemented but not in scope; perhaps you want to import it
    |
  1 + use tower::util::ServiceExt;
    |

Some errors have detailed explanations: E0433, E0599.
For more information about an error, try `rustc --explain E0433`.
error: could not compile `docs-live-rs` (test "config") due to 3 previous errors
```

## hs (hackage) — **HARD FAIL**

- `cabal build all && cabal test` failed

| | |
|---|---|
| docs calls (trail) | 21 |
| docs answers (jsonl) | 22 |
| refusals, research phases | 0 |
| abstentions ("unclear") | 12 |
| retrieval recall | 4/4 |
| answers with 0 invented symbols | 10/10 |
| web lookup after a docs call | 0 |
| pins intact | 2/2 |
| build/test | RED |

```
dule `Web.Scotty' does not export `Status'.
   |
21 | status400 :: S.Status
   |              ^^^^^^^^

src/Server.hs:22:13: error: [GHC-76037]
    Not in scope: data constructor `S.Status'
    NB: the module `Web.Scotty' does not export `Status'.
    Suggested fix:
      Perhaps use variable `S.status' (imported from Web.Scotty)
   |
22 | status400 = S.Status 400 "Bad Request"
   |             ^^^^^^^^

src/Server.hs:40:25: error: [GHC-76037]
    Not in scope: type constructor or class `Trans.Application'
    NB: the module `Web.Scotty.Trans' does not export `Application'.
   |
40 | scottyApp :: ScottyM -> Trans.Application
   |                         ^^^^^^^^^^^^^^^^^

Error: [Cabal-7125]
Failed to build docs-live-hs-0.1.0.0.
Failed to build exe:docs-live-hs from docs-live-hs-0.1.0.0.
```

