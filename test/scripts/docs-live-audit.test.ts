import {test, expect} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {OBLIGATIONS} from '../../scripts/docs-live-truth.js'
import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {
    inventedSymbols,
    pinVersion,
    scoreRecall,
    sourceFiles,
    taskProgress,
    truthKey,
    webFollowsDocs
} from '../../scripts/docs-live-audit.js'
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

// The cargo facade fix (defect 16) files a supplement's chunks under the crate's
// PUBLISHED name — `axum-core-0.5.6/src/…` — while Rust code writes `axum_core`.
// re-run 5 flagged an answer for `axum_core::body::Body` whose corpus carried
// `axum-core` throughout. `eco-cargo.ts` already treats the two spellings as one
// crate; the scorer did not.
test('a crate named with the other separator is not invented', () => {
    const corpus = '-- axum-core-0.5.6/src/body.rs\npub struct Body(BoxBody);'
    expect(inventedSymbols('The type is `axum_core::body::Body`.', corpus)).toEqual([])
})

test('the reverse spelling is covered too', () => {
    expect(inventedSymbols('See `tokio-util` here.', 'pub mod tokio_util;')).toEqual([])
})

test('a name that differs by more than a separator is still invented', () => {
    expect(inventedSymbols('The type is `axum_kore`.', 'axum-core-0.5.6/src/body.rs')).toContain(
        'axum_kore'
    )
})

// Run 6's hs was killed by a container stop at task 1 of its plan. `.pi-tasks/`
// existed, the Haskell skeleton still built green, and the audit scored it PASS
// with zero docs calls. The fix adds this seam, so the test cannot fail on the
// tree before it; the defect is on record in that run's own AUDIT.md instead.
test('a run stopped mid-flight is not complete', () => {
    const root = tmpDir('audit-progress-')
    mkdirSync(join(root, '.pi-tasks'))
    writeFileSync(join(root, '.pi-tasks', 'TASK_0001.md'), 'state: in_progress\n')
    writeFileSync(join(root, '.pi-tasks', 'TASK_AUTO_0001.md'), 'state: in_progress\n')
    expect(taskProgress(root)).toEqual({tasks: 1, done: 0})
})

test('the plan file is not a task', () => {
    const root = tmpDir('audit-progress-')
    mkdirSync(join(root, '.pi-tasks'))
    writeFileSync(join(root, '.pi-tasks', 'TASK_0001.md'), 'state: completed\n')
    writeFileSync(join(root, '.pi-tasks', 'TASK_AUTO_0001.md'), 'state: in_progress\n')
    expect(taskProgress(root)).toEqual({tasks: 1, done: 1})
})

test('no .pi-tasks is zero tasks, not a finished run', () => {
    expect(taskProgress(tmpDir('audit-progress-'))).toEqual({
        tasks: 0,
        done: 0
    })
})

// STALE catches code written against the wrong major. It cannot catch code that does
// not write the thing at all: re-run 7's ts shipped `adminEmail: z.string()` against
// a feature requiring an admin email, built green, matched no stale marker, and would
// have read PASS. Verified on the two real trees — run 6 meets it, run 7 does not.
const tsEmail = OBLIGATIONS.find(o => o.project === 'ts' && o.clause.includes('email'))!

test('the v4 form meets the email obligation', () => {
    expect(tsEmail.pattern.test('adminEmail: z.email(),')).toBe(true)
})

test('the deprecated v3 form still meets it — it validates', () => {
    expect(tsEmail.pattern.test('adminEmail: z.string().email(),')).toBe(true)
})

test('a bare string does not meet it', () => {
    expect(tsEmail.pattern.test('adminEmail: z.string(),')).toBe(false)
})

test('the field NAME alone does not meet it', () => {
    expect(tsEmail.pattern.test('const adminEmail = raw.adminEmail')).toBe(false)
})

// Go's obligation is the LOGGING clause, not the wire key. encoding/json matches a
// field name case-insensitively, so `AdminEmail` decodes `adminEmail` with no tag at
// all and a grep for the key would fail working code.
const goZap = OBLIGATIONS.find(o => o.project === 'go')!

test('a zap call meets the go obligation', () => {
    expect(goZap.pattern.test('logger.Info("loaded"); zap.L().Error(err)')).toBe(true)
})

test('importing zap without calling it does not meet it', () => {
    expect(goZap.pattern.test('import (\n\t_ "go.uber.org/zap"\n)')).toBe(false)
})

// Both sides get stripped. Go carries the `v` on the PIN, so stripping only the
// manifest's side read `v1.12.0 -> v1.12.0` as a moved pin, and no Go tree could
// have cleared the check.
test('a go pin equals its own resolved version', () => {
    expect(pinVersion('v1.12.0')).toBe(pinVersion('v1.12.0'))
})

test('a range operator still compares equal to the bare version', () => {
    expect(pinVersion('^4.5.4')).toBe(pinVersion('4.5.4'))
})

test('a moved go pin still differs', () => {
    expect(pinVersion('v1.11.0')).not.toBe(pinVersion('v1.12.0'))
})

