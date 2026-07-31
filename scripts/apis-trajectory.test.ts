import {test, expect, describe} from 'bun:test'
import {
    parseTrajectory,
    stepModule,
    extractSection,
    parseApisEntries,
    extractSymbols,
    channelsFor,
    groundEntries,
    groundEntriesStrict,
    queryTokens,
    jaccard,
    repeatFlags,
    noveltyCurve,
    classifyQuery,
    type GroundingCorpus
} from './apis-trajectory.js'

// Verbatim from ~/tmp/apis-termination-diagnostic/trial-1/trial.log, debug copies included:
// every call is logged twice and a scorer that counts both doubles every number.
const LOG = [
    '[debug] worker:apis: start',
    '[debug] worker:apis: pi-worker-docs: hono/client "hc function signature, AppType g…"',
    'worker:apis: pi-worker-docs: hono/client "hc function signature, AppType g…"',
    '[debug] worker:apis: pi-worker-docs: . "src/index.ts exports — app, AppType…"',
    'worker:apis: pi-worker-docs: . "src/index.ts exports — app, AppType…"',
    'worker:files: read: src/other.ts',
    'worker:apis: read: src/server/routes/photos.ts',
    'worker:apis: writing answer…'
].join('\n')

describe('parseTrajectory', () => {
    test('drops the [debug] duplicate of every line', () => {
        const steps = parseTrajectory(LOG)
        expect(steps.filter(s => s.tool === 'pi-worker-docs')).toHaveLength(2)
    })

    test('keeps order and ignores other workers labels', () => {
        expect(parseTrajectory(LOG).map(s => s.tool)).toEqual([
            'pi-worker-docs',
            'pi-worker-docs',
            'read',
            'writing answer…'
        ])
    })

    test('a turn marker with no argument is kept, with an empty arg', () => {
        const last = parseTrajectory(LOG).at(-1)
        expect(last).toEqual({tool: 'writing answer…', arg: ''})
    })

    test('stepModule splits the package off the clipped query, and "." off project source', () => {
        const [pkg, proj] = parseTrajectory(LOG)
        expect(stepModule(pkg)).toBe('hono/client')
        expect(stepModule(proj)).toBe('.')
        expect(stepModule({tool: 'read', arg: 'x.ts'})).toBeNull()
    })
})

describe('extractSection', () => {
    const research = 'FILES\nsrc/a.ts  thing\n\nAPIS\nhc  the client\napi.auth  login\n\nCONTEXT\n- x'

    test('returns one section body without its neighbours', () => {
        expect(extractSection(research, 'APIS')).toBe('hc  the client\napi.auth  login')
    })

    test('a missing section is empty, not a throw', () => {
        expect(extractSection(research, 'TOOLING')).toBe('')
    })
})

describe('parseApisEntries', () => {
    test('splits name from description on a double space', () => {
        const [e] = parseApisEntries('hc<AppType>  creates the typed client')
        expect(e.name).toBe('hc<AppType>')
        expect(e.rest).toBe('creates the typed client')
    })

    test('tolerates the bullet and dash shapes a weak model emits', () => {
        const es = parseApisEntries('- api.auth.login.$post — POST /api/auth/login\n* hc: factory')
        expect(es.map(e => e.name)).toEqual(['api.auth.login.$post', 'hc'])
    })

    test('a line with no separator is treated as all name, not dropped', () => {
        const [e] = parseApisEntries('zValidator')
        expect(e.name).toBe('zValidator')
        expect(e.rest).toBe('')
    })

    test('blank lines produce no entries', () => {
        expect(parseApisEntries('\n\n   \n')).toEqual([])
    })
})

describe('extractSymbols', () => {
    test('pulls identifiers out of a dotted, generic-bearing name', () => {
        expect(extractSymbols('hc<AppType>().auth.$post')).toEqual(['AppType', 'auth', '$post'])
    })

    test('drops tokens under three characters — "hc" is not a discriminating substring', () => {
        expect(extractSymbols('hc')).toEqual([])
    })

    test('deduplicates', () => {
        expect(extractSymbols('listings.listings')).toEqual(['listings'])
    })
})

