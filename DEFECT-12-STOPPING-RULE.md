# Defect 12 — the stopping rule for following a re-export

`hspec` indexes to 14 chunks. `it`, `describe` and `shouldBe` are in the corpus as bare
names in an export list; every signature is in `hspec-core`, a dependency the indexer
never opens. The child abstained three times and was right to.

Following a re-export means deciding how far to index into transitive deps. This file
fixes that boundary, and every number in it is measured, not chosen.

## The measurement

Twenty hackage packages, sources extracted, no indexer involved. For each package:
*unresolved exports* = names in a module's export list with no declaration anywhere in
the package's own sources.

| package | exported | unresolved | % |
|---|---|---|---|
| hspec | 57 | 50 | **87.7** |
| mtl | 119 | 94 | 79.0 |
| base-compat | 543 | 421 | 77.5 |
| microlens-platform | 3 | 2 | 66.7 |
| hspec-core | 573 | 159 | 27.7 |
| servant | 174 | 30 | 17.2 |
| warp | 207 | 29 | 14.0 |
| lens | 1381 | 181 | 13.1 |
| QuickCheck | 351 | 34 | 9.7 |
| tasty | 187 | 5 | 2.7 |
| conduit | 524 | 12 | 2.3 |
| wai | 46 | 1 | 2.2 |
| vector | 2026 | 37 | 1.8 |
| containers | 1696 | 25 | 1.5 |
| text | 700 | 10 | 1.4 |
| bytestring | 1167 | 11 | 0.9 |
| transformers | 322 | 3 | 0.9 |
| optparse-applicative | 331 | 2 | 0.6 |
| hspec-expectations | 25 | 0 | 0.0 |
| megaparsec | 214 | 0 | 0.0 |

Facades sit at the top. Ordinary packages sit under 3%.

## Why the obvious rule is wrong

The candidate carried into this session was: *follow a re-export only when the importing
module declares no signatures of its own.*

It fails on the exact case it was written for. `Test/Hspec.hs` declares one signature:

```haskell
example :: Expectation -> Expectation
example = id
```

`Test.Hspec` is 42 unresolved of 43 exported with 1 declaration. Under that rule the
indexer stops, and defect 12 stands. One trivial helper kills the rule. Rejected.

## Why no threshold either

A fraction-of-export-list threshold was the next candidate. Swept on the 299 modules
with 5+ exports:

```
>=50%  33 modules      >=80%  20 modules
>=60%  25 modules      >=90%  18 modules
>=70%  21 modules      >=95%  18 modules
```

The trigger count barely moves across the whole range, which means the threshold is not
carrying the decision — so picking a value would be picking a number that sounded right.
That is the defect this file exists to avoid.

There is no reason to require a fraction. An exported name with no signature is a hole in
the index whether the module has one hole or forty-two. The trigger is the hole.

## The rule

**Resolve, do not traverse.**

1. **Trigger, two shapes.** A name the package exports and declares nowhere in its own
   sources; or a `module X` re-export of a module the package does not own. No threshold,
   no ratio. Both shapes are needed — see below.
2. **Candidates.** A `build-depends` entry named `<package>-<suffix>`, present in the
   already-resolved dependency set the indexer reads versions from. GHC boot packages
   never match; the point of this tool is packages the model predates, and it knows `base`.
3. **Keep only the hole.** Take a candidate's surface and keep only the declarations
   matching an unresolved name, or belonging to a wholesale-re-exported module.
   `hspec-core` is not indexed wholesale. The chunks are stored under the asking package
   and their path names the package they really came from.
4. **Stop after one hop.** Do not recurse into the supplier's own unresolved exports.

### Why the second trigger shape exists — measured

The name-level trigger alone was prototyped first. It carried `it ::` and `describe ::`
into retrieval and left `shouldBe` behind, because `Test.Hspec` re-exports it as
`module Test.Hspec.Expectations` — the name is nowhere in hspec's export list, so there is
no hole for a name-level rule to see. Adding the module-level trigger carried all four.

