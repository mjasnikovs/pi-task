/**
 * Unit tests for the STEP 0 rig behind the REFUTED "propagate INVARIANT owned
 * requirements to consumer tasks" lever (see the header of
 * owned-consumer-generality-step0.ts and the record at the wiring site in
 * src/task/requirements.ts — the lever was NOT built).
 *
 * Kept because the two measurements are the durable asset: the prohibition
 * classifier is the codebase's own un-ownable-requirement rule, and the symbol
 * extractor is the published definition of "a consumer task touches the owner's
 * thing" — the rule the lever would have targeted with. The cases below are the
 * real shapes found on mx5 and IAR1 on 2026-07-27.
 */
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'

import {afterEach, describe, expect, test} from 'bun:test'

import {
    extractSymbols,
    isProhibition,
    measureTouch,
    ownerOf,
    parseAutoTaskList,
    planTitlesById,
    readTaskSpecs,
    specSection,
    STRICT4_RE
} from './owned-consumer-generality-step0.js'

const dirs: string[] = []
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true})
})

function project(files: Record<string, string>): string {
    const root = mkdtempSync(path.join(tmpdir(), 'owned-consumer-'))
    dirs.push(root)
    for (const [rel, body] of Object.entries(files)) {
        const full = path.join(root, rel)
        mkdirSync(path.dirname(full), {recursive: true})
        writeFileSync(full, body)
    }
    return root
}

describe('prohibition classifier (M1)', () => {
    test('the real mx5 owned prohibitions classify as prohibitions', () => {
        expect(
            isProhibition(
                'The client never hand-writes request/response interfaces or duplicates route shapes'
            )
        ).toBe(true)
        expect(
            isProhibition(
                "If a call isn't fully typed end-to-end via `hc`, fix the route chaining/export,"
                    + " don't paper over it with a manual type or `any`."
            )
        ).toBe(true)
        expect(isProhibition('`updated_at` is set by the app on every UPDATE (no trigger).')).toBe(
            true
        )
    })

    test('plain deliverables do not', () => {
        expect(isProhibition('All `uuid pk` columns default to `gen_random_uuid()`.')).toBe(false)
        expect(isProhibition('Runtime:** Bun `1.3.14`')).toBe(false)
    })

    test('the narrow four-phrase variant is strictly narrower', () => {
        // The measured gap between the two readings on mx5 (21.2% vs 6.1%): the
        // broad rule fires on a bare "no"/"not", the narrow one does not.
        expect(isProhibition('`updated_at` is set by the app on every UPDATE (no trigger).')).toBe(
            true
        )
        expect(STRICT4_RE.test('`updated_at` is set by the app on every UPDATE (no trigger).')).toBe(
            false
        )
        expect(STRICT4_RE.test('The client never hand-writes request/response interfaces')).toBe(
            true
        )
    })
})

describe('symbol extraction (M2 targeting rule)', () => {
    test('backticked code spans, paths and identifiers are symbols', () => {
        const s = extractSymbols(
            'All routes are chained on a single `app` and export `AppType` for the typed client'
        )
        expect(s).toContain('apptype')
        // <4 chars: `app` cannot discriminate and is dropped on purpose.
        expect(s).not.toContain('app')
        expect(extractSymbols('port `src/client/index.css` into the theme')).toContain(
            'src/client/index.css'
        )
        expect(extractSymbols('set `updated_at` on every UPDATE')).toContain('updated_at')
    })

    test('prose words are never symbols', () => {
        expect(extractSymbols('Moderator only. Everyone (incl. admin) invites equally.')).toEqual([])
        expect(extractSymbols('Contact seller')).toEqual([])
    })

    test('THE REFUTATION CASE: run 17s violated clause names no matchable symbol', () => {
        // Its only extractable token is `chaining/export`, which appears in no
        // consumer spec — so the prescribed symbol targeting would NOT have
        // reached TASK_0027/0031/0033/0034, the four tasks that broke it.
        expect(
            extractSymbols(
                "If a call isn't fully typed end-to-end via `hc`, fix the route chaining/export,"
                    + " don't paper over it with a manual type or `any`."
            )
        ).toEqual(['chaining/export'])
    })
})

describe('artifact parsing', () => {
    test('parseAutoTaskList reads the checklist with and without ids', () => {
        const entries = parseAutoTaskList(
            '## tasks\n\n- [x] TASK_0021  Hono RPC type infrastructure | spec: @D.md\n'
                + '- [ ] Later unstarted title\n\n## gates\n- [x] TASK_9999 not a task line\n'
        )
        expect(entries).toEqual([
            {id: 'TASK_0021', title: 'Hono RPC type infrastructure | spec: @D.md'},
            {id: '', title: 'Later unstarted title'}
        ])
    })

    test('specSection takes the composed spec, not the frontmatter title', () => {
        expect(specSection('---\ntitle: refined prompt text\n---\n\n## spec\n\nGOAL\n  x\n\n## end'))
            .toBe('GOAL\n  x')
    })

    test('planTitlesById keys tasks by their PLAN title, not the refined prompt', () => {
        const root = project({
            '.pi-tasks/TASK_AUTO_0001.md': '## tasks\n- [x] TASK_0001  Plan title here\n',
            '.pi-tasks/TASK_0001.md': '---\ntitle: a long refined prompt\n---\n\n## spec\nGOAL\n'
        })
        expect(planTitlesById(root).get('TASK_0001')).toBe('Plan title here')
        expect(readTaskSpecs(root)[0].title).toBe('Plan title here')
    })
})

describe('owner matching and touch measurement', () => {
    const root = (): string =>
        project({
            '.pi-tasks/TASK_AUTO_0001.md':
                '## tasks\n- [x] TASK_0001  Typed client — AppType export | spec: @D.md\n'
                + '- [x] TASK_0002  Listing page | spec: @D.md\n'
                + '- [x] TASK_0003  Styling | spec: @D.md\n',
            '.pi-tasks/TASK_0001.md': '---\nid: TASK_0001\n---\n\n## spec\nGOAL\n  export AppType\n',
            '.pi-tasks/TASK_0002.md': '---\nid: TASK_0002\n---\n\n## spec\nGOAL\n  use AppType\n',
            '.pi-tasks/TASK_0003.md': '---\nid: TASK_0003\n---\n\n## spec\nGOAL\n  colors only\n'
        })

    test('the owner is matched on the plan title, consumers exclude it', () => {
        const tasks = readTaskSpecs(root())
        const owned = {
            quote: 'export `AppType` for the typed client',
            anchor: '5. API',
            title: 'Typed client — AppType export | spec: @D.md'
        }
        expect(ownerOf(owned, tasks)?.id).toBe('TASK_0001')
        const [row] = measureTouch([owned], tasks)
        expect(row.ownerId).toBe('TASK_0001')
        expect(row.consumers).toEqual(['TASK_0002'])
    })

    test('a requirement naming nothing matchable has no consumers', () => {
        const tasks = readTaskSpecs(root())
        const [row] = measureTouch(
            [{quote: 'Contact seller', anchor: '', title: 'Listing page | spec: @D.md'}],
            tasks
        )
        expect(row.consumers).toEqual([])
    })
})
