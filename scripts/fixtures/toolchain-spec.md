<!--
ENGINEERED FIXTURE — not a found document.

Purpose: exhibit the precondition for the coverage-loop zero-gain pathology,
which neither of the earlier generality fixtures reaches.

  - the first CLI fixture (8 ownable) was too small: round 0 came back COMPLETE
    16/16 and the loop never retried at all.
  - etl-spec.md (28 ownable) does retry, but round 0 lands at 25-27/28 and every
    retry picks up the 1-3 stragglers, so growth always pays and the pathology
    never appears in the baseline arm.

The pathology needs round 0 to reach the coverage CEILING — retries must have
nothing left to buy — while the holistic judge keeps returning INCOMPLETE so the
loop keeps reprompting. This document is written to produce exactly that:

  1. every obligation bullet LEADS with the name of the one subsystem that owns
     it, and there are few enough subsystems (12) that any sensible first-pass
     plan names all of them. `groundedCoverage` matches on distinctive token
     overlap between a requirement quote and a task title, so a plan of ~12-20
     titles covers essentially every ownable requirement on the first draw.
  2. the prose carries far more behaviour than a title list can ever name —
     error taxonomies, ordering rules, budgets, platform matrices — so the
     free-text judge has permanent grounds to call the plan INCOMPLETE.

That (1) and (2) are deliberate is the whole point: this is a guard test, and
the guard is only exercised when the precondition holds. It must not be cited as
evidence about how real specs are distributed.
-->

# `orb` — ahead-of-time compiler and toolchain for the Orb language

Orb is a small statically typed systems language. This document specifies the
whole toolchain: a compiler that produces native objects, a linker driver, a
package manager, and the developer tools around them. There is no server, no UI
and no network protocol anywhere in the product; everything here is a local
process operating on files.

## 1. Decisions (locked)

- Single self-hosted repository, one binary named `orb` with subcommands.
- Rust 2024 edition, no procedural macros in the compiler crates.
- The codegen crate targets Cranelift for native instruction selection; LLVM is explicitly out of scope.
- The lexer accepts UTF-8 source only, and the on-disk source map layout is stable across releases.

## 2. Dependencies (pinned)

- `cranelift-codegen` `0.122` — native instruction selection
- `object` `0.38` — ELF/Mach-O/COFF object emission
- `logos` `0.15` — token definitions for the lexer
- `codespan-reporting` `0.13` — rendered diagnostics
- `rayon` `1.11` — parallel module compilation
- `toml_edit` `0.24` — manifest parsing that preserves formatting

## 3. Crate layout

- `crates/lexer` — token stream, trivia, source maps
- `crates/parser` — concrete syntax tree, recovery
- `crates/resolver` — name binding, module graph, imports
- `crates/typechecker` — inference, trait selection, coercions
- `crates/bytecode` — the typed mid-level representation
- `crates/optimizer` — bytecode-to-bytecode transforms
- `crates/codegen` — Cranelift lowering and object emission
- `crates/linker` — object collection and platform link invocation
- `crates/manifest` — package manifests, dependency graph, lockfile
- `crates/driver` — the `orb` binary, subcommands, job scheduling
- `crates/diagnostics` — rendering, error codes, suppression
- `crates/formatter` — canonical source layout

## 4. Lexer

Source text is tokenised in one pass with no backtracking. Trivia (whitespace,
comments, doc comments) is retained on the token stream rather than discarded,
because the formatter and the diagnostics renderer both need byte-exact spans
back into the original file.

- The lexer emits every token with a byte span into an interned source map.
- The lexer preserves trivia — comments and whitespace — as attached leading and trailing runs.
- The lexer reports an unterminated string or block comment as a recoverable token, so the parser still receives a complete stream.

Numeric literals accept binary, octal, decimal and hexadecimal forms with `_`
separators; suffix parsing (`i32`, `u8`, `f64`) belongs to the lexer, not the
parser, so that a malformed suffix is one token error rather than a cascade.

## 5. Parser

The parser builds a lossless concrete syntax tree: every byte of the input file
is reachable from the root node. Error recovery is anchor-based — on an
unexpected token the parser skips to the next statement or item keyword and
emits a placeholder node, so a single syntax error yields one diagnostic instead
of a cascade of twenty.

- The parser produces a lossless concrete syntax tree covering every byte of input.
- The parser recovers at statement and item anchors and emits a placeholder node per recovery.
- The parser records operator precedence in one table shared with the formatter.