describe('channelsFor / groundEntries', () => {
    const corpus = (o: Partial<GroundingCorpus>): GroundingCorpus => ({
        prompt: '',
        docsProject: '',
        docsPackage: '',
        reads: '',
        ...o
    })

    test('a symbol present in no channel is the finding', () => {
        expect(channelsFor('ClientRequestOptions', corpus({prompt: 'nothing here'}))).toEqual([])
    })

    test('every channel that carries the symbol is reported, not just the first', () => {
        const c = corpus({docsPackage: 'AppType', prompt: 'AppType', reads: 'AppType'})
        expect(channelsFor('AppType', c).sort()).toEqual(['docs-package', 'prompt', 'read'])
    })

    test('the match is case-sensitive: "SQL" in prose does not ground "sql"', () => {
        expect(channelsFor('sql', corpus({prompt: 'uses SQL for storage'}))).toEqual([])
    })

    test('an entry is ungrounded only for the symbols no channel carries', () => {
        const [g] = groundEntries(
            parseApisEntries('client.auth.$post  login'),
            corpus({docsProject: 'auth'})
        )
        expect(g.ungrounded.sort()).toEqual(['$post', 'client'])
        expect(g.channels).toEqual(['docs-project'])
    })

    test('prose in an entry name grounds against the prompt and cannot inflate the rate', () => {
        const [g] = groundEntries(
            parseApisEntries('the listings endpoint'),
            corpus({prompt: 'the listings endpoint is defined in routes'})
        )
        expect(g.ungrounded).toEqual([])
    })
})

describe('repeat and novelty shape', () => {
    // "the" survives: the token filter is length-only, and no stop-list is applied anywhere
    // in this module. Prose tokens overlap identically in both queries being compared, so they
    // can only pull a Jaccard score toward 1 — i.e. toward calling something a REPEAT. That is
    // the direction that would overstate saturation, so it is checked, not assumed away.
    test('queryTokens lowercases and keeps every token over two characters, prose included', () => {
        expect([...queryTokens('The hc BASE url')].sort()).toEqual(['base', 'the', 'url'])
    })

    test('jaccard is 1 for identical token sets and 0 for disjoint ones', () => {
        expect(jaccard(queryTokens('alpha beta'), queryTokens('beta alpha'))).toBe(1)
        expect(jaccard(queryTokens('alpha beta'), queryTokens('gamma delta'))).toBe(0)
    })

    test('a re-ask of the same module is flagged; the first ask never is', () => {
        const flags = repeatFlags([
            {module: '.', query: 'auth.ts route definitions endpoints'},
            {module: '.', query: 'auth.ts exact route definitions endpoints zValidator'},
            {module: '.', query: 'schema.ts exported zod schemas types'}
        ])
        expect(flags).toEqual([false, true, false])
    })

    test('the same query against a DIFFERENT module is not a repeat', () => {
        const flags = repeatFlags([
            {module: 'hono', query: 'client factory base url'},
            {module: 'hono/client', query: 'client factory base url'}
        ])
        expect(flags).toEqual([false, false])
    })

    test('a signature question and a semantics question about the SAME symbol split apart', () => {
        expect(classifyQuery('hc factory function signature base url parameter types')).toBe(
            'signature-only'
        )
        expect(classifyQuery('what does the hc base URL argument mean — origin or prefix?')).toBe(
            'behaviour'
        )
    })

    test('behaviour wins when a query asks for both, so signature-only is never overstated', () => {
        expect(classifyQuery('createRoot type signature and how does render behave')).toBe(
            'behaviour'
        )
    })

    test('a bare subject query is neither, not silently counted as a signature ask', () => {
        expect(classifyQuery('src/server/routes/auth.ts')).toBe('neither')
    })

    test('novelty counts only symbols no earlier answer carried', () => {
        expect(noveltyCurve(['AppType baseUrl', 'AppType ClientResponse', 'AppType'])).toEqual([
            2, 1, 0
        ])
    })
})

