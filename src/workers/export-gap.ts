/**
 * What a facade package publishes and does not declare.
 *
 * `hspec` indexes to a table of contents and every signature is in `hspec-core`;
 * `axum` re-exports `IntoResponse` and the trait lives in `axum-core`. Both are
 * the same failure — a query retrieves the package's own chunks and not one of
 * them defines the thing asked about — and DEFECT-12-STOPPING-RULE.md fixes the
 * boundary for following the re-export.
 *
 * The boundary is shared; the parsing is not. Haskell states the gap in an export
 * list, Rust in `pub use`, so each ecosystem answers the same three questions in
 * its own syntax and the indexer never learns either language.
 */
export type ExportGap = {
    /** No hole at all, so no supplement is opened. */
    empty: boolean
    /**
     * Does this whole supplement file belong in the index? True for the target of
     * a wholesale re-export — Haskell's `module X`, Rust's `pub use x::y::*`.
     * Given both the path and the source because Haskell names its module in the
     * source and Rust names it by file location.
     */
    wholesale: (relPath: string, rawSource: string) => boolean
    /** Does this chunk declare a name the facade publishes and lacks? */
    fillsHole: (chunkBody: string) => boolean
}
