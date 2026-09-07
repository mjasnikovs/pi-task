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
    /**
     * The command that decides build/test green.
     *
     * It must COMPILE the code the run wrote, not just run whatever the test
     * target happens to reference. The Haskell run made this concrete: its
     * test-suite stanza does not depend on the library, and `test/Spec.hs` was
     * left as `main = pure ()`, so `cabal test` exited 0 while `cabal build all`
     * failed with four errors in the run's own source. A verify that cannot fail
     * is not a verify.
     */
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
    /**
     * What a QUERY says when it is asking for `symbol`, when the two differ.
     *
     * `Bun.file` is how every recorded query names it and `function file` is how
     * `bun.d.ts` declares it. Selecting on the declared name would match the word
     * "file" in almost every question asked; selecting on the written name would
     * look for a declaration head that does not exist. Defaults to `symbol`.
     */
    named?: string
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
        testCommand: 'cabal build all && cabal test'
    }
]

export const TRUTH: readonly TruthEntry[] = [
    // npm — zod 4 renamed both of these out of v3.
    {pkg: 'zod', symbol: 'safeParse', topic: 'parse without throwing'},
    {pkg: 'zod', symbol: 'issues', topic: 'reading validation errors'},
    // The symbol three live runs have got wrong: zod 4 declares
    // `export declare function email(params?): ZodEmail` in v4/classic/schemas.d.ts,
    // and the shipped code wrote `z.string().email()` twice and `z.string()` once.
    // Named by 36 recorded queries; whole-token selection keeps it off `adminEmail`.
    {pkg: 'zod', symbol: 'email', topic: 'validating an email field'},
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
    {pkg: 'scotty', symbol: 'ActionM', topic: 'the handler monad'},

    // The Bun family and node builtins. NOT pinned in any project — both existing
    // consumers gate on `t.pkg in spec.pins`, so these reach `docs-defines` and
    // nothing else. They exist because the chunk table's worst-shaped packages are
    // the ones no truth entry could see: `@types/node` and `bun-types` hold 87% and
    // 78% of their bytes in cap-filling slices, and defines was blind to both.
    //
    // Every symbol below is named by a recorded query and declared by the published
    // docs, which is the only sound way to write one — reading the index for
    // candidates is how a truth set stops being a truth set.
    {pkg: 'bun', symbol: 'file', named: 'Bun.file', topic: 'reading a file'},
    {pkg: 'bun', symbol: 'write', named: 'Bun.write', topic: 'writing a file'},
    {pkg: 'bun-types', symbol: 'file', named: 'Bun.file', topic: 'reading a file'},
    {pkg: 'bun:test', symbol: 'describe', topic: 'grouping tests'},
    {pkg: 'bun:test', symbol: 'expect', topic: 'asserting'},
    {pkg: 'bun:test', symbol: 'beforeEach', topic: 'per-test setup'},
    // Two letters, deliberately. `MIN_TOKEN_LEN` drops tokens shorter than itself
    // and no truth entry could hold one, so the constant had no way to be decided.
    // Selection is whole-token since `queryAsks`, so this does not match "with".
    {pkg: 'bun:test', symbol: 'it', topic: 'a single test'},
    {pkg: 'node:url', symbol: 'fileURLToPath', topic: 'import.meta.url to a path'},
    {pkg: 'node:fs/promises', symbol: 'readFile', topic: 'reading a file'}
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

/**
 * A clause of the feature text that the shipped source has to satisfy.
 *
 * STALE catches code written against the WRONG major. It cannot catch code that
 * does not write the thing at all, and re-run 7 is why that matters: asked for a
 * schema "requiring a string name, a port between 1 and 65535, and an admin email",
 * with the tool answering `z.email()` in the same run, it shipped
 * `adminEmail: z.string()`. No email validation, a green build, no stale marker to
 * match — a PASS on a run that did not do what it was asked.
 *
 * Deliberately thin. One entry per clause the FEATURES text states in so many
 * words, and no entry that needs judgement to score.
 */
export interface Obligation {
    project: ProjectSpec['id']
    /** The clause, quoted closely enough to find it in FEATURES. */
    clause: string
    /** What the shipped source must contain to have done it. */
    pattern: RegExp
}

export const OBLIGATIONS: readonly Obligation[] = [
    // ts: "requiring a string name, a port between 1 and 65535, and an admin email"
    {project: 'ts', clause: 'validates an admin email', pattern: /z\s*\.\s*email\(|\.\s*email\(/},
    {
        project: 'ts',
        clause: 'bounds the port to 1..65535',
        pattern: /\b65535\b/
    },
    // rs: the same three obligations, in serde's vocabulary.
    {
        project: 'rs',
        clause: 'maps the adminEmail wire key',
        pattern: /adminEmail/
    },
    // hs: aeson's.
    {
        project: 'hs',
        clause: 'maps the adminEmail wire key',
        pattern: /adminEmail/
    }
]
