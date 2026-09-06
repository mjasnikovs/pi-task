import {test, expect} from 'bun:test'
import {inventedSymbols, scoreRecall} from '../../scripts/docs-live-audit.js'
import type {TypeOnlyLogRecord} from '../../src/workers/typeonly-log.js'

// The tool's return embeds the answer prose, so scoring the answer against it asks
// whether the answer contains itself. It always does: two live runs read 13/13,
// 12/12, 10/10, 13/13, 4/4 and 2/2 clean — 54 answers, not one miss — while one of
// them shipped `decodeFile`, a function aeson 2 does not have.
const ANSWER = 'Use `decodeFile` to read a file.'
const TOOL_TEXT = `### hackage: aeson\n\nPer aeson@2.2.5.1:\n\n${ANSWER}\n\nSource excerpt:\n> decodeFileStrict :: FromJSON a => FilePath -> IO (Maybe a)`
const RETRIEVED = '-- src/Data/Aeson.hs\ndecodeFileStrict :: FromJSON a => FilePath -> IO (Maybe a)'

test('the tool return excuses any symbol, because it contains the answer', () => {
    expect(inventedSymbols(ANSWER, TOOL_TEXT)).toEqual([])
})

test('the retrieved chunks catch it', () => {
    expect(inventedSymbols(ANSWER, RETRIEVED)).toContain('decodeFile')
})

test('a symbol the retrieved chunks DO carry stays clean', () => {
    expect(inventedSymbols('Use `decodeFileStrict` here.', RETRIEVED)).toEqual([])
})

// From the 2026-09-05 second re-run: 17 flags, and every one a false positive. These
// runs ask about symbols that do not exist, so the child's best answer is the one that
// names an invented symbol in order to deny it — and that scored as fabricating it.
const REFUTING = {
    answer:
        'The content contradicts several claimed signatures: `eitherDecode` is '
        + 'actually `LBS.ByteString -> Either String a` (not `DecodeError`). '
        + 'Neither `eitherDecodeFile` nor a `prettyShow`/`failureMsg` type appears.',
    // Verbatim from the run's own retrievedText.
    retrieved:
        '-- src/Data/Aeson.hs\n'
        + 'eitherDecode :: (A.FromJSON a) => LBS.ByteString -> Either String a'
}

test('a symbol named in order to deny it was not invented', () => {
    expect(inventedSymbols(REFUTING.answer, REFUTING.retrieved)).toEqual([])
})

// The reason the fix scopes to the denying sentence rather than excusing every symbol
// the question supplied: these questions NAME the fabrication, so trusting the query
// would clear the confirmation too, which is the whole defect.
test('the same symbol CONFIRMED is still invented', () => {
    expect(inventedSymbols('Use `decodeFile` to read a file.', REFUTING.retrieved)).toContain(
        'decodeFile'
    )
})

// `{ method: 'POST' }` inside a code span. The identifier pattern admits a trailing `'`
// so Haskell primes survive whole, and here it swallowed the closing quote.
test('a quote swallowed by the prime rule is not an invented symbol', () => {
    expect(inventedSymbols("Pass `{ method: 'POST' }`.", 'method?: POST | GET')).toEqual([])
})

// Four false-positive families, every string below lifted verbatim from the recorded
// answers of the 2026-09-06 re-runs. Together they were 4 of the 8 remaining flags.
test('a language literal is not the package API', () => {
    expect(
        inventedSymbols('It returns `{ success: false, error }`.', 'success data error')
    ).toEqual([])
})

test('a member of a language global is not the package API', () => {
    expect(inventedSymbols('Serialize with `JSON.stringify(err.issues)`.', 'issues err')).toEqual(
        []
    )
})

test('a node stdlib module path is not the package API', () => {
    expect(
        inventedSymbols('Use the `readFile` export from `node:fs/promises`.', 'readFile')
    ).toEqual([])
})

// `#[serde(rename_all = "camelCase")]` over `pub admin_email`. The child derived the
// wire name correctly, and the corpus carries the symbol it derived it from.
test('a rename of a known symbol is not invented', () => {
    expect(inventedSymbols('The field is `adminEmail`.', 'pub admin_email: String')).toEqual([])
})

// The same fold clears `let router = Router::new()` — a binding named after its type.
test('a binding named after its own type is not invented', () => {
    expect(
        inventedSymbols('Pass `axum::serve(listener, router)`.', 'axum Router listener serve')
    ).toEqual([])
})

// The fold must not reach past a case difference. `decodeFile` and `decodeFileStrict`
// are the confusion these runs keep producing, and it is the one the scorer must keep.
test('the fold does not clear a symbol that only shares a stem', () => {
    expect(inventedSymbols('Use `decodeFile` here.', 'decodeFileStrict')).toContain('decodeFile')
})

// Re-run 3 reported `scotty:ActionM` missed. It is indexed, and a query naming it
// retrieves it — no scotty query in that run named it. Gating on the PACKAGE is
// what let a symbol nobody asked about count as a miss.
const askedForScotty = (query: string, answer: string): Map<string, TypeOnlyLogRecord[]> =>
    new Map([['scotty', [{module: 'scotty', query, answer} as TypeOnlyLogRecord]]])

test('a symbol no query named and no answer carried is not scored at all', () => {
    const r = scoreRecall(
        [{pkg: 'scotty', symbol: 'ActionM', topic: 'the handler monad'}],
        {scotty: '0.30'},
        askedForScotty('type signature of json in scotty', 'json :: ToJSON a => a -> ActionT m ()')
    )
    expect(r).toEqual({hit: 0, of: 0, missed: []})
})

test('a symbol the query named and the answer missed is still a miss', () => {
    const r = scoreRecall(
        [{pkg: 'scotty', symbol: 'ActionM', topic: 'the handler monad'}],
        {scotty: '0.30'},
        askedForScotty('what is ActionM', 'The handler runs in a monad.')
    )
    expect(r).toEqual({hit: 0, of: 1, missed: ['scotty:ActionM']})
})

test('an answer that carries the symbol is a hit however the query was phrased', () => {
    const r = scoreRecall(
        [{pkg: 'scotty', symbol: 'ActionM', topic: 'the handler monad'}],
        {scotty: '0.30'},
        askedForScotty('the handler monad', 'Handlers run in `ActionM`.')
    )
    expect(r).toEqual({hit: 1, of: 1, missed: []})
})

test('a package the run never asked about is not scored', () => {
    const r = scoreRecall(
        [{pkg: 'aeson', symbol: 'FromJSON', topic: 'the decoding class'}],
        {aeson: '2.2.5.1'},
        new Map()
    )
    expect(r).toEqual({hit: 0, of: 0, missed: []})
})