// Everything before the first slash turned `github.com/gin-gonic/gin` into
// `github.com`, which no truth entry can match — so the first Go run scored
// recall 0/0 and still printed PASS. Re-keyed it reads 3/3, and no ts, rs or hs
// record in the 234 recorded before it changes bucket.
const GO_PINS = {'github.com/gin-gonic/gin': 'v1.12.0', 'go.uber.org/zap': 'v1.28.0'}

test('an import path keys to its own pin, not its host', () => {
    expect(truthKey('github.com/gin-gonic/gin', GO_PINS)).toBe('github.com/gin-gonic/gin')
})

test('a subpackage counts toward the module that serves it', () => {
    expect(truthKey('github.com/gin-gonic/gin/binding', GO_PINS)).toBe('github.com/gin-gonic/gin')
})

test('an unpinned import path keeps the old first-segment rule', () => {
    expect(truthKey('golang.org/x/net/html', GO_PINS)).toBe('golang.org')
})

test('an npm subpath still folds onto its package', () => {
    expect(truthKey('hono/client', {hono: '4.13.7'})).toBe('hono')
})

// The stale sweep and the obligations both read this list, and it did not match
// `.go` — so every Go clause read unmet and no Go source was ever swept.
test('a go source file is collected', () => {
    const root = tmpDir('audit-go-sources')
    writeFileSync(join(root, 'config.go'), 'package config\n')
    writeFileSync(join(root, 'config.ts'), 'export {}\n')
    expect(
        sourceFiles(root)
            .map(f => f.split('/').pop())
            .sort()
    ).toEqual(['config.go', 'config.ts'])
})

// Re-run 7's hs planned three tasks, had ONE spec file written, and the runner's
// progress() — which counts TASK_NNNN.md — read 1/1 and settled. The plan's own
// checklist is the truth: ts read 4/4 ticked and rs 5/5, hs 0/3.
const PLAN = `---
id: TASK_AUTO_0001
---

## tasks

- [x] TASK_0001  Scaffold the project | decisions: none
- [ ] Wire the executable | decisions: none
- [ ] Write the tests | decisions: none

## coverage
`

test('the plan checklist is what says how far a run got', () => {
    const root = tmpDir('audit-plan-')
    mkdirSync(join(root, '.pi-tasks'))
    writeFileSync(join(root, '.pi-tasks', 'TASK_AUTO_0001.md'), PLAN)
    writeFileSync(join(root, '.pi-tasks', 'TASK_0001.md'), 'state: completed\n')
    expect(taskProgress(root)).toEqual({tasks: 3, done: 1})
})

test('with no plan it falls back to the spec files', () => {
    const root = tmpDir('audit-plan-')
    mkdirSync(join(root, '.pi-tasks'))
    writeFileSync(join(root, '.pi-tasks', 'TASK_0001.md'), 'state: completed\n')
    writeFileSync(join(root, '.pi-tasks', 'TASK_0002.md'), 'state: in_progress\n')
    expect(taskProgress(root)).toEqual({tasks: 2, done: 1})
})

test('a checklist line outside the tasks section is not a task', () => {
    const root = tmpDir('audit-plan-')
    mkdirSync(join(root, '.pi-tasks'))
    writeFileSync(
        join(root, '.pi-tasks', 'TASK_AUTO_0001.md'),
        `## tasks\n\n- [x] TASK_0001 one\n\n## coverage\n\n- [ ] not a task\n`
    )
    expect(taskProgress(root)).toEqual({tasks: 1, done: 1})
})

// The strongest signal the audit has — the docs tool was asked, and the model went to
// the web anyway — read 0 in every run because it compared a docs module (`wai-test`)
// to a fetch's own label, which is a URL. hackage run 8 asked docs about wai-test and
// aeson and then fetched hackage.haskell.org for both, eleven times, scoring 0.
test('a fetch URL naming a package the docs tool was asked about counts', () => {
    expect(
        webFollowsDocs(new Set(['wai-test', 'aeson', '.']), [
            {phase: 'worker:apis', module: 'https://hackage.haskell.org/package/wai-test-3.0.0'}
        ])
    ).toEqual(['wai-test'])
})

test('a search query naming the package counts too', () => {
    expect(webFollowsDocs(new Set(['wai-test']), [{phase: 'p', module: '""wai-test"'}])).toEqual([
        'wai-test'
    ])
})

test('a package the docs tool was never asked about does not count', () => {
    expect(
        webFollowsDocs(new Set(['aeson']), [{phase: 'p', module: 'https://example.com/scotty'}])
    ).toEqual([])
})

test('the project corpus is not a package name to match on', () => {
    expect(
        webFollowsDocs(new Set(['.']), [{phase: 'p', module: 'https://a.example/b.html'}])
    ).toEqual([])
})

test('a name inside a longer word is not a match', () => {
    expect(webFollowsDocs(new Set(['wai']), [{phase: 'p', module: 'https://x/waitress'}])).toEqual(
        []
    )
})
