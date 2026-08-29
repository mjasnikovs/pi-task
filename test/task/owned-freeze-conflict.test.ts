import {describe, expect, test} from 'bun:test'
import {
    findCategoryFreezes,
    findOwnedFreezeConflicts,
    ownedRequirementLines,
    trackedSourceOracle
} from '../../src/task/owned-freeze-conflict.js'

const OWNED_TAIL =
    '— owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)'
const SERVER_REQ = `  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] ${OWNED_TAIL}`
const CATEGORY_FREEZE =
    '  - Do not modify `docker-compose.dev.yml`, `.env.example`, `build.ts`, or any source files outside of `package.json`.'

const spec = (...lines: string[]): string =>
    [
        'GOAL',
        '  Add a `dev` script.',
        'CONSTRAINTS',
        ...lines,
        'ACCEPTANCE',
        '  - `package.json` gains a `dev` script.'
    ].join('\n')

/** Stands in for the git oracle: everything is a source file except the build
 *  output, which is what `git ls-files` reports on a real tree. */
const anySource = (p: string): boolean => !p.startsWith('dist')

describe('findCategoryFreezes', () => {
    test('reads the mx5 run-18 freeze and its single exemption', () => {
        const [f] = findCategoryFreezes(spec(CATEGORY_FREEZE))
        expect(f.exempt).toEqual(['package.json'])
    })

    test('the exemption stops at the clause break — a "must remain untouched" tail is not an exemption', () => {
        const [f] = findCategoryFreezes(
            spec(
                '  - Do NOT modify any existing source files other than `src/App.tsx` — all engine modules (`document.ts`, `palette.ts`) must remain untouched.'
            )
        )
        expect(f.exempt).toEqual(['src/App.tsx'])
    })

    test('a CREATION ban is not a modification category freeze', () => {
        expect(
            findCategoryFreezes(
                spec(
                    '  - Do not create any files other than `src/server/seed.ts` and do not modify `tsconfig.json`.'
                )
            )
        ).toEqual([])
    })

    test('a passive ACCEPTANCE restatement counts', () => {
        expect(
            findCategoryFreezes('ACCEPTANCE\n  - No files other than `package.json` are modified.')
        ).toHaveLength(1)
    })

    test('a scoped-ownership grant is never a freeze', () => {
        expect(
            findCategoryFreezes(
                spec(
                    '  - You MAY edit `src/server/index.ts` ONLY as far as the owned requirement requires; do not modify any other file outside `package.json`.'
                )
            )
        ).toEqual([])
    })
})

describe('ownedRequirementLines', () => {
    test('finds the machine-stamped line', () => {
        expect(ownedRequirementLines(spec(SERVER_REQ))).toHaveLength(1)
    })

    test('finds an unstamped quote when the run ledger is supplied', () => {
        const s = spec(
            '  - The server must satisfy "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`."'
        )
        expect(ownedRequirementLines(s)).toHaveLength(0)
        expect(
            ownedRequirementLines(s, [
                {
                    quote: '**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.',
                    anchor: '9. Build & run',
                    title: 'Wire dev build pipeline'
                }
            ])
        ).toHaveLength(1)
    })
})

describe('findOwnedFreezeConflicts', () => {
    test('the mx5 run-18 pair', () => {
        const [c] = findOwnedFreezeConflicts(spec(SERVER_REQ, CATEGORY_FREEZE), {
            isSource: anySource
        })
        expect(c.paths).toEqual(['src/server/index.ts'])
        expect(c.exempt).toEqual(['package.json'])
    })

    test('one finding per requirement, even when the freeze is restated', () => {
        const s = `${spec(SERVER_REQ, CATEGORY_FREEZE)}\n  - No files other than \`package.json\` are modified.`
        expect(findOwnedFreezeConflicts(s, {isSource: anySource})).toHaveLength(1)
    })

    test('silent once ownership is granted, even with the freeze still there', () => {
        const s = spec(
            SERVER_REQ,
            CATEGORY_FREEZE,
            '  - You MAY edit `src/server/index.ts` ONLY as far as the owned requirement requires.'
        )
        expect(findOwnedFreezeConflicts(s, {isSource: anySource})).toEqual([])
    })

    test('a path named only as a command argument, with no claim about it, does not fire', () => {
        const s = spec(
            `  - "**Client CSS:** \`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css\`" [9. Build & run] ${OWNED_TAIL}`,
            CATEGORY_FREEZE
        )
        expect(findOwnedFreezeConflicts(s, {isSource: anySource})).toEqual([])
    })

    test('a prohibition-shaped owned requirement is the freeze side, never the statement side', () => {
        const s = spec(
            `  - "Never edit \`src/server/index.ts\` by hand — it is generated." [3. Repo layout] ${OWNED_TAIL}`,
            CATEGORY_FREEZE
        )
        expect(findOwnedFreezeConflicts(s, {isSource: anySource})).toEqual([])
    })

    test('the same file spelled shorter is still the exempted file', () => {
        const s = spec(
            `  - "\`Canvas.tsx\` — HTML5 Canvas element with mouse event handlers" [13. Plan] ${OWNED_TAIL}`,
            '  - Do NOT modify any existing file outside `src/components/Canvas.tsx`.'
        )
        expect(findOwnedFreezeConflicts(s, {isSource: anySource})).toEqual([])
    })

    test('no category freeze and no owned requirement are both no-ops', () => {
        expect(findOwnedFreezeConflicts(spec(SERVER_REQ), {isSource: anySource})).toEqual([])
        expect(findOwnedFreezeConflicts(spec(CATEGORY_FREEZE), {isSource: anySource})).toEqual([])
        expect(findOwnedFreezeConflicts(null)).toEqual([])
    })

    test('the source oracle drops build outputs and keeps tracked files', () => {
        const isSource = trackedSourceOracle(p => ({
            stdout: p === 'src/server/index.ts' ? `${p}\n` : '',
            exitCode: 0
        }))
        const [c] = findOwnedFreezeConflicts(spec(SERVER_REQ, CATEGORY_FREEZE), {isSource})
        expect(c.paths).toEqual(['src/server/index.ts'])
    })

    test('a broken git falls back to the broad reading rather than going blind', () => {
        const isSource = trackedSourceOracle(() => ({stdout: '', exitCode: 127}))
        expect(isSource('anything')).toBe(true)
    })
})
