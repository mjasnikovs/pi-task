/**
 * The WIRED path (nexttask 2): `resolveOwnedFreezeForThisTask` as `phases.ts`
 * calls it at critique, over a real `.pi-tasks` directory — the owned ledger on
 * disk and the spec the braces just produced.
 *
 * The fixture is mx5 run 19's TASK_0015: the §9 Build & run server clause owned
 * by the build-tooling task, whose own CONSTRAINTS freeze every file but
 * `package.json`. What the wired half must show is that the quote survives the
 * detach byte for byte, that it stops being this task's obligation, and that a
 * run without a ledger or without the pair is untouched.
 */
import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    claimOwnedFreezeForThisTask,
    critiquePhase,
    resolveOwnedFreezeForThisTask
} from './phases.js'
import {
    appendOwnedConstraints,
    ownedForTitle,
    readOwnedRequirements,
    readRequirements
} from './requirements.js'
import type {PhaseDeps} from './child-runner.js'
import type {PhaseContext} from './phases.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'

const QUOTE = '**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`.'
const BUILD_TOOLING = 'Build tooling — build.ts, dev/build scripts in package.json'
const CLIENT_API = 'Client API layer — typed hono/client, SPA fallback route on server'
const SERVER_WIRING = 'Hono RPC app wiring — chain all route groups on a single app'
const SHELL = 'Client shell — React root, wouter router, Tailwind theme tokens'

const dirs: string[] = []
afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true})
})

interface FixtureOpts {
    /** Checkbox state of the four plan entries, in order. */
    done?: boolean[]
    ledgerTitle?: string
}

function fixture(opts: FixtureOpts = {}): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-freeze-wiring-'))
    dirs.push(cwd)
    const tasks = path.join(cwd, '.pi-tasks')
    fs.mkdirSync(tasks, {recursive: true})
    // A real tree, so the git source oracle answers as it does in production.
    fs.mkdirSync(path.join(cwd, 'src', 'server'), {recursive: true})
    fs.writeFileSync(path.join(cwd, 'src', 'server', 'index.ts'), 'export const app = {}\n')
    fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"fixture"}\n')
    for (const args of [
        ['init', '-q'],
        ['add', '-A', '--', 'src', 'package.json']
    ]) {
        Bun.spawnSync(['git', ...args], {cwd})
    }

    const done = opts.done ?? [true, false, false, false]
    const titles = [
        {title: SERVER_WIRING, id: 'TASK_0014'},
        {title: BUILD_TOOLING, id: 'TASK_0015'},
        {title: SHELL, id: 'TASK_0016'},
        {title: CLIENT_API, id: 'TASK_0017'}
    ]
    // TASK_0014's title states it CREATES the server file; TASK_0017's states it
    // ADDS a route to it; TASK_0016 only imports from it.
    const intents = [
        `${SERVER_WIRING} — create \`src/server/index.ts\` mounting all five route groups`,
        BUILD_TOOLING,
        `${SHELL} — the root imports types from \`src/server/index.ts\``,
        `${CLIENT_API} — add an SPA fallback route to the existing server \`src/server/index.ts\``
    ]
    const list = titles
        .map((t, i) => `- [${done[i] ? 'x' : ' '}] ${t.id}  ${intents[i]}`)
        .join('\n')
    fs.writeFileSync(
        path.join(tasks, 'TASK_AUTO_0001.md'),
        [
            '---',
            'id: TASK_AUTO_0001',
            'state: in_progress',
            'phase: none',
            'created_at: 2026-08-04T11:36:50.000Z',
            'updated_at: 2026-08-04T14:28:07.000Z',
            'title: mx5',
            '---',
            '',
            '## tasks',
            '',
            list,
            ''
        ].join('\n')
    )
    fs.writeFileSync(
        path.join(tasks, 'TASK_0015.md'),
        [
            '---',
            'id: TASK_0015',
            'state: in_progress',
            'phase: critique',
            'created_at: 2026-08-04T14:28:07.543Z',
            'updated_at: 2026-08-04T14:28:07.543Z',
            'title: Build tooling',
            '---',
            '',
            '## raw prompt',
            '',
            BUILD_TOOLING,
            ''
        ].join('\n')
    )
    fs.writeFileSync(
        path.join(tasks, 'requirements-owned.md'),
        `OWNED: "${QUOTE}" [anchor: 9. Build & run] [title: ${opts.ledgerTitle ?? BUILD_TOOLING}]\n`
    )
    return cwd
}

const deps = (cwd: string): PhaseDeps => ({
    cwd,
    taskId: 'TASK_0015',
    signal: new AbortController().signal
})

