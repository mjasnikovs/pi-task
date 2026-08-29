import {describe, expect, test} from 'bun:test'
import {findFrozenPathConflicts, frozenConflictProbeText} from '../../src/task/frozen-conflict.js'

/** The real mx5 run-12 TASK_0020 pair, verbatim shape (freeze + prose surrender). */
const MX5_SPEC = [
    'GOAL',
    'Create the Playwright component-testing scaffold: `playwright-ct.config.ts` at project',
    'root plus `playwright/index.html` and `playwright/index.ts`.',
    '',
    'CONSTRAINTS',
    '  - Do not modify `tsconfig.json`, `eslint.config.js`, or `.prettierrc.cjs`; those are handled in steps 1–2.',
    '  - Accept that `playwright-ct.config.ts` will not be covered by `tsc --noEmit` since `tsconfig.json` is not modified in this step; no error should be raised about this.',
    '',
    'ACCEPTANCE',
    '  - `playwright-ct.config.ts` exists at project root.',
    '',
    'VERIFY:',
    '```bash',
    'test -f playwright-ct.config.ts',
    '```'
].join('\n')

describe('findFrozenPathConflicts', () => {
    test('fires on the real mx5 pair: blanket freeze + prose surrender naming the same path', () => {
        const conflicts = findFrozenPathConflicts(MX5_SPEC)
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].path).toBe('tsconfig.json')
        expect(conflicts[0].constraint).toContain('Do not modify `tsconfig.json`')
        expect(conflicts[0].statement).toContain('will not be covered')
    })

    test('fires on the passive registration family ("must also be included")', () => {
        const spec = [
            'CONSTRAINTS',
            '  - Do not modify `tsconfig.json`; it is handled in step 1.',
            '  - The new `playwright-ct.config.ts` must also be included in the `tsconfig.json` include array for type-checking compatibility.'
        ].join('\n')
        const conflicts = findFrozenPathConflicts(spec)
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].statement).toContain('must also be included')
    })

    test('fires on the unless-added family ("won\'t be type-checked unless added")', () => {
        const spec = [
            '  - Do not modify `tsconfig.json`; owned by step 1.',
            "  - The new config file won't be type-checked unless added to the `tsconfig.json` include list."
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toHaveLength(1)
    })

    test('fires on the directional active family ("requires adding … to")', () => {
        const spec = [
            '  - Never edit `tsconfig.json`.',
            '  - Type coverage of the new file requires adding it to the include array of `tsconfig.json`.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toHaveLength(1)
    })

    test('mere co-mention never fires (path named without a requires-edit statement)', () => {
        const spec = [
            '  - Do not modify `tsconfig.json`; it is handled in steps 1–2.',
            '  - The project compiles with the settings in `tsconfig.json`.',
            '  - `tsconfig.json` remains unmodified.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toEqual([])
    })

    test('a SCOPED freeze (exception clause) is the resolution shape and never fires', () => {
        for (const freeze of [
            '  - You MAY edit `tsconfig.json` ONLY to register the files this task creates; do not modify it otherwise.',
            '  - Do not modify `tsconfig.json` except to add the new files to the include array.',
            '  - Only edit `tsconfig.json` (add the new include entries); do not touch anything else.'
        ]) {
            const spec = [
                freeze,
                '  - The new `playwright-ct.config.ts` must also be included in `tsconfig.json`.'
            ].join('\n')
            expect(findFrozenPathConflicts(spec)).toEqual([])
        }
    })

    test('a requires-edit statement about a DIFFERENT path never fires', () => {
        const spec = [
            '  - Do not modify `eslint.config.js`; owned by step 2.',
            '  - The new file must also be included in the `tsconfig.json` include array.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toEqual([])
    })

    test('sentence scoping: a giant one-line GOAL with "must include" (response shape) three paths from the frozen one never fires', () => {
        // The real mx5 TASK_0012 false-positive shape: one enormous GOAL line where
        // "must include `field`" (a response contract) coexists with frozen paths in
        // OTHER sentences of the same line.
        const spec = [
            '  - Do NOT modify `src/server/index.ts` — the listings route module is already wired.',
            'The module must expose six Hono endpoints mounted under `/api/listings` (as already wired in `src/server/index.ts`). The `GET /api/listings/:id` response must include `seller_display_name` and `photo_ids` per `listingDetailResponseSchema`. All mutations must set `updated_at = now()`.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toEqual([])
    })

    test('a prohibition-shaped sentence ("Preserve … do not remove or modify …") is never the statement side', () => {
        const spec = [
            '  - Do NOT modify `src/server/index.ts`.',
            '  - Preserve all existing routes in `src/server/index.ts` — routes must be added elsewhere; do not remove or modify `POST /` or `GET /:id`.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toEqual([])
    })

    test('null/empty specs and freeze-less specs yield nothing', () => {
        expect(findFrozenPathConflicts(null)).toEqual([])
        expect(findFrozenPathConflicts(undefined)).toEqual([])
        expect(findFrozenPathConflicts('')).toEqual([])
        expect(
            findFrozenPathConflicts('The new file must also be included in `tsconfig.json`.')
        ).toEqual([])
    })

    test('deduplicates: the same path+statement pair reported once', () => {
        const spec = [
            '  - Do not modify `tsconfig.json`.',
            '  - Never touch `tsconfig.json`.',
            '  - The new file must also be included in `tsconfig.json`.'
        ].join('\n')
        expect(findFrozenPathConflicts(spec)).toHaveLength(1)
    })
})

describe('frozenConflictProbeText', () => {
    test('is MANDATORY-framed and names both resolutions with the conflict quoted', () => {
        const text = frozenConflictProbeText(findFrozenPathConflicts(MX5_SPEC))
        expect(text).toContain('UNSATISFIABLE-CONSTRAINT FINDING')
        expect(text).toContain('overrides a CLEAN triage')
        expect(text).toContain('`tsconfig.json`')
        expect(text).toContain('SCOPED OWNERSHIP')
        expect(text).toContain('DROP the creation')
        // The live failure mode — prose surrender — must be named a non-resolution.
        expect(text).toContain('NOT a resolution')
    })
})

describe('findFrozenPathConflicts — research statement side', () => {
    const SPEC_NO_STATEMENT = [
        'GOAL',
        'Create `playwright-ct.config.ts` at project root plus `playwright/index.ts`.',
        '',
        'CONSTRAINTS',
        '  - Do not modify `tsconfig.json`, `eslint.config.js`, or `.prettierrc.cjs`; those are handled in steps 1–2.',
        '',
        'VERIFY:',
        '```bash',
        'bunx eslint .',
        '```'
    ].join('\n')
    const RESEARCH = [
        'FILES',
        'tsconfig.json:18  Existing tsconfig include list already references `playwright.config.ts` — new `playwright-ct.config.ts` must also be included in `tsconfig.json` for type-checking compatibility'
    ].join('\n')

    test('a research requires-edit statement pairs with a spec freeze (live drafts drop the nuance)', () => {
        expect(findFrozenPathConflicts(SPEC_NO_STATEMENT)).toEqual([])
        const conflicts = findFrozenPathConflicts(SPEC_NO_STATEMENT, RESEARCH)
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].source).toBe('research')
        expect(conflicts[0].path).toBe('tsconfig.json')
    })

    test('anchor rule: dropping the creation from the spec silences the research statement (resolution b is terminal)', () => {
        const droppedSpec = SPEC_NO_STATEMENT.replace(
            'Create `playwright-ct.config.ts` at project root plus `playwright/index.ts`.',
            'Create the `__screenshots__/` baseline directory only; the CT config is deferred.'
        )
        expect(findFrozenPathConflicts(droppedSpec, RESEARCH)).toEqual([])
    })

    test('anchor rule: a research statement naming ONLY the frozen path never counts', () => {
        const research =
            'CONTEXT\n- The `tsconfig.json` include array must be updated in `tsconfig.json` eventually.'
        expect(findFrozenPathConflicts(SPEC_NO_STATEMENT, research)).toEqual([])
    })

    test('scoped ownership in the spec silences research statements too', () => {
        const scoped = SPEC_NO_STATEMENT.replace(
            '  - Do not modify `tsconfig.json`, `eslint.config.js`, or `.prettierrc.cjs`; those are handled in steps 1–2.',
            '  - You MAY edit `tsconfig.json` ONLY to register the files this task creates; do not modify it otherwise.'
        )
        expect(findFrozenPathConflicts(scoped, RESEARCH)).toEqual([])
    })

    test('spec-sourced statements need no anchor and report source spec', () => {
        const spec = SPEC_NO_STATEMENT.replace(
            'CONSTRAINTS',
            'CONSTRAINTS\n  - Accept that `playwright-ct.config.ts` will not be covered by `tsc --noEmit` since `tsconfig.json` is not modified in this step.'
        )
        const conflicts = findFrozenPathConflicts(spec, RESEARCH)
        expect(conflicts.some(c => c.source === 'spec')).toBe(true)
    })
})