// ─── strict grounding ────────────────────────────────────────────────────────
// Every case below is a symbol the live research-fanout A/B flagged as a
// fabrication and that inspection proved real. Together they failed two arms.

describe('groundEntriesStrict', () => {
    const empty: GroundingCorpus = {prompt: '', docsProject: '', docsPackage: '', reads: ''}

    test('drops the model preamble that was parsed as an entry', () => {
        // Verbatim from carry/TASK_0019 and rescue/TASK_0022.
        const section = [
            'Now I have all the information needed. Here is the APIS section:',
            'openDb  (path: string) => Database'
        ].join('\n')
        const strict = groundEntriesStrict(parseApisEntries(section), empty)
        expect(strict.map(g => g.entry.name)).toEqual(['openDb'])
        // The old path scored Now/information/needed/Here/APIS as ungrounded.
        expect(groundEntries(parseApisEntries(section), empty)[0]!.ungrounded).toContain('information')
    })

    test('platform APIs are grounded, not fabricated', () => {
        // rescue/TASK_0019's entire "regression" was these two entries.
        const entries = parseApisEntries(
            'URL.createObjectURL()  browser builtin for object URLs\n'
                + 'URL.revokeObjectURL()  release a previously created object URL'
        )
        const strict = groundEntriesStrict(entries, empty)
        expect(strict.flatMap(g => g.ungrounded)).toEqual([])
        expect(strict[0]!.channels).toContain('platform')
        // …and the exclusion is auditable rather than silent.
        expect(strict[0]!.excluded).toContain('createObjectURL')
    })

    test('parameter placeholders are not claims about symbols', () => {
        const strict = groundEntriesStrict(
            parseApisEntries('component.locator(selector)  find an element within the component'),
            empty
        )
        expect(strict[0]!.ungrounded).not.toContain('selector')
        expect(strict[0]!.excluded).toContain('selector')
        // The thing actually being claimed still gets tested.
        expect(strict[0]!.ungrounded).toContain('locator')
    })

    test('a genuine fabrication still fails', () => {
        // The anti-gaming property: none of the three corrections may hide a
        // symbol that is neither platform, parameter, nor retrieved. `Textarea`
        // is the real one the carry arm produced.
        const strict = groundEntriesStrict(
            parseApisEntries('Textarea  styled textarea component in src/client/components/ui'),
            {...empty, reads: 'export const Input = ...\nexport const Label = ...'}
        )
        expect(strict[0]!.ungrounded).toContain('Textarea')
    })

    test('members reached through a platform root are platform too', () => {
        // progress/TASK_0021 trial 0: `navigator` was excluded and `writeText`
        // was not, because PLATFORM_SYMBOLS is enumerated from bun's globalThis,
        // which carries no `clipboard`. It was the trial's ONLY "fabrication".
        const strict = groundEntriesStrict(
            parseApisEntries('navigator.clipboard.writeText(url)  copy the invite URL'),
            empty
        )
        expect(strict[0]!.ungrounded).toEqual([])
        expect(strict[0]!.excluded).toContain('writeText')
        expect(strict[0]!.channels).toContain('platform')
    })

    test('the chain rule does not launder a non-platform root', () => {
        // Playwright's locator methods are a PACKAGE API — a retrieval gap, not a
        // platform name. A flat list of DOM member names would have hidden them.
        const strict = groundEntriesStrict(
            parseApisEntries('locator.selectOption(value)  choose an option in a select'),
            empty
        )
        expect(strict[0]!.ungrounded).toContain('selectOption')
    })

    test('a retrieved symbol is grounded through its real channel', () => {
        const strict = groundEntriesStrict(parseApisEntries('zValidator  hono middleware'), {
            ...empty,
            docsPackage: 'import { zValidator } from "@hono/zod-validator"'
        })
        expect(strict[0]!.ungrounded).toEqual([])
        expect(strict[0]!.channels).toContain('docs-package')
    })
})