const SPEC = (): string =>
    appendOwnedConstraints(
        [
            'GOAL',
            '  Build tooling.',
            'CONSTRAINTS',
            '  - Do not touch `tsconfig.json`, `eslint.config.js`, or any configuration file outside of `package.json`.',
            'ACCEPTANCE',
            '  - `package.json` gains a `dev` script.'
        ].join('\n'),
        [{quote: QUOTE, anchor: '9. Build & run', title: BUILD_TOOLING}]
    )

describe('resolveOwnedFreezeForThisTask (wired, DETACH)', () => {
    test('detaches the unsatisfiable clause and persists it as pending', async () => {
        const cwd = fixture()
        const spec = SPEC()
        expect(spec).toContain('serves `/api` + static `dist/`')

        const out = await resolveOwnedFreezeForThisTask(deps(cwd), spec)
        expect(out).not.toContain('serves `/api` + static `dist/`')

        const ledger = await readOwnedRequirements(cwd)
        expect(ledger).toHaveLength(1)
        expect(ledger[0].quote).toBe(QUOTE)
        expect(ledger[0].anchor).toBe('9. Build & run')
        expect(ledger[0].pending).toEqual(['src/server/index.ts'])
        // Detached ⇒ owned by nobody, including the task it came from.
        expect(ownedForTitle(ledger, BUILD_TOOLING)).toEqual([])
    })

    test('no ledger at all is a no-op', async () => {
        const cwd = fixture()
        fs.rmSync(path.join(cwd, '.pi-tasks', 'requirements-owned.md'))
        const spec = SPEC()
        expect(await resolveOwnedFreezeForThisTask(deps(cwd), spec)).toBe(spec)
    })

    test('a spec with no category freeze is untouched', async () => {
        const cwd = fixture()
        const spec = appendOwnedConstraints(
            [
                'GOAL',
                '  Build tooling.',
                'CONSTRAINTS',
                '  - Preserve every existing script.',
                'ACCEPTANCE',
                '  - ok'
            ].join('\n'),
            [{quote: QUOTE, anchor: '9. Build & run', title: BUILD_TOOLING}]
        )
        expect(await resolveOwnedFreezeForThisTask(deps(cwd), spec)).toBe(spec)
        const ledger = await readOwnedRequirements(cwd)
        expect(ledger[0].pending).toBeUndefined()
        expect(ledger[0].title).toBe(BUILD_TOOLING)
    })

    test('a ledger owned by another task is left alone', async () => {
        const cwd = fixture({ledgerTitle: CLIENT_API})
        const spec = SPEC()
        expect(await resolveOwnedFreezeForThisTask(deps(cwd), spec)).toBe(spec)
        expect((await readOwnedRequirements(cwd))[0].pending).toBeUndefined()
    })

    test('the carried artifact is not written — nothing is demoted cross-cutting', async () => {
        const cwd = fixture()
        await resolveOwnedFreezeForThisTask(deps(cwd), SPEC())
        expect(await readRequirements(cwd)).toBe('')
    })
})

/** mx5 run 19's TASK_0017 refined prompt, reduced to the sentence that claims. */
const CLAIMANT_REFINED =
    'Create `src/client/api.ts` with a typed Hono RPC client, and add an SPA fallback route to the'
    + ' existing server `src/server/index.ts` so that non-`/api` GET requests serve the built'
    + ' `dist/index.html`.'

/** The claiming task, as the fixture's `.pi-tasks` sees it. */
function claimantFixture(pending: string): string {
    const cwd = fixture()
    fs.writeFileSync(
        path.join(cwd, '.pi-tasks', 'TASK_0017.md'),
        [
            '---',
            'id: TASK_0017',
            'state: in_progress',
            'phase: compose',
            'created_at: 2026-08-04T14:48:57.076Z',
            'updated_at: 2026-08-04T14:48:57.076Z',
            'title: Client API layer',
            '---',
            '',
            '## raw prompt',
            '',
            CLIENT_API,
            ''
        ].join('\n')
    )
    fs.writeFileSync(
        path.join(cwd, '.pi-tasks', 'requirements-owned.md'),
        `OWNED: "${QUOTE}" [anchor: 9. Build & run] [pending: ${pending}] [title: ${BUILD_TOOLING}]\n`
    )
    return cwd
}

const claimantDeps = (cwd: string): PhaseDeps => ({
    cwd,
    taskId: 'TASK_0017',
    signal: new AbortController().signal
})