## 6. Resolver

- The resolver builds the module graph from the manifest and the `mod` declarations, and detects import cycles.
- The resolver binds every identifier to a definition id before typechecking begins.
- The resolver reports a shadowed binding as a warning with both spans attached.

Module search is manifest-driven: a path is resolved against the current
package's source root first, then against the direct dependencies named in the
manifest, and nowhere else. Transitive dependencies are deliberately invisible,
which is what makes the dependency graph a proper DAG.

## 7. Typechecker

Inference is Hindley-Milner with row-polymorphic records, run per strongly
connected component of the call graph. Trait selection is a separate pass over
the same component so that method resolution can see all inferred types.

- The typechecker infers types per strongly connected component of the call graph.
- The typechecker resolves trait methods in a pass distinct from inference.
- The typechecker attaches an inferred type to every expression node for later passes.

Coercions are limited and explicit: integer widening, `&mut T` to `&T`, and
unsizing to a slice. Anything else is a hard error, and the error carries the
coercion the user probably meant.

## 8. Bytecode

- The bytecode crate defines a typed mid-level representation in static single assignment form.
- The bytecode representation carries the source span of the construct each instruction came from.
- The bytecode module is serialisable, so a compiled module can be cached between builds.

## 9. Optimizer

Passes run to a fixpoint with an iteration cap, and each pass is individually
switchable from the command line so a miscompilation can be bisected.

- The optimizer runs constant folding, dead code elimination and inlining to a fixpoint under an iteration cap.
- The optimizer preserves the source span of every instruction it rewrites.
- The optimizer exposes each pass as an individually switchable flag for bisection.

## 10. Codegen

- The codegen crate lowers bytecode to Cranelift IR one function at a time.
- The codegen crate emits ELF, Mach-O and COFF objects from the same lowering.
- The codegen crate records a line table mapping machine offsets back to source spans.

Debug information is emitted at all optimisation levels; stripping is the
linker's job, not codegen's.

## 11. Linker

- The linker collects emitted objects and invokes the platform system linker with a generated argument file.
- The linker resolves the archive search order from the manifest dependency order.
- The linker reports an unresolved symbol with the bytecode function that referenced it.

## 12. Manifest and packages

- The manifest crate parses `Orb.toml` while preserving comments and key order on rewrite.
- The manifest crate resolves the dependency graph to a lockfile with one version per package.
- The manifest crate verifies a package checksum against the lockfile before the package enters a build.

Version selection is minimal-version: the oldest version satisfying every
constraint wins, which makes builds reproducible without a resolver heuristic.

## 13. Driver

- The driver exposes `build`, `check`, `run`, `test`, `fmt` and `clean` subcommands.
- The driver schedules module compilation in parallel across a rayon pool sized to the core count.
- The driver caches compiled modules keyed by content hash and compiler version.

`check` stops after typechecking; `build` runs the whole pipeline. Both share
one job graph so a `check` result is reusable by a later `build`.

## 14. Diagnostics

- The diagnostics crate renders every error with a stable numeric code, a primary span and optional secondary spans.
- The diagnostics crate supports machine-readable JSON output alongside the human renderer.
- The diagnostics crate honours per-file suppression comments for warning codes.

The error code registry is append-only: a code, once published, keeps its
meaning forever, and a retired check leaves its code reserved.

## 15. Formatter

- The formatter reprints the concrete syntax tree to a canonical layout that is idempotent on a second run.
- The formatter preserves blank-line grouping between items up to a maximum of one blank line.
- The formatter shares the precedence table with the parser so reprinted expressions keep their meaning.

## 16. Testing

- **Test-first cadence (required):** a test lands *as fast as possible* — in the
  same change — as each new pass or subcommand.
- Snapshot tests for the parser, the formatter and the diagnostics renderer.
- Golden object tests: compile a fixture and assert the emitted symbol table.
- Property test: the formatter is idempotent, and reformatting preserves the
  concrete syntax tree modulo trivia.
- End-to-end tests build and run a sample package on each supported platform.

## 17. Operational constraints

- The toolchain must never write outside the target directory or the package cache.
- Builds must be reproducible: identical inputs produce byte-identical objects.
- The compiler must not read environment variables to change semantics; only paths.
- Every subcommand must exit non-zero on any emitted error diagnostic.