### Why the candidate bound is a name prefix, and what it costs

Hackage splits a facade from its implementation by name: `hspec`/`hspec-core`,
`hspec`/`hspec-expectations`. Without that bound the rule has to open every
`build-depends` entry to discover whether it declares anything, and the measured cost of
that is the reason it is not done:

| package | build-depends | candidates under the rule |
|---|---|---|
| hspec | 5 | hspec-core, hspec-discover, hspec-expectations |
| aeson | 48 | **none** |
| scotty | 38 | **none** |

aeson has nine unresolved exports — CPP macros and internal punctuation helpers that no
dependency declares — so an unbounded rule would open 48 packages and resolve nothing.

The bound's cost is stated, not hidden: `scotty` re-exports sixteen names from `cookie`,
which shares no prefix, so that hole stays open.

**The principled successor, not built.** The prefix is standing in for a module-to-package
map. Cabal already holds one — `01-index.tar` in its package cache carries every
package's `.cabal`, `exposed-modules` included — so `Web.Cookie` could be resolved to
`cookie` by lookup rather than by naming convention, and the prefix rule dropped entirely.
What ruled it out here was scanning cost, not soundness. Whatever replaces the prefix must
stay deterministic: making the index depend on which packages happen to be unpacked on
this machine would put the same package at two different shapes on two machines, which is
the failure this document's own scoring discipline exists to prevent.

## Why depth 1, measured

Per package: unresolved names, how many a one-hop candidate actually declares, and how
many distinct packages must be fetched.

| package | unresolved | resolved in 1 hop | packages fetched |
|---|---|---|---|
| **hspec** | **47** | **47 (100%)** | **hspec-core** |
| mtl | 44 | 37 (84%) | transformers |
| lens | 154 | 25 | bytestring vector mtl transformers containers text |
| servant | 29 | 5 | bytestring text transformers mtl |
| base-compat | 328 | 4 | transformers |
| conduit | 12 | 3 | transformers |
| QuickCheck | 24 | 2 | containers |
| warp | 27 | 2 | bytestring |
| bytestring, transformers, tasty, optparse-applicative, microlens-platform | 1–9 | 0 | none |

Two things fall out.

**The pass is self-limiting.** It only fires where a declared dependency actually supplies
the missing name. `base-compat` looks catastrophic at 328 unresolved and resolves 4 — the
other 324 are `base`, excluded by rule 2. The runaway does not happen.

**Depth 2 buys nothing.** After one hop, `hspec` has **zero** unresolved names left. mtl's
residue is `base`, again excluded. There is no measured case in this sample where a second
hop has anything left to fetch, so depth 2 cannot be justified and is not taken. Depth is
1 because the measurement says the next hop is empty, not because 1 is a tidy number.

## Implemented — what it does, measured

End to end through the real `docsRaw`, on the seeded `hs` project, against cabal's own
store. Three questions the live runs asked, and which of the four signatures the retrieved
chunks carry:

| | published 0.40.5 | this tree |
|---|---|---|
| `type signature of it, describe and shouldBe` | NONE | `it ::` `describe ::` `shouldBe ::` |
| `signature of shouldBe and shouldReturn` | NONE | `shouldBe ::` `shouldReturn ::` |
| `how do I write a spec with describe and it` | NONE | `it ::` `describe ::` |

`hspec` goes from 14 chunks to 133. The retrieved budget is unchanged at 8 chunks; bytes
go 1,960 to 2,914, well inside the 24,000 budget.

Cost, same run, same cache: aeson 533 ms, scotty 232 ms, hspec 546 ms, and the `packages`
table holds exactly the three packages that were asked about. A supplement is folded into
the asking package's rows and is never registered as a package of its own.

## What this does not claim

The rule is derived from twenty hackage packages. It is an indexing change, and defect 11
is the standing proof that an index that improves does not mean an answer that improves.
The claim still to test is a live one: does the `hspec` child stop abstaining.