describe('claimOwnedFreezeForThisTask (wired, CLAIM)', () => {
    test('the task that writes the frozen path takes the detached obligation', async () => {
        const cwd = claimantFixture('src/server/index.ts')
        await claimOwnedFreezeForThisTask(claimantDeps(cwd), CLAIMANT_REFINED)
        const ledger = await readOwnedRequirements(cwd)
        expect(ledger[0].pending).toBeUndefined()
        expect(ledger[0].title).toBe(CLIENT_API)
        expect(ledger[0].quote).toBe(QUOTE)
        // …and it now rides the belt into this task's own compose.
        expect(ownedForTitle(ledger, CLIENT_API).map(o => o.quote)).toEqual([QUOTE])
    })

    test('a task that does not write the path leaves it pending', async () => {
        const cwd = claimantFixture('src/server/index.ts')
        await claimOwnedFreezeForThisTask(
            claimantDeps(cwd),
            'Create `src/client/main.tsx`. It imports `AppType` from `src/server/index.ts`.'
        )
        const ledger = await readOwnedRequirements(cwd)
        expect(ledger[0].pending).toEqual(['src/server/index.ts'])
        expect(ledger[0].title).toBe(BUILD_TOOLING)
    })

    test('nothing pending is a no-op on the ledger file', async () => {
        const cwd = fixture()
        const before = fs.readFileSync(path.join(cwd, '.pi-tasks', 'requirements-owned.md'), 'utf8')
        await claimOwnedFreezeForThisTask(claimantDeps(cwd), CLAIMANT_REFINED)
        expect(fs.readFileSync(path.join(cwd, '.pi-tasks', 'requirements-owned.md'), 'utf8')).toBe(
            before
        )
    })
})

// ─── The ORDER, driven rather than retyped ───────────────────────────────────
//
// The two halves above are covered separately, and the order they run in was
// asserted by a test that CALLED them in sequence — which proves the sequence the
// test wrote, not the sequence the phase runs. `critiquePhase` is that row's whole
// body now, so the order is drivable: the braces write the stamp, the detach reads
// it, and a critique-time probe once measured 0/40 because that stamp did not exist
// yet. Reversing the two inside `critiquePhase` fails this test.

/** A compose draft with a runnable VERIFY, so triage may short-circuit the rewrite. */
const DRAFT = [
    'GOAL',
    '  Build tooling.',
    'CONSTRAINTS',
    '  - Do not touch `tsconfig.json`, `eslint.config.js`, or any configuration file outside of `package.json`.',
    'ACCEPTANCE',
    '  - `package.json` gains a `dev` script.',
    'VERIFY:',
    '```sh',
    'bun run dev',
    '```'
].join('\n')

describe('critiquePhase (the row) — braces then detach, in that order', () => {
    const phaseContext = (cwd: string, ctx: PhaseContext['ctx']): PhaseContext => ({
        cwd,
        id: 'TASK_0015',
        ctx,
        widgetState: {
            taskId: 'TASK_0015',
            phase: 'critique',
            label: ''
        } as PhaseContext['widgetState'],
        rawPrompt: BUILD_TOOLING,
        refined: BUILD_TOOLING,
        research: '',
        qa: '',
        spec: DRAFT
    })

    test('the row appends the owned quote AND detaches it, with no hand-written sequence', async () => {
        const cwd = fixture()
        const {ctx} = makeFakeCtx(cwd)
        const d: PhaseDeps = {
            ...deps(cwd),
            // Critique's own children are a premise here: triage says CLEAN, and the
            // draft carries a runnable VERIFY, so phaseCritique returns the draft.
            runChild: (name, _tools, _prompt) =>
                Promise.resolve(name === 'critique-triage' ? 'CLEAN' : DRAFT)
        }

        const out = await critiquePhase(d, phaseContext(cwd, ctx))

        // BRACES ran: the quote was appended to a draft that did not carry it…
        expect(DRAFT).not.toContain('serves `/api` + static `dist/`')
        // …and DETACH ran after it: the appended clause is gone again, because this
        // task freezes the only file that could satisfy it.
        expect(out).not.toContain('serves `/api` + static `dist/`')

        // The stamp the detach read is the one the append wrote — the ledger now
        // carries the obligation as pending on the frozen path, owned by nobody.
        const ledger = await readOwnedRequirements(cwd)
        expect(ledger).toHaveLength(1)
        expect(ledger[0].quote).toBe(QUOTE)
        expect(ledger[0].pending).toEqual(['src/server/index.ts'])
        expect(ownedForTitle(ledger, BUILD_TOOLING)).toEqual([])
    })

    test('nothing owned by this task ⇒ the row returns the critique output untouched', async () => {
        const cwd = fixture({ledgerTitle: CLIENT_API})
        const {ctx} = makeFakeCtx(cwd)
        const d: PhaseDeps = {
            ...deps(cwd),
            runChild: name => Promise.resolve(name === 'critique-triage' ? 'CLEAN' : DRAFT)
        }
        expect(await critiquePhase(d, phaseContext(cwd, ctx))).toBe(DRAFT)
        expect((await readOwnedRequirements(cwd))[0].pending).toBeUndefined()
    })
})
