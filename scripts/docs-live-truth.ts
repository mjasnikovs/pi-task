/**
 * Ground truth for the live docs test. DATA ONLY — no I/O, nothing runs on import.
 *
 * Kept apart from the audit so a rescore reads recorded answers and never
 * re-retrieves. A rescore that re-retrieves is not a rescore: the container and
 * the host once shipped different chunks for the same question, and the "rescore"
 * silently became a second measurement.
 */

export type EcosystemId = 'npm' | 'cargo' | 'hackage'

export interface ProjectSpec {
    /** Directory name under the run root, and the label in every report. */
    id: 'ts' | 'rs' | 'hs'
    ecosystem: EcosystemId
    /** Packages the task must use, pinned to the major the model predates. */
    pins: Record<string, string>
    /** The command that decides build/test green. */
    testCommand: string
}

/**
 * One declaration that exists in the package and is the answer to one question.
 *
 * `symbol` must appear in the package's own surface, so a retrieval miss is
 * attributable to BM25, the surface extractor or the chunker rather than to a
 * scorer that asked for something the package never had. Every entry is checked
 * against the seeded package by `--check-truth` before any run is scored.
 */
export interface TruthEntry {
    pkg: string
    /** Substring that must appear in the tool's returned text for recall to pass. */
    symbol: string
    /** What a worker would plausibly ask to reach it. */
    topic: string
}

/**
 * A use of the PREVIOUS major, written from memory instead of from the docs answer.
 *
 * These are the point of the version pins. Each one is a break the registry made
 * loudly, so a hit is not a style difference — it is code that cannot work against
 * the version the manifest pins.
 */
export interface StaleMarker {
    pkg: string
    /** Matched against the run's source files. */
    pattern: RegExp
    /** What the current major uses instead, for the report. */
    instead: string
}

export const PROJECTS: readonly ProjectSpec[] = [
    {
        id: 'ts',
        ecosystem: 'npm',
        pins: {zod: '4.5.4', hono: '4.13.7'},
        testCommand: 'bun test'
    },
    {
        id: 'rs',
        ecosystem: 'cargo',
        pins: {axum: '0.8.9', tokio: '1.53.1', serde_json: '1.0.151'},
        testCommand: 'cargo test'
    },
    {
        id: 'hs',
        ecosystem: 'hackage',
        pins: {aeson: '2.2.5.1', scotty: '0.30'},
        testCommand: 'cabal test'
    }
]

export const TRUTH: readonly TruthEntry[] = [
    // npm — zod 4 renamed both of these out of v3.
    {pkg: 'zod', symbol: 'safeParse', topic: 'parse without throwing'},
    {pkg: 'zod', symbol: 'issues', topic: 'reading validation errors'},
    {pkg: 'hono', symbol: 'Hono', topic: 'creating an app and a GET route'},
    {pkg: 'hono', symbol: 'json', topic: 'returning a JSON response'},

    // cargo
    {pkg: 'axum', symbol: 'Router', topic: 'defining a route'},
    {pkg: 'axum', symbol: 'Json', topic: 'returning JSON from a handler'},
    {pkg: 'serde_json', symbol: 'from_str', topic: 'parsing a string'},
    {pkg: 'tokio', symbol: 'TcpListener', topic: 'binding a listener'},

    // hackage
    {pkg: 'aeson', symbol: 'eitherDecode', topic: 'decoding with an error'},
    {pkg: 'aeson', symbol: 'FromJSON', topic: 'the decoding class'},
    {pkg: 'scotty', symbol: 'scotty', topic: 'starting the server'},
    {pkg: 'scotty', symbol: 'ActionM', topic: 'the handler monad'}
]

export const STALE: readonly StaleMarker[] = [
    // axum 0.7 -> 0.8: path params changed from `:id` to `{id}`.
    {
        pkg: 'axum',
        pattern: /\.route\(\s*"[^"]*\/:[A-Za-z_]/,
        instead: 'axum 0.8 writes path params as {id}, not :id'
    },
    // zod 3 -> 4: ZodError.errors became .issues.
    {
        pkg: 'zod',
        pattern: /\b(?:error|err|result\.error)\s*\.\s*errors\b/,
        instead: 'zod 4 exposes .issues, not .errors'
    },
    // zod 3 -> 4: the string-format checks moved off the string schema.
    {
        pkg: 'zod',
        pattern: /z\s*\.\s*string\(\)\s*\.\s*(?:email|url|uuid)\(/,
        instead: 'zod 4 uses z.email() / z.url() / z.uuid()'
    },
    // aeson 1 -> 2: objects are a KeyMap, not a HashMap.
    {
        pkg: 'aeson',
        pattern: /import\s+.*Data\.HashMap\.Strict/,
        instead: 'aeson 2 objects are Data.Aeson.KeyMap'
    },
    // scotty 0.20 deprecated `param` in favour of pathParam / queryParam.
    {
        pkg: 'scotty',
        pattern: /(?<![A-Za-z])param\s+"/,
        instead: 'scotty 0.30 uses pathParam / queryParam, not param'
    }
]
