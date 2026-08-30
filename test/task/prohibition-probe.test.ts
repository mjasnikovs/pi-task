import {describe, expect, test} from 'bun:test'
import {extractProhibitions, findProhibitionViolations} from '../../src/task/prohibition-probe.js'

// The shape the extractor has to survive: one prohibition line naming several
// paths, with backticked NON-path tokens — an API route, an object literal, a bare
// identifier — mixed into the same prose.
const MIXED_CONSTRAINT =
    '- **Do NOT modify** any server-side code: `src/server/routes/listings.ts`, '
    + '`src/server/routes/photos.ts`, `src/server/auth.ts`, `src/server/index.ts`, or the '
    + 'shared schema in `src/shared/schema.ts`. The API contracts (`POST /api/listings` '
    + 'returning `{...listingResponse}`) and existing zod schemas (`createListingRequest`) '
    + 'are authoritative — consume them as-is.'

describe('extractProhibitions', () => {
    test('extracts every backticked path from a prohibition line, skipping non-paths', () => {
        const p = extractProhibitions(`GOAL:\nx\n\nCONSTRAINTS:\n${MIXED_CONSTRAINT}`)
        expect(p.map(x => x.path)).toEqual([
            'src/server/routes/listings.ts',
            'src/server/routes/photos.ts',
            'src/server/auth.ts',
            'src/server/index.ts',
            'src/shared/schema.ts'
        ])
        // looksLikePath rejects all three: `POST /api/listings` has a space and
        // `{...listingResponse}` has braces, so both fail its character class, and
        // `createListingRequest` has no slash, no extension and no leading dot.
        expect(p[0].constraint).toContain('Do NOT modify')
    })
    test('matches the prohibition verb family and passive form', () => {
        const spec = [
            '- Do not touch `Makefile.am`.',
            "- Don't edit `config/settings.yml`.",
            '- `src/server/migrate.ts` must NOT be modified per constraint.',
            '- Never delete `.gitignore`.',
            '- You must not overwrite `docker-compose.dev.yml`.'
        ].join('\n')
        expect(extractProhibitions(spec).map(x => x.path)).toEqual([
            'Makefile.am',
            'config/settings.yml',
            'src/server/migrate.ts',
            '.gitignore',
            'docker-compose.dev.yml'
        ])
    })
    test('directories and dotfiles count as paths; bare identifiers do not', () => {
        const spec =
            '- Do NOT modify `src/server/` or `.prettierrc.cjs`; the `requireAuth` helper is authoritative.'
        expect(extractProhibitions(spec).map(x => x.path)).toEqual([
            'src/server/',
            '.prettierrc.cjs'
        ])
    })
    test('non-prohibition lines extract nothing, even with paths present', () => {
        const spec = [
            '- Update `src/client/api.ts` to add the new method.',
            '- The entry point is `src/server/index.ts`.',
            'VERIFY:\n```bash\nnpm test\n```'
        ].join('\n')
        expect(extractProhibitions(spec)).toEqual([])
    })
    test('prose-only prohibitions (no concrete path) extract nothing', () => {
        expect(extractProhibitions('- Do NOT modify any server-side code.')).toEqual([])
    })
    test('conditional prohibitions still extract, carrying their exception wording', () => {
        const spec =
            '- Do NOT modify `src/client/api.ts` beyond what is needed for the new listing create endpoint.'
        const p = extractProhibitions(spec)
        expect(p).toHaveLength(1)
        expect(p[0].constraint).toContain('beyond what is needed')
    })
})

describe('findProhibitionViolations', () => {
    const prohibitions = extractProhibitions(MIXED_CONSTRAINT)
    test('flags a changed file the spec forbids, carrying the constraint verbatim', () => {
        const findings = findProhibitionViolations(prohibitions, [
            {path: 'src/client/pages/NewListing.tsx', addedLines: 300},
            {path: 'src/server/index.ts', addedLines: 12}
        ])
        expect(findings).toHaveLength(1)
        expect(findings[0]).toContain('src/server/index.ts — modified by this task')
        expect(findings[0]).toContain('Do NOT modify')
    })
    test('directory prohibitions cover files beneath them', () => {
        const dir = extractProhibitions('- Do not touch `src/server/`.')
        expect(
            findProhibitionViolations(dir, [{path: 'src/server/routes/new.ts', addedLines: 5}])
        ).toHaveLength(1)
        expect(
            findProhibitionViolations(dir, [{path: 'src/serverless/x.ts', addedLines: 5}])
        ).toEqual([])
    })
    test('no overlap → no findings (honest-clean and violated-then-reverted trees)', () => {
        // findProhibitionViolations only sees the changed-file list, and a fully
        // reverted file is not in it — so reverted cannot read as violated.
        expect(
            findProhibitionViolations(prohibitions, [
                {path: 'src/client/pages/NewListing.tsx', addedLines: 300},
                {path: 'src/client/main.tsx', addedLines: 4}
            ])
        ).toEqual([])
        expect(findProhibitionViolations(prohibitions, [])).toEqual([])
        expect(
            findProhibitionViolations([], [{path: 'src/server/index.ts', addedLines: 1}])
        ).toEqual([])
    })
})
