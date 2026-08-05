import {describe, expect, test} from 'bun:test'
import {
    extractToolingCommands,
    replaceToolingWithVerified,
    scopedToolingGoal,
    phaseResearch,
    phaseAutoAnswer,
    phaseGrill,
    phaseCompose,
    phaseCritique,
    critiqueWithFallback,
    postCommitPhase,
    refineExistingFilesBlock,
    searchConfigured,
    emptySectionBody,
    isBareNoneAnswer,
    PHASES,
    type PhaseConfig,
    type PhaseContext
} from './phases.js'
import {spawnSync} from 'node:child_process'
import * as nodeFs from 'node:fs'
import * as nodePath from 'node:path'
import {readSection, readTaskFile} from './task-io.js'
import {agentErrorResponse} from '../test-utils/fake-spawn.js'
import {parseVerifyToolingOutput} from './parsers.js'
import {
    agentEndResponse,
    fakeSpawnByPrompt,
    fakeSpawnQueue,
    loopResponse,
    makeProc,
    type SpawnResponseJsonEvents
} from '../test-utils/fake-spawn.js'
import {RESEARCH_CONTEXT_PROMPT} from './prompts.js'
import {PROJECT_DOCS_BUDGET_ENV, projectDocsBudgetNotice} from './research-fanout-budget.js'
import type {SpawnFn} from '../shared/child-process.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {getConfig} from '../config/config.js'
import {writeTaskFile} from './task-io.js'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {WidgetState} from './widget.js'
import {getBridge, answerPrompt} from '../remote/bridge.js'
import {getState, _setSink, reset} from '../remote/session-state.js'

/**
 * A worker response carrying one retrieval call, so the APIS zero-retrieval gate in
 * phaseResearch treats the section as grounded and does not retry it. Tests that count worker
 * spawns/prompts and are NOT exercising the gate use this for the APIS worker — a healthy APIS
 * worker retrieves, so this is the realistic model, not a workaround.
 */
const groundedResponse = (text: string): SpawnResponseJsonEvents => ({
    events: [
        {type: 'tool_execution_start', toolName: 'pi-worker-docs', args: {}},
        {type: 'agent_end', messages: [{role: 'assistant', content: [{type: 'text', text}]}]}
    ],
    exitCode: 0
})
const isApisPrompt = (args: ReadonlyArray<string>): boolean =>
    (args[args.length - 1] ?? '').includes('content of an APIS section')

describe('refineExistingFilesBlock', () => {
    const deps = (cwd: string) => ({cwd, taskId: 'TASK_0001', signal: new AbortController().signal})

    test('returns the preserve directive + manifest/config content for an existing scaffold', async () => {
        if (spawnSync('which', ['git']).status !== 0) return
        await withTmpTaskDir(async cwd => {
            spawnSync('git', ['init', '-q'], {cwd})
            spawnSync('git', ['config', 'user.email', 't@t'], {cwd})
            spawnSync('git', ['config', 'user.name', 't'], {cwd})
            nodeFs.writeFileSync(
                nodePath.join(cwd, 'package.json'),
                JSON.stringify({
                    name: 'x',
                    dependencies: {hono: '^4'},
                    devDependencies: {eslint: '^9'}
                })
            )
            nodeFs.writeFileSync(
                nodePath.join(cwd, 'tsconfig.json'),
                '{"compilerOptions":{"jsx":"react-jsx"}}'
            )
            nodeFs.writeFileSync(nodePath.join(cwd, 'src.ts'), 'export const x = 1') // not config — excluded
            spawnSync('git', ['add', '.'], {cwd})
            spawnSync('git', ['commit', '-q', '-m', 'init'], {cwd})

            const block = await refineExistingFilesBlock(deps(cwd))
            // The authoritative reframe travels with the content.
            expect(block).toContain('EXISTING FILES ON DISK — AUTHORITATIVE')
            expect(block).toMatch(/in-place UPDATE/)
            // Manifest + config (tiers 0–1) content is supplied, with the existing deps.
            expect(block).toContain('package.json')
            expect(block).toContain('hono')
            expect(block).toContain('eslint')
            expect(block).toContain('tsconfig.json')
            // A non-config source file is NOT pulled into the refine grounding.
            expect(block).not.toContain('src.ts')
        })
    })

    test('returns empty string for a non-git / empty project so refine is unchanged', async () => {
        await withTmpTaskDir(async cwd => {
            expect(await refineExistingFilesBlock(deps(cwd))).toBe('')
        })
    })
})

describe('scopedToolingGoal', () => {
    // Shape of the failing TASK_0017 refined prompt: a GOAL block whose tail is a
    // long per-file edit checklist, then CONSTRAINTS. The checklist is what made
    // the TOOLING worker spelunk source and loop.
    const bulletHeavy = [
        'GOAL',
        'Fix every lint violation. The work is done when `bun run lint` passes and',
        '`AGENT=1 bun test` tests pass. Specifically, fix violations in these files:',
        '- src/server/lib/sql-adapter.ts — replace the casts',
        '- src/server/routes/auth.ts — convert .parse() to .safeParse()',
        '',
        'CONSTRAINTS',
        '- Never use `as unknown as`.'
    ].join('\n')

    test('strips the per-file bullet checklist, keeping only the goal prose', () => {
        const out = scopedToolingGoal(bulletHeavy)
        expect(out).toContain('bun run lint')
        expect(out).toContain('AGENT=1 bun test')
        expect(out).not.toContain('sql-adapter.ts')
        expect(out).not.toContain('auth.ts')
        expect(out).not.toContain('CONSTRAINTS')
    })

    test('a GOAL block with no bullets is returned whole (up to the next header)', () => {
        const refined = 'GOAL\nRun `bun run lint` and fix all warnings.\n\nACCEPTANCE\n- lint clean'
        expect(scopedToolingGoal(refined)).toBe('Run `bun run lint` and fix all warnings.')
    })

    test('falls back to the full refined when there is no bare GOAL header', () => {
        const refined = '**GOAL** Fix invalid SQL queries to comply with Bun docs.'
        expect(scopedToolingGoal(refined)).toBe(refined)
    })
})

describe('extractToolingCommands', () => {
    test('parses single-column entry', () => {
        const research = 'FILES\n…\n\nTOOLING\nbun test\n'
        expect(extractToolingCommands(research)).toEqual(['bun test'])
    })

    test('parses single-column entries', () => {
        const research = 'FILES\n…\n\nTOOLING\nbun test\nbun run lint\n'
        expect(extractToolingCommands(research)).toEqual(['bun test', 'bun run lint'])
    })

    test('parses two-column "category  command" entry (double-space)', () => {
        const research = 'TOOLING\nlint  bun run lint\n'
        expect(extractToolingCommands(research)).toEqual(['bun run lint'])
    })

    test('parses two-column "category  command" entries (double-space)', () => {
        const research = 'TOOLING\nlint  bun run lint\ntest  bun test\n'
        expect(extractToolingCommands(research)).toEqual(['bun run lint', 'bun test'])
    })

    test('returns null when no TOOLING block is present', () => {
        expect(extractToolingCommands('FILES\nx\n')).toBeNull()
    })

    test('returns null on empty TOOLING block', () => {
        expect(extractToolingCommands('TOOLING\n\nFILES\nx\n')).toBeNull()
    })
})

describe('replaceToolingWithVerified', () => {
    test('replaces a TOOLING block with VERIFIED-TOOLING in place', () => {
        const research = 'FILES\nf\n\nTOOLING\nbun test\nbun run lint\n\nCONTEXT\nc\n'
        const out = replaceToolingWithVerified(research, ['bun test'])
        expect(out).toContain('VERIFIED-TOOLING\n  bun test')
        expect(out).not.toMatch(/^TOOLING$/m)
        expect(out).toContain('CONTEXT')
    })

    test('appends VERIFIED-TOOLING when no TOOLING block exists', () => {
        const research = 'FILES\nf\n'
        const out = replaceToolingWithVerified(research, ['bun test'])
        expect(out).toContain('VERIFIED-TOOLING')
        expect(out).toContain('bun test')
    })

    test('uses placeholder when verified array is empty', () => {
        const research = 'TOOLING\nx\n'
        const out = replaceToolingWithVerified(research, [])
        expect(out).toContain('(none verified)')
    })
})

describe('parseVerifyToolingOutput', () => {
    test('parses verified and rejected sections', () => {
        const output = `VERIFIED
  npm test  found in package.json scripts
  tsc  found in node_modules/.bin/

REJECTED
  pytest  no Python tooling found`
        const result = parseVerifyToolingOutput(output)
        expect(result.verified).toEqual(['npm test', 'tsc'])
        expect(result.rejected[0].cmd).toBe('pytest')
        expect(result.rejected[0].reason).toBe('no Python tooling found')
    })

    test('handles empty sections gracefully', () => {
        const result = parseVerifyToolingOutput('VERIFIED\n\nREJECTED\n')
        expect(result.verified).toEqual([])
        expect(result.rejected).toEqual([])
    })
})

describe('phaseResearch leaked tool-call guard', () => {
    test('throws a clear error when a worker keeps leaking a tool call as text', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // Every spawn leaks, so each worker exhausts its re-prompts and comes
            // back flagged — the phase must fail loudly, not pass the XML through.
            const leaked =
                '<tool_call>\n<function=bash>\n<parameter=command>grep foo</parameter>\n</function>\n</tool_call>'
            const spawn = fakeSpawnByPrompt(() => agentEndResponse(leaked))
            await expect(
                phaseResearch(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'a refined goal with no mentions',
                    {getFileInventory: async () => ''}
                )
            ).rejects.toThrow(/tool call|leaked/i)
        })
    })
})

describe('phaseResearch loop guard', () => {
    // Sanity-check the routing marker stays in sync with the real prompt.
    const CONTEXT_MARKER = 'content of a CONTEXT section'
    test('the CONTEXT prompt carries the routing marker this suite keys on', () => {
        expect(RESEARCH_CONTEXT_PROMPT('x')).toContain(CONTEXT_MARKER)
    })

    test('a worker that loops through every restart degrades its section instead of failing the phase', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // Only the CONTEXT worker thrashes (same grep 6× every spawn, through
            // its initial attempt + both restarts); FILES/APIS/TOOLING answer
            // cleanly. The runaway must be reined in (loop-killed + restarted) and,
            // having still looped, DEGRADE to its partial output — one weak worker
            // must not abort the whole phase (and the whole auto-run). The bad
            // section is marked so it's never mistaken for a clean finding, and the
            // three good workers come through intact.
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes(CONTEXT_MARKER)) {
                    return loopResponse('grep', {pattern: 'glorptube'}, 6, {
                        trailingText: '- a partial context note'
                    })
                }
                return agentEndResponse('- a real finding')
            })
            const out = await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'a refined goal with no mentions',
                {getFileInventory: async () => ''}
            )
            // CONTEXT section is present but flagged degraded and carries the loop
            // detail plus whatever partial text the worker streamed.
            expect(out).toMatch(
                /CONTEXT\n\(degraded: research CONTEXT worker stuck in a loop.*grep/i
            )
            expect(out).toContain('- a partial context note')
            // The healthy workers are assembled normally.
            expect(out).toContain('FILES\n- a real finding')
            expect(out).toContain('TOOLING\n- a real finding')
        })
    })
})

describe('phaseResearch silent-retry gate (worker:context)', () => {
    const CONTEXT_MARKER = 'content of a CONTEXT section'
    // A substring unique to CONTEXT_SILENT_RETRY_PREAMBLE, so a fake can tell the ONE
    // forced-emit retry apart from the first attempt.
    const RETRY_MARKER = 'produced ZERO usable bullets'
    const isContext = (args: ReadonlyArray<string>): boolean =>
        (args[args.length - 1] ?? '').includes(CONTEXT_MARKER)
    const isRetry = (args: ReadonlyArray<string>): boolean =>
        (args[args.length - 1] ?? '').includes(RETRY_MARKER)

    const runWith = async (
        onContext: (attempt: number) => SpawnResponseJsonEvents
    ): Promise<{out: string; contextAttempts: number}> => {
        let contextAttempts = 0
        return withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnByPrompt(args => {
                if (isApisPrompt(args)) return groundedResponse('- a real finding')
                if (isContext(args)) {
                    contextAttempts++
                    return onContext(isRetry(args) ? 2 : 1)
                }
                return agentEndResponse('- a real finding')
            })
            const out = await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'a refined goal with no mentions',
                {getFileInventory: async () => ''}
            )
            return {out, contextAttempts}
        })
    }

    test('a garbage (zero-bullet) first attempt is retried and the recovery replaces it', async () => {
        const {out, contextAttempts} = await runWith(attempt =>
            attempt === 1 ?
                agentEndResponse('Users deleted') // hallucinated non-bullet fragment
            :   agentEndResponse('- src/index.ts exports AppType\n- hono pinned ^4.12.31')
        )
        expect(contextAttempts).toBe(2) // fired exactly once
        expect(out).toContain('- src/index.ts exports AppType')
        expect(out).not.toContain('Users deleted')
    })

    test('a loop-degrade first attempt (no partial bullet) is retried and recovered', async () => {
        const {out, contextAttempts} = await runWith(attempt =>
            attempt === 1 ?
                loopResponse('grep', {pattern: 'glorptube'}, 6) // degrades to a banner, 0 bullets
            :   agentEndResponse('- recovered architectural bullet')
        )
        // The loop path re-spawns internally (initial + restarts) before degrading, so the
        // count is >2; what matters is the retry fired and, since loopResponse always loops,
        // the only source of bullets is the forced-emit retry.
        expect(contextAttempts).toBeGreaterThan(2)
        expect(out).toContain('- recovered architectural bullet')
        expect(out).not.toMatch(/degraded: research CONTEXT/i)
    })

    test('a legitimately-empty section (NONE) is NOT retried', async () => {
        const {out, contextAttempts} = await runWith(() => agentEndResponse('NONE'))
        expect(contextAttempts).toBe(1) // gate did not fire
        // The honest "nothing to surface" answer survives — recorded with the marker
        // that says the worker RAN and found nothing (issue #10), rather than as the
        // bare token, which reads the same as a section nobody wrote.
        expect(out).toContain('CONTEXT\n(none — the CONTEXT worker ran and reported no entries')
    })

    test('if the retry is also silent, the original is kept (no regression)', async () => {
        const {out, contextAttempts} = await runWith(() => agentEndResponse('Users deleted'))
        expect(contextAttempts).toBe(2) // fired once, retry also garbage
        expect(out).toContain('CONTEXT\nUsers deleted') // original preserved, not blanked
    })
})

describe('phaseResearch per-worker persistence', () => {
    // Marker strings each worker's prompt carries, used to route fake spawns and
    // to keep this suite honest if a prompt is renamed.
    const MARKERS = {
        files: 'content of a FILES section',
        apis: 'content of an APIS section',
        context: 'content of a CONTEXT section',
        tooling: 'content of a TOOLING section'
    }

    function classify(args: ReadonlyArray<string>): keyof typeof MARKERS | 'other' {
        const prompt = args[args.length - 1] ?? ''
        for (const k of Object.keys(MARKERS) as Array<keyof typeof MARKERS>) {
            if (prompt.includes(MARKERS[k])) return k
        }
        return 'other'
    }

    test('a resumed phase reuses cached workers and only re-runs the failed one', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )

            const spawns: Record<string, number> = {}
            let toolingShouldFail = true
            const spawn = fakeSpawnByPrompt(args => {
                const which = classify(args)
                spawns[which] = (spawns[which] ?? 0) + 1
                // TOOLING (the last worker) hits a FATAL failure on run 1 — a reported
                // model error, the untrustworthy mode that still throws (unlike a
                // runaway, which would degrade-and-cache, or a plain empty answer,
                // which is now retried and accepted — issue #10). It fails the phase
                // after FILES/APIS/CONTEXT answered cleanly, and is NOT cached, so the
                // resume re-runs only it.
                if (which === 'tooling' && toolingShouldFail) {
                    return agentErrorResponse('fetch failed')
                }
                return agentEndResponse(`- finding for ${which}`)
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}

            // Run 1: TOOLING's model turn fails → the phase throws with a
            // TOOLING-named error.
            await expect(
                phaseResearch(deps, 'a refined goal with no mentions', {
                    getFileInventory: async () => ''
                })
            ).rejects.toThrow(/TOOLING worker: model error/i)

            // The three good workers were cached; the failed one was not.
            expect(await readSection(cwd, 'TASK_0001', 'research worker FILES')).toContain('files')
            expect(await readSection(cwd, 'TASK_0001', 'research worker APIS')).toContain('apis')
            expect(await readSection(cwd, 'TASK_0001', 'research worker CONTEXT')).toContain(
                'context'
            )
            expect(await readSection(cwd, 'TASK_0001', 'research worker TOOLING')).toBeNull()

            const afterRun1 = {...spawns}

            // Run 2 (resume at research): TOOLING now answers cleanly.
            toolingShouldFail = false
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })

            // The cached workers were NOT re-spawned; only TOOLING ran again (once).
            expect(spawns.files).toBe(afterRun1.files)
            expect(spawns.apis).toBe(afterRun1.apis)
            expect(spawns.context).toBe(afterRun1.context)
            expect(spawns.tooling).toBe((afterRun1.tooling ?? 0) + 1)

            // Output is assembled from the cached sections plus the fresh TOOLING run.
            expect(out).toContain('FILES\n- finding for files')
            expect(out).toContain('TOOLING\n- finding for tooling')

            // On success the per-worker caches are cleaned up (the assembled
            // 'research' section, written by the orchestrator, is canonical).
            expect(await readSection(cwd, 'TASK_0001', 'research worker FILES')).toBeNull()
            expect(await readSection(cwd, 'TASK_0001', 'research worker TOOLING')).toBeNull()
        })
    })

    test('a degraded runaway section is cached across a resume triggered by a later fatal worker, so the deterministic loop is not re-run', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )

            const spawns: Record<string, number> = {}
            let toolingShouldFail = true
            const spawn = fakeSpawnByPrompt(args => {
                const which = classify(args)
                spawns[which] = (spawns[which] ?? 0) + 1
                // FILES (first worker) loops through every restart on EVERY spawn —
                // a deterministic runaway. TOOLING (last) fatally fails on run 1.
                if (which === 'files') {
                    return loopResponse('read', {path: '/x'}, 6)
                }
                if (which === 'tooling' && toolingShouldFail) {
                    return agentErrorResponse('fetch failed')
                }
                return agentEndResponse(`- finding for ${which}`)
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}

            // Run 1: FILES degrades (cached), then TOOLING fatally fails → throw.
            await expect(
                phaseResearch(deps, 'a refined goal with no mentions', {
                    getFileInventory: async () => ''
                })
            ).rejects.toThrow(/TOOLING worker: model error/i)

            // FILES looped through its full restart budget once, and its degraded
            // section was cached (unlike a fatal failure, which is not).
            const filesSpawnsAfterRun1 = spawns.files ?? 0
            expect(filesSpawnsAfterRun1).toBeGreaterThan(1)
            expect(await readSection(cwd, 'TASK_0001', 'research worker FILES')).toMatch(
                /degraded: research FILES worker stuck in a loop/i
            )

            // Run 2 (resume): TOOLING now answers cleanly; FILES is reused from the
            // cache and is NOT re-spawned — the deterministic loop never runs again.
            toolingShouldFail = false
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })
            expect(spawns.files ?? 0).toBe(filesSpawnsAfterRun1)
            expect(out).toMatch(/FILES\n\(degraded: research FILES worker stuck in a loop/i)
            expect(out).toContain('TOOLING\n- finding for tooling')
        })
    })
})

describe('phaseResearch APIS zero-retrieval gate (mx5 run-15 F-1, distinct)', () => {
    // A plausible APIS section a real rep emitted having made ZERO tool calls — every
    // signature recalled from memory. See scripts/live-apis-stopping-point.ts.
    const FROM_MEMORY =
        'hono/client  hc<AppType> creates a typed client; $get/$post methods per route\n'
        + 'AppType  export type AppType = typeof app from src/index.ts'
    const GROUNDED = '- verified finding for apis'

    // agent_end preceded by the given tool calls, so groundingRetrievalCount reflects them.
    const respWithCalls = (
        tools: ReadonlyArray<string>,
        text: string
    ): SpawnResponseJsonEvents => ({
        events: [
            ...tools.map(toolName => ({type: 'tool_execution_start', toolName, args: {}})),
            {type: 'agent_end', messages: [{role: 'assistant', content: [{type: 'text', text}]}]}
        ],
        exitCode: 0
    })

    const RETRY_MARK = 'STOP. Your previous attempt'

    test('re-runs worker:apis once and keeps the grounded retry when the first pass retrieved nothing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawns = {apis: 0, files: 0}
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of an APIS section')) {
                    spawns.apis++
                    // First pass: a section from memory, no tool calls. Retry (preamble
                    // present): a section grounded by a real docs call.
                    return prompt.includes(RETRY_MARK) ?
                            respWithCalls(['pi-worker-docs'], GROUNDED)
                        :   agentEndResponse(FROM_MEMORY)
                }
                // Control: the FILES worker also answers with no tool calls but has no
                // gate, so it must run exactly once.
                if (prompt.includes('content of a FILES section')) spawns.files++
                return agentEndResponse('- finding')
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })

            expect(spawns.apis).toBe(2) // retried once
            expect(spawns.files).toBe(1) // control: not retried
            expect(out).toContain(GROUNDED)
            expect(out).not.toContain('$get/$post methods') // memory section replaced
        })
    })

    test('keeps the original section (no regression) when the retry also retrieves nothing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            let apis = 0
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of an APIS section')) {
                    apis++
                    return agentEndResponse(FROM_MEMORY) // both passes: still zero retrieval
                }
                return agentEndResponse('- finding')
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })
            expect(apis).toBe(2) // retried once, then gave up
            expect(out).toContain('$get/$post methods') // original kept — entry count preserved
        })
    })

    test('a worker:apis section built WITH retrieval is never retried', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            let apis = 0
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of an APIS section')) {
                    apis++
                    return respWithCalls(['pi-worker-docs'], GROUNDED)
                }
                return agentEndResponse('- finding')
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })
            expect(apis).toBe(1)
        })
    })
})

describe('phaseResearch CONTEXT post-check (mx5 run-15 F-1)', () => {
    // Verbatim from TASK_0027.md — the bullet that killed the run. worker:context has
    // read+grep only, so the base-URL half necessarily came from model memory; fused with
    // the true pinned-version half under one attribution it read as sourced.
    const FATAL =
        '- The `hono` dependency is pinned at `^4.12.31` in package.json, and the external '
        + 'context confirms `hc<AppType>` pattern with base URL `/api` for same-origin '
        + 'relative paths works correctly (per Hono RPC docs LIVE data).'
    const LEGIT =
        '- `AppType` is exported from `src/index.ts` as `export type AppType = typeof app`.'

    test('demotes the unsourced attributed bullet BEFORE the section is persisted, and keeps the bullet count', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            // The post-check reads the dependency names from the project manifest.
            nodeFs.writeFileSync(
                nodePath.join(cwd, 'package.json'),
                JSON.stringify({name: 'x', dependencies: {hono: '^4.12.31'}})
            )

            let toolingShouldFail = true
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of a CONTEXT section')) {
                    return agentEndResponse(`${FATAL}\n${LEGIT}`)
                }
                if (prompt.includes('content of a TOOLING section') && toolingShouldFail) {
                    return agentErrorResponse('fetch failed')
                }
                return agentEndResponse('- finding')
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}

            // TOOLING fails so the phase throws with CONTEXT already persisted — which is
            // exactly where the gate has to have run: the cache a resume reads back must
            // never carry the laundered claim either.
            await expect(
                phaseResearch(deps, 'a refined goal with no mentions', {
                    getFileInventory: async () => ''
                })
            ).rejects.toThrow(/TOOLING worker: model error/i)

            const cached = (await readSection(cwd, 'TASK_0001', 'research worker CONTEXT')) ?? ''
            expect(cached).toContain('OPEN QUESTION')
            expect(cached).not.toMatch(/LIVE data/i)
            expect(cached).not.toMatch(/external context confirms/i)
            // INVARIANT: two bullets in, two bullets out — demoted, not deleted.
            expect(cached.split('\n').filter(l => /^\s*- /.test(l))).toHaveLength(2)
            expect(cached).toContain('`AppType` is exported')
            // The observation itself survives for the grill to ask about.
            expect(cached).toContain('base URL')

            // Resume: the gated section is served from cache unchanged and the assembled
            // research text never carries the attribution.
            toolingShouldFail = false
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })
            expect(out).toContain('OPEN QUESTION')
            expect(out).not.toMatch(/LIVE data/i)
        })
    })

    test('a CONTEXT section with nothing to flag is passed through untouched', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            nodeFs.writeFileSync(
                nodePath.join(cwd, 'package.json'),
                JSON.stringify({name: 'x', dependencies: {hono: '^4.12.31'}})
            )
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of a CONTEXT section')) {
                    return agentEndResponse(
                        `${LEGIT}\n- \`hono\` is pinned at \`^4.12.31\`; external context confirms latest is 4.12.31.`
                    )
                }
                return agentEndResponse('- finding')
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                getFileInventory: async () => ''
            })
            expect(out).not.toContain('OPEN QUESTION')
            expect(out).toContain('external context confirms latest is 4.12.31.')
        })
    })
})

describe('phaseResearch APIS worker gets the FILES map (serial mode)', () => {
    test("serial: APIS prompt carries FILES' finished section + the no-re-derive rule; parallel: it does not", async () => {
        const run = async (): Promise<string> => {
            let apisPrompt = ''
            await withTmpTaskDir(async cwd => {
                await writeTaskFile(
                    cwd,
                    {
                        id: 'TASK_0001',
                        state: 'in_progress',
                        phase: 'research',
                        created_at: '2026-01-01T00:00:00Z',
                        updated_at: '2026-01-01T00:00:00Z',
                        title: 't'
                    },
                    '\n'
                )
                const spawn = fakeSpawnByPrompt(args => {
                    const prompt = args[args.length - 1] ?? ''
                    if (prompt.includes('content of an APIS section')) apisPrompt = prompt
                    if (prompt.includes('content of a FILES section')) {
                        return agentEndResponse('src/server/routes.ts  the route table')
                    }
                    return agentEndResponse('- finding')
                })
                await phaseResearch(
                    {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                    'a refined goal with no mentions',
                    {getFileInventory: async () => ''}
                )
            })
            return apisPrompt
        }

        // BOTH halves pin the flag, and the finally restores what was there. Reading
        // the ambient value for the serial half made this test fail on any machine
        // whose ~/.config/pi-task/config.json turns parallel workers ON (the map only
        // rides along in serial mode) — and restoring a hardcoded `false` silently
        // rewrote that user's setting in the process.
        const cfg = getConfig()
        const prev = cfg.parallelResearchWorkers
        try {
            cfg.parallelResearchWorkers = false
            const serialPrompt = await run()
            expect(serialPrompt).toContain('PROJECT FILE MAP')
            expect(serialPrompt).toContain('src/server/routes.ts  the route table')
            expect(serialPrompt).toContain('USE THE MAP')

            cfg.parallelResearchWorkers = true
            const parallelPrompt = await run()
            expect(parallelPrompt).not.toContain('PROJECT FILE MAP')
        } finally {
            cfg.parallelResearchWorkers = prev
        }
    })
})

// mx5 run 9 item 5 — GUARANTEE the never-before-exercised search path stays wired.
// Live validation showed the provider dispatch is healthy (exa + ddg return real
// results) and the model DOES invoke pi-worker-search 5/5 when the task needs a
// fresh fact and the hint is present; the "0 search calls" across runs traced to the
// TASK never signalling a web need (item 4's dropped directive), not a broken path.
// This deterministic guard fails if a refactor ever drops search from the APIS worker
// (tool whitelist, extension, or the trigger hint), which WOULD silently re-break it.
describe('phaseResearch search-path wiring (run 9 item 5)', () => {
    test('APIS worker gets pi-worker-search + fetch tools, the search extension, and the trigger hint', async () => {
        let apisArgs: ReadonlyArray<string> = []
        let apisPrompt = ''
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] ?? ''
                if (prompt.includes('content of an APIS section')) {
                    apisArgs = args
                    apisPrompt = prompt
                }
                return agentEndResponse('- finding')
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'a refined goal with no mentions',
                {getFileInventory: async () => ''}
            )
        })
        // Default provider is exa (keyless) → searchConfigured() is true → the tool
        // rides on every run. --tools carries the search + fetch workers…
        const toolsIdx = apisArgs.indexOf('--tools')
        const toolsCsv = toolsIdx >= 0 ? (apisArgs[toolsIdx + 1] ?? '') : ''
        expect(toolsCsv).toContain('pi-worker-search')
        expect(toolsCsv).toContain('pi-worker-fetch')
        // …the search extension is loaded via -e…
        expect(apisArgs.some(a => /search-extension/.test(a))).toBe(true)
        // …and the trigger hint (the working lever, live-proven 5/5) is in the prompt.
        expect(apisPrompt).toContain('pi-worker-search')
        expect(apisPrompt.toLowerCase()).toContain('live web')
    })
})

describe('phaseResearch parallel workers (opt-in flag)', () => {
    const MARKERS = {
        files: 'content of a FILES section',
        apis: 'content of an APIS section',
        context: 'content of a CONTEXT section',
        tooling: 'content of a TOOLING section'
    }

    function classify(args: ReadonlyArray<string>): keyof typeof MARKERS | 'other' {
        const prompt = args[args.length - 1] ?? ''
        for (const k of Object.keys(MARKERS) as Array<keyof typeof MARKERS>) {
            if (prompt.includes(MARKERS[k])) return k
        }
        return 'other'
    }

    async function withParallelFlag(fn: () => Promise<void>): Promise<void> {
        const cfg = getConfig()
        const prev = cfg.parallelResearchWorkers
        cfg.parallelResearchWorkers = true
        try {
            await fn()
        } finally {
            cfg.parallelResearchWorkers = prev
        }
    }

    async function makeTask(cwd: string): Promise<void> {
        await writeTaskFile(
            cwd,
            {
                id: 'TASK_0001',
                state: 'in_progress',
                phase: 'research',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                title: 't'
            },
            '\n'
        )
    }

    test('assembly order is the spec order even when completion order inverts', async () => {
        await withParallelFlag(() =>
            withTmpTaskDir(async cwd => {
                await makeTask(cwd)
                // FILES (first spec) finishes LAST; TOOLING (last spec) first.
                const delays: Record<string, number> = {files: 120, apis: 80, context: 40}
                const spawn = fakeSpawnByPrompt(args => {
                    const which = classify(args)
                    return {
                        ...agentEndResponse(`- finding for ${which}`),
                        closeDelayMs: delays[which] ?? 0
                    }
                })
                const deps = {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn
                }
                const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                    getFileInventory: async () => ''
                })
                const order = ['FILES', 'APIS', 'CONTEXT', 'TOOLING'].map(s => out.indexOf(s))
                expect(order.every(i => i >= 0)).toBe(true)
                expect([...order].sort((a, b) => a - b)).toEqual(order)
                expect(out).toContain('FILES\n- finding for files')
                expect(out).toContain('TOOLING\n- finding for tooling')
            })
        )
    })

    test('one fatal worker does not orphan the others — their sections are cached before the throw', async () => {
        await withParallelFlag(() =>
            withTmpTaskDir(async cwd => {
                await makeTask(cwd)
                const spawns: Record<string, number> = {}
                let apisShouldFail = true
                const spawn = fakeSpawnByPrompt(args => {
                    const which = classify(args)
                    spawns[which] = (spawns[which] ?? 0) + 1
                    // APIS fails fatally on run 1 while the others succeed
                    // slower — allSettled must still persist all three.
                    if (which === 'apis' && apisShouldFail)
                        return agentErrorResponse('fetch failed')
                    // A healthy APIS worker retrieves, so the zero-retrieval gate leaves it
                    // alone — otherwise it would re-run and inflate the resume spawn count.
                    if (which === 'apis')
                        return {...groundedResponse('- finding for apis'), closeDelayMs: 40}
                    return {...agentEndResponse(`- finding for ${which}`), closeDelayMs: 40}
                })
                const deps = {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn
                }
                await expect(
                    phaseResearch(deps, 'a refined goal with no mentions', {
                        getFileInventory: async () => ''
                    })
                ).rejects.toThrow(/APIS worker: model error/i)

                expect(await readSection(cwd, 'TASK_0001', 'research worker FILES')).toContain(
                    'files'
                )
                expect(await readSection(cwd, 'TASK_0001', 'research worker CONTEXT')).toContain(
                    'context'
                )
                expect(await readSection(cwd, 'TASK_0001', 'research worker TOOLING')).toContain(
                    'tooling'
                )
                expect(await readSection(cwd, 'TASK_0001', 'research worker APIS')).toBeNull()

                // Resume: only APIS re-runs; the cached three are skipped.
                apisShouldFail = false
                const before = {...spawns}
                const out = await phaseResearch(deps, 'a refined goal with no mentions', {
                    getFileInventory: async () => ''
                })
                expect(spawns.files).toBe(before.files)
                expect(spawns.context).toBe(before.context)
                expect(spawns.tooling).toBe(before.tooling)
                expect(spawns.apis).toBe((before.apis ?? 0) + 1)
                expect(out).toContain('APIS\n- finding for apis')
            })
        )
    })
})

describe('phaseResearch enrichment DI', () => {
    test('docsRaw is called for backtick-quoted packages in the refined text', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const pkgsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'worker-output'}]}
                        ]
                    }
                ]
            }))
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'use `zod` for validation',
                {
                    docsRaw: async ({pkg}) => {
                        pkgsSeen.push(pkg)
                        return {
                            kind: 'ok',
                            pkg: {
                                name: pkg,
                                version: '1.0.0',
                                root: '/tmp',
                                entryDts: null,
                                readme: null
                            },
                            chunks: [{filePath: 'x', kind: 'dts', content: 'fake docs', rank: 0}],
                            hitCache: true
                        }
                    }
                }
            )
            expect(pkgsSeen).toContain('zod')
        })
    })

    test('externalContext is prepended to all 4 research worker prompts', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                if (isApisPrompt(args)) return groundedResponse('worker-output')
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: '- worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'use `zod` for validation',
                {
                    docsRaw: async ({pkg}) => ({
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: 'ZOD_DOCS_MARKER', rank: 0}],
                        hitCache: true
                    })
                }
            )
            const withMarker = promptsSeen.filter(p => p.includes('ZOD_DOCS_MARKER'))
            expect(withMarker.length).toBe(4)
        })
    })

    test('npm version info is injected ahead of docs in EXTERNAL CONTEXT', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'pin `react` to exact version',
                {
                    docsRaw: async ({pkg}) => ({
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: 'DOCS_BODY', rank: 0}],
                        hitCache: true,
                        npmVersion: {
                            pkg,
                            latest: '19.0.0',
                            recent: ['19.0.0', '18.3.1'],
                            publishedAt: '2026-04-10T00:00:00.000Z'
                        }
                    })
                }
            )
            const reactPrompt = promptsSeen.find(p => p.includes('### npm: react'))
            expect(reactPrompt).toBeDefined()
            expect(reactPrompt).toContain('latest: 19.0.0 (published 2026-04-10)')
            // npm block must appear before the docs block so the model anchors on
            // version data before being distracted by API surface.
            const npmIdx = reactPrompt!.indexOf('### npm: react')
            const docsIdx = reactPrompt!.indexOf('### docs: react')
            expect(npmIdx).toBeGreaterThanOrEqual(0)
            expect(docsIdx).toBeGreaterThan(npmIdx)
        })
    })

    test('phaseResearch tolerates docsRaw returning no npmVersion', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                if (isApisPrompt(args)) return groundedResponse('worker-output')
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: '- worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'pin `zod` to exact version',
                {
                    docsRaw: async ({pkg}) => ({
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: 'DOCS_ONLY', rank: 0}],
                        hitCache: true,
                        npmVersion: null
                    })
                }
            )
            const withMarker = promptsSeen.filter(p => p.includes('DOCS_ONLY'))
            expect(withMarker.length).toBe(4)
            // A successful lookup would have inserted "### npm: zod" followed
            // by a "latest: <ver>" line into EXTERNAL CONTEXT. Verify neither
            // appears in any of the four worker prompts. (The unrelated string
            // "### npm: <pkg>" appears as a template instruction in the CONTEXT
            // prompt — that's fine; we only care about the concrete `zod`
            // injection.)
            for (const p of promptsSeen) {
                expect(p).not.toContain('### npm: zod')
            }
        })
    })

    test('phaseResearch records per-worker wait + work sub-step timings', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const subSteps: Array<{label: string; ms: number}> = []
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'worker-output'}]}
                        ]
                    }
                ]
            }))
            await phaseResearch(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn,
                    recordSubStep: (label, ms) => subSteps.push({label, ms})
                },
                'plain refined prompt'
            )
            const labels = subSteps.map(s => s.label)
            for (const worker of [
                'worker:files',
                'worker:apis',
                'worker:context',
                'worker:tooling'
            ]) {
                expect(labels).toContain(`${worker} wait`)
                expect(labels).toContain(`${worker} work`)
            }
            for (const s of subSteps) {
                expect(s.ms).toBeGreaterThanOrEqual(0)
            }
        })
    })

    test('context worker is invoked with read,grep tool set only', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const observed: Array<{tools: string; prompt: string}> = []
            const spawn: SpawnFn = (_cmd, args) => {
                const argsArr = args as ReadonlyArray<string>
                const toolsIdx = argsArr.indexOf('--tools')
                const proc = makeProc()
                queueMicrotask(() => {
                    // Prompt is on stdin (written after spawn returns), tools in argv.
                    observed.push({
                        tools: argsArr[toolsIdx + 1],
                        prompt: proc.stdinData
                    })
                    proc.stdout!.emit(
                        'data',
                        Buffer.from(
                            JSON.stringify({
                                type: 'agent_end',
                                messages: [
                                    {role: 'assistant', content: [{type: 'text', text: 'out'}]}
                                ]
                            }) + '\n'
                        )
                    )
                    proc.emit('close', 0)
                })
                return proc
            }
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'plain refined prompt',
                {getFileInventory: async () => ''}
            )
            const contextObs = observed.find(o => o.prompt.includes('background knowledge'))
            expect(contextObs).toBeDefined()
            expect(contextObs!.tools).toBe('read,grep')
            // Other workers keep the broader tool set so FILES/APIS/TOOLING can
            // still discover.
            const filesObs = observed.find(o =>
                o.prompt.includes('every path on disk the agent will read')
            )
            expect(filesObs!.tools).toBe('read,grep,find,ls')
        })
    })

    test('file inventory is prepended to all 4 worker prompts when non-empty', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                if (isApisPrompt(args)) return groundedResponse('worker-output')
                return agentEndResponse('- worker-output')
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'plain refined prompt',
                {getFileInventory: async () => 'src/a.ts\nsrc/b.ts'}
            )
            const withMarker = promptsSeen.filter(p =>
                p.includes('PROJECT FILE INVENTORY\nsrc/a.ts\nsrc/b.ts')
            )
            expect(withMarker.length).toBe(4)
        })
    })

    test('phaseResearch tolerates getFileInventory throwing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                if (isApisPrompt(args)) return groundedResponse('worker-output')
                return agentEndResponse('- worker-output')
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'plain refined prompt',
                {
                    getFileInventory: async () => {
                        throw new Error('inventory unavailable')
                    }
                }
            )
            // All four workers still ran, just without an inventory header.
            expect(promptsSeen.length).toBe(4)
            for (const p of promptsSeen) {
                expect(p).not.toContain('PROJECT FILE INVENTORY')
            }
        })
    })

    test('inventory header sits between EXTERNAL CONTEXT and the worker instructions', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return agentEndResponse('- worker-output')
            })
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'use `zod` for validation',
                {
                    getFileInventory: async () => 'src/a.ts',
                    docsRaw: async ({pkg}) => ({
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: 'ZOD_DOCS_MARKER', rank: 0}],
                        hitCache: true
                    })
                }
            )
            const filesPrompt = promptsSeen.find(p =>
                p.includes('every path on disk the agent will read')
            )!
            const extIdx = filesPrompt.indexOf('EXTERNAL CONTEXT')
            const invIdx = filesPrompt.indexOf('PROJECT FILE INVENTORY')
            const bodyIdx = filesPrompt.indexOf('every path on disk the agent will read')
            expect(extIdx).toBeGreaterThanOrEqual(0)
            expect(invIdx).toBeGreaterThan(extIdx)
            expect(bodyIdx).toBeGreaterThan(invIdx)
        })
    })

    test('no "research enrichment" section is written to the task file', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'worker-output'}]}
                        ]
                    }
                ]
            }))
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'use `zod` for validation',
                {
                    docsRaw: async ({pkg}) => ({
                        kind: 'ok',
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        chunks: [{filePath: 'x', kind: 'dts', content: 'fake docs', rank: 0}],
                        hitCache: true
                    })
                }
            )
            const fs = await import('fs/promises')
            const path = await import('path')
            const taskBody = await fs.readFile(path.join(cwd, '.pi-tasks', 'TASK_0001.md'), 'utf-8')
            expect(taskBody).not.toContain('research enrichment')
        })
    })
})

describe('phaseAutoAnswer integration-unknown routing', () => {
    const meta = {
        id: 'TASK_0001',
        state: 'in_progress' as const,
        phase: 'grill' as const,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        title: 't'
    }
    const answerSpawn = (text: string): SpawnFn =>
        fakeSpawnByPrompt(() => ({
            events: [
                {
                    type: 'agent_end',
                    messages: [{role: 'assistant', content: [{type: 'text', text}]}]
                }
            ]
        }))

    test('downgrades an auto-ANSWERED integration unknown to a user-surfaced UNKNOWN when fetch resolved nothing', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, meta, '\n')
            // Pure wiring question, no backtick package → enrichment fetches
            // nothing → docResolved=false. grill-auto guesses ANSWER.
            const result = await phaseAutoAnswer(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn: answerSpawn('ANSWER: add the stylesheet import to the HTML entry')
                },
                'refined',
                'research',
                'The build plugin is referenced but the spec does not say how to wire it; should the stylesheet import structure in the HTML entry be modified?'
            )
            // The guess is NOT silently applied — it is surfaced to the user with
            // the model's answer pre-filled as the recommendation.
            expect(result.kind).toBe('unknown')
            if (result.kind === 'unknown') {
                expect(result.suggested).toBe('add the stylesheet import to the HTML entry')
            }
        })
    })

    test('leaves a benign auto-ANSWERED unknown untouched (no over-hoisting)', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, meta, '\n')
            const result = await phaseAutoAnswer(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn: answerSpawn('ANSWER: emit logs as JSON')
                },
                'refined',
                'research',
                'Should logs be emitted as JSON or plain text?'
            )
            expect(result.kind).toBe('answered')
        })
    })

    test('keeps the auto-answer when fetch DID ground an integration unknown', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, meta, '\n')
            const result = await phaseAutoAnswer(
                {
                    cwd,
                    taskId: 'TASK_0001',
                    signal: new AbortController().signal,
                    spawn: answerSpawn('ANSWER: register it in the build config')
                },
                'refined',
                'research',
                'How should the `some-plugin` plugin be wired into the build pipeline?',
                {
                    // A docs worker returns a non-empty answer → the integration
                    // unknown is grounded, so the auto-answer is allowed to stand.
                    docsFocused: async ({pkg}) => ({
                        answer: 'register the plugin in the build config and import it from the entry',
                        excerpt: undefined,
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        version: '1.0.0',
                        exitCode: 0,
                        aborted: false,
                        stderr: '',
                        npmVersion: null
                    })
                }
            )
            expect(result.kind).toBe('answered')
        })
    })
})

describe('phaseAutoAnswer enrichment', () => {
    test('injects npm version data ahead of the auto-answer prompt', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [
                                        {
                                            type: 'text',
                                            text: 'ANSWER: pin to 19.0.0 per live npm metadata'
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            })
            const result = await phaseAutoAnswer(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refined-task-text',
                'research-notes',
                'Which exact version of `react` should we pin?',
                {
                    docsFocused: async ({pkg}) => ({
                        answer: '',
                        excerpt: undefined,
                        pkg: {
                            name: pkg,
                            version: '1.0.0',
                            root: '/tmp',
                            entryDts: null,
                            readme: null
                        },
                        version: '1.0.0',
                        exitCode: 0,
                        aborted: false,
                        stderr: '',
                        npmVersion: {
                            pkg,
                            latest: '19.0.0',
                            recent: ['19.0.0', '18.3.1'],
                            publishedAt: '2026-04-10T00:00:00.000Z'
                        }
                    })
                }
            )
            expect(result.kind).toBe('answered')
            const grillPrompt = promptsSeen[0]
            expect(grillPrompt).toContain('### npm: react')
            expect(grillPrompt).toContain('latest: 19.0.0')
            // EXTERNAL CONTEXT must come before the auto-answer instructions so
            // the model anchors on live data before reading the prompt body.
            const ctxIdx = grillPrompt.indexOf('EXTERNAL CONTEXT')
            const promptIdx = grillPrompt.indexOf('You are pre-answering')
            expect(ctxIdx).toBeGreaterThanOrEqual(0)
            expect(promptIdx).toBeGreaterThan(ctxIdx)
        })
    })

    test('survives docsFocused returning null', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {
                                role: 'assistant',
                                content: [{type: 'text', text: 'UNKNOWN: no live data'}]
                            }
                        ]
                    }
                ]
            }))
            const result = await phaseAutoAnswer(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                'Which version of `react`?',
                {docsFocused: async () => Promise.reject(new Error('docs unavailable'))}
            )
            expect(result.kind).toBe('unknown')
        })
    })

    test('reprompts with the format hint when the first reply is untagged prose', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            let call = 0
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                call += 1
                // First reply ignores the format (free-form "analysis" preamble);
                // the second, post-hint reply is properly tagged.
                const text =
                    call === 1 ?
                        "This is a concrete implementation decision. Here's the analysis:"
                    :   'UNKNOWN: create the phone column now\nALT: defer to email-only auth'
                return agentEndResponse(text)
            })
            const result = await phaseAutoAnswer(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                'Create the phone column now, or defer it?'
            )
            expect(promptsSeen.length).toBe(2)
            expect(promptsSeen[1]).toContain('did NOT follow the required format')
            expect(result.kind).toBe('unknown')
            if (result.kind === 'unknown') {
                expect(result.suggested).toBe('create the phone column now')
                expect(result.alt).toBe('defer to email-only auth')
            }
        })
    })
})

// A bare-bones ExtensionCommandContext stub. Cast through unknown so the test
// doesn't have to mock every UI surface; phaseGrill on the empty path never
// touches `ctx` beyond reading `ui.theme` lazily, and not at all when there
// are zero questions.
const stubCtx = {
    hasUI: true,
    ui: {
        theme: {fg: (_: string, s: string) => s},
        input: async () => undefined,
        notify: () => undefined
    }
} as unknown as ExtensionCommandContext

const stubWidgetState: WidgetState = {
    taskId: 'TASK_TEST',
    title: 't',
    phase: 'grill',
    startedAt: 0
}

describe('phaseGrill', () => {
    test('returns "(no questions produced)" when worker emits NONE sentinel', async () => {
        await withTmpTaskDir(async cwd => {
            const spawn = fakeSpawnQueue([agentEndResponse('NONE')])
            const out = await phaseGrill(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                stubCtx,
                stubWidgetState,
                'refined-task',
                'research-notes'
            )
            expect(out).toBe('(no questions produced)')
        })
    })

    test('truly empty child output is treated as a failure, not as zero questions', async () => {
        // Disambiguation guarantee: the NONE sentinel is the ONLY way to signal
        // intentional silence. An empty stdout means the child crashed silently
        // and must propagate as an error so the orchestrator surfaces it.
        await withTmpTaskDir(async cwd => {
            const spawn = fakeSpawnQueue([agentEndResponse('')])
            await expect(
                phaseGrill(
                    {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                    stubCtx,
                    stubWidgetState,
                    'refined-task',
                    'research-notes'
                )
            ).rejects.toThrow(/grill-gen child produced no output/)
        })
    })

    test('asks questions sequentially, feeding each answer into the next grill-gen', async () => {
        // Adaptive interview: grill-gen is re-called after every answer, with the
        // prior Q&A in its prompt, and emits one question at a time until NONE.
        await withTmpTaskDir(async cwd => {
            let genCall = 0
            const genPrompts: string[] = []

            const spawn: SpawnFn = (_cmd: string, _args: ReadonlyArray<string>) => {
                const proc = makeProc()
                // The prompt arrives on stdin (written by runChild after spawn
                // returns), so branch on it inside the deferred microtask.
                queueMicrotask(() => {
                    const prompt = proc.stdinData
                    const isAuto = prompt.includes('pre-answering a clarifying question')
                    const isGen = prompt.includes('preparing clarifying questions')
                    if (isGen) genPrompts.push(prompt)
                    let text: string
                    if (isAuto) {
                        text = 'ANSWER: yes'
                    } else if (isGen) {
                        const qs = ['1. should we use bun?', '1. should we lint tests?', 'NONE']
                        text = qs[genCall++] ?? 'NONE'
                    } else {
                        text = 'noop'
                    }
                    const evt = {
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text}]}]
                    }
                    proc.stdout!.emit('data', Buffer.from(JSON.stringify(evt) + '\n'))
                    proc.emit('close', 0)
                })
                return proc
            }

            const out = await phaseGrill(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                stubCtx,
                stubWidgetState,
                'refined-task',
                'research-notes'
            )

            // Two questions asked in order, then NONE stops the loop (3 gen calls).
            expect(genCall).toBe(3)
            expect(out).toContain('Q1: should we use bun?')
            expect(out).toContain('Q2: should we lint tests?')
            // The 2nd grill-gen prompt carried the 1st Q&A — proof of adaptivity.
            expect(genPrompts[1]).toContain('should we use bun?')
            expect(genPrompts[1]).toContain('yes')
        })
    })

    test('suppresses a re-asked question before paying for its auto-answer', async () => {
        // Regression: a model that ignores "never re-ask" re-emits a settled fork
        // reworded. The dup must be caught BEFORE phaseAutoAnswer runs (which fans
        // out doc/fetch/search workers — the expensive part), reprompted, and not
        // shown to the user. A genuinely-different question after it still lands.
        await withTmpTaskDir(async cwd => {
            let genCall = 0
            let autoCalls = 0
            const genPrompts: string[] = []
            const spawn: SpawnFn = (_cmd: string, _args: ReadonlyArray<string>) => {
                const proc = makeProc()
                // The prompt arrives on stdin; branch on it in the microtask.
                queueMicrotask(() => {
                    const prompt = proc.stdinData
                    const isAuto = prompt.includes('pre-answering a clarifying question')
                    const isGen = prompt.includes('preparing clarifying questions')
                    if (isGen) genPrompts.push(prompt)
                    if (isAuto) autoCalls++
                    let text: string
                    if (isAuto) {
                        text = 'ANSWER: yes'
                    } else if (isGen) {
                        const qs = [
                            '1. Should uploaded images be resized server-side with sharp before storing in postgresql, or stored as raw blobs?',
                            '1. Should the image upload pipeline resize images server-side using sharp, or keep raw uploaded blobs in postgresql?', // dup → reprompt
                            '1. Should multer middleware parse the multipart form-data, or stream it natively?', // distinct
                            'NONE'
                        ]
                        text = qs[genCall++] ?? 'NONE'
                    } else {
                        text = 'noop'
                    }
                    const evt = {
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text}]}]
                    }
                    proc.stdout!.emit('data', Buffer.from(JSON.stringify(evt) + '\n'))
                    proc.emit('close', 0)
                })
                return proc
            }

            const out = await phaseGrill(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                stubCtx,
                stubWidgetState,
                'refined-task',
                'research-notes'
            )

            // Four gen calls (Q1, dup, distinct, NONE) but only two real questions
            // were auto-answered — the dup never reached phaseAutoAnswer.
            expect(genCall).toBe(4)
            expect(autoCalls).toBe(2)
            expect(out).toContain('Q1: Should uploaded images be resized')
            expect(out).toContain('multer')
            // The reworded duplicate ("pipeline") is never surfaced.
            expect(out).not.toContain('pipeline')
            // The reprompt after the dup carried the move-on hint.
            expect(genPrompts[2]).toContain('re-asked')
        })
    })

    test('phaseGrill records per-iteration gen / auto-answer sub-step timings', async () => {
        await withTmpTaskDir(async cwd => {
            const subSteps: Array<{label: string; ms: number}> = []
            // iter0: gen(Q1) + auto(answered); iter1: gen returns NONE → stop.
            const spawn = fakeSpawnQueue([
                agentEndResponse('1. is bun ok?'),
                agentEndResponse('ANSWER: yes'),
                agentEndResponse('NONE')
            ])
            await phaseGrill(
                {
                    cwd,
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn,
                    recordSubStep: (label, ms) => subSteps.push({label, ms})
                },
                stubCtx,
                stubWidgetState,
                'refined',
                'research'
            )
            const labels = subSteps.map(s => s.label)
            expect(labels).toContain('gen')
            expect(labels).toContain('auto-answer')
            for (const s of subSteps) {
                expect(s.ms).toBeGreaterThanOrEqual(0)
            }
        })
    })

    test('two-option grill: picking A/B in the boxed picker stores that option, not the label', async () => {
        // The binary fork renders as a boxed picker labelled "A:" / "B:". Records
        // must store the chosen option's full text so the next grill-gen call can
        // reason over it — storing the bare "A" (or the "A: " label) would leave a
        // dangling reference the model can't decode.
        const pickIndex = (idx: number) =>
            ({
                hasUI: true,
                ui: {
                    theme: {fg: (_: string, s: string) => s, bold: (s: string) => s},
                    // Drive the real boxed component to card `idx`, then confirm.
                    custom: <T>(
                        factory: (
                            tui: unknown,
                            theme: unknown,
                            kb: unknown,
                            done: (r: T) => void
                        ) => {handleInput: (d: string) => void}
                    ) =>
                        new Promise<T>(resolve => {
                            const comp = factory({}, {}, {}, resolve)
                            for (let i = 0; i < idx; i++) comp.handleInput('\x1b[B')
                            comp.handleInput('\r')
                        }),
                    input: async () => undefined,
                    notify: () => undefined
                }
            }) as unknown as ExtensionCommandContext

        await withTmpTaskDir(async cwd => {
            // gen → one binary question; auto → UNKNOWN + ALT (two-option mode); gen → NONE.
            const twoOption = () =>
                fakeSpawnQueue([
                    agentEndResponse('1. return mustChangePassword true or false?'),
                    agentEndResponse('UNKNOWN: return false\nALT: return true and force a change'),
                    agentEndResponse('NONE')
                ])

            const outA = await phaseGrill(
                {
                    cwd,
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn: twoOption()
                },
                pickIndex(0), // the "A: …" entry
                stubWidgetState,
                'refined-task',
                'research-notes'
            )
            expect(outA).toContain('A1: return false')
            expect(outA).not.toMatch(/A1: A:/)

            const outB = await phaseGrill(
                {
                    cwd,
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn: twoOption()
                },
                pickIndex(1), // the "B: …" entry
                stubWidgetState,
                'refined-task',
                'research-notes'
            )
            expect(outB).toContain('A1: return true and force a change')
            expect(outB).not.toMatch(/A1: B:/)
        })
    })

    test('phaseGrill completes from a remote answer when local input never resolves', async () => {
        const b = getBridge()
        _setSink(() => {}) // prompt flows through SessionState; no real WS
        // Local input that never settles → only a remote answer can resolve ask().
        const noLocalCtx = {
            hasUI: true,
            ui: {
                theme: {fg: (_: string, s: string) => s},
                input: () => new Promise<string | undefined>(() => {}),
                notify: () => undefined
            }
        } as unknown as ExtensionCommandContext
        // Poll the bridge and answer each question as soon as it goes active.
        const poll = setInterval(() => {
            const p = getState().prompt
            if (p) answerPrompt(p.id, 'remote pick')
        }, 5)
        try {
            await withTmpTaskDir(async cwd => {
                // grill-gen: one question; auto-answer: UNKNOWN: (forces user/ask path); grill-gen: NONE
                const spawn = fakeSpawnQueue([
                    agentEndResponse('1. which bundler?'),
                    agentEndResponse('UNKNOWN:'),
                    agentEndResponse('NONE')
                ])
                const out = await phaseGrill(
                    {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                    noLocalCtx,
                    {taskId: 'TASK_TEST', title: 't', phase: 'grill', startedAt: 0},
                    'refined-task',
                    'research-notes'
                )
                expect(out).toContain('remote pick')
            })
        } finally {
            clearInterval(poll)
            reset()
            b.pending.clear()
        }
    })
})

describe('phaseCritique conditional rewrite', () => {
    const validSpec =
        'GOAL\n  do the thing\n\nCONSTRAINTS\n  - keep x\n\nACCEPTANCE\n  - y works\n\nVERIFY:\n```sh\nnpm test\n```\n'

    test('CLEAN triage short-circuits — returns the draft, never rewrites', async () => {
        await withTmpTaskDir(async cwd => {
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return agentEndResponse('CLEAN')
            })
            const out = await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                validSpec,
                'refined',
                'qa'
            )
            // Draft returned verbatim.
            expect(out).toBe(validSpec)
            // Exactly one child ran (triage); the rewrite was skipped.
            expect(promptsSeen.length).toBe(1)
            expect(promptsSeen[0]).toContain('triaging an implementation spec')
        })
    })

    test('a deterministic skip-escape overrides CLEAN triage and forces the rewrite (run-8 F2)', async () => {
        await withTmpTaskDir(async cwd => {
            const escapeSpec =
                'GOAL\n  ship a page\n\nCONSTRAINTS\n  - a\n\nACCEPTANCE\n  - renders\n\nVERIFY:\n```sh\nuismoke smoke.spec.js || echo "skipping browser smoke (uismoke not installed)"\n```\n'
            const rewritten =
                'GOAL\n  ship a page\n\nCONSTRAINTS\n  - a\n\nACCEPTANCE\n  - renders\n\nVERIFY:\n```sh\nuismoke smoke.spec.js\n```\n'
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] as string
                promptsSeen.push(prompt)
                // Triage says CLEAN — but the deterministic skip-escape must still force a rewrite.
                if (prompt.includes('triaging an implementation spec'))
                    return agentEndResponse('CLEAN')
                return agentEndResponse(rewritten)
            })
            const out = await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                escapeSpec,
                'refined',
                'qa'
            )
            // Did NOT short-circuit despite CLEAN triage: the rewrite ran.
            expect(out).toBe(rewritten.trim())
            expect(promptsSeen.length).toBe(2)
            const rewritePrompt = promptsSeen.find(p =>
                p.includes('reviewing the implementation spec')
            )!
            expect(rewritePrompt).toContain('SKIP-ESCAPE in the VERIFY block')
            expect(rewritePrompt).toContain('uismoke smoke.spec.js || echo')
        })
    })

    test('triage runs tool-less (--no-tools), the rewrite keeps read access', async () => {
        await withTmpTaskDir(async cwd => {
            const observed: Array<{argv: ReadonlyArray<string>; prompt: string}> = []
            const spawn: SpawnFn = (_cmd, args) => {
                const argv = args as ReadonlyArray<string>
                const proc = makeProc()
                queueMicrotask(() => {
                    // Prompt on stdin, argv still carries the tool flags.
                    const prompt = proc.stdinData
                    observed.push({argv, prompt})
                    const text =
                        prompt.includes('triaging an implementation spec') ? 'ACCEPTANCE: vague' : (
                            validSpec
                        )
                    proc.stdout!.emit(
                        'data',
                        Buffer.from(
                            JSON.stringify({
                                type: 'agent_end',
                                messages: [{role: 'assistant', content: [{type: 'text', text}]}]
                            }) + '\n'
                        )
                    )
                    proc.emit('close', 0)
                })
                return proc
            }
            await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                validSpec,
                'refined',
                'qa'
            )
            const triage = observed.find(o => o.prompt.includes('triaging an implementation spec'))!
            expect(triage.argv).toContain('--no-tools')
            expect(triage.argv).not.toContain('--tools')
            const rewrite = observed.find(o =>
                o.prompt.includes('reviewing the implementation spec')
            )!
            const t = rewrite.argv.indexOf('--tools')
            expect(t).toBeGreaterThanOrEqual(0)
            expect(rewrite.argv[t + 1]).toBe('read')
        })
    })

    test('triage defects flow into the rewrite as a FOCUS block', async () => {
        await withTmpTaskDir(async cwd => {
            const promptsSeen: string[] = []
            const rewritten =
                'GOAL\n  sharper\n\nCONSTRAINTS\n  - keep x\n\nACCEPTANCE\n  - y measured by z\n\nVERIFY:\n```sh\nnpm test\n```\n'
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] as string
                promptsSeen.push(prompt)
                if (prompt.includes('triaging an implementation spec')) {
                    return agentEndResponse('ACCEPTANCE: criterion is unmeasurable')
                }
                return agentEndResponse(rewritten)
            })
            const out = await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                validSpec,
                'refined',
                'qa'
            )
            // Rewrite output is the child's assistant text (trimmed by the runner).
            expect(out).toBe(rewritten.trim())
            // Two children: triage then rewrite.
            expect(promptsSeen.length).toBe(2)
            const rewritePrompt = promptsSeen.find(p =>
                p.includes('reviewing the implementation spec')
            )!
            expect(rewritePrompt).toContain('FOCUS —')
            expect(rewritePrompt).toContain('ACCEPTANCE: criterion is unmeasurable')
        })
    })

    test('a draft without a runnable VERIFY block skips triage and goes straight to rewrite', async () => {
        await withTmpTaskDir(async cwd => {
            const draftNoVerify = 'GOAL\n  x\n\nCONSTRAINTS\n  - a\n\nACCEPTANCE\n  - b\n'
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return agentEndResponse(validSpec)
            })
            const out = await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                draftNoVerify,
                'refined',
                'qa'
            )
            expect(out).toBe(validSpec.trim())
            // No triage call — the very first (and only) child is the rewrite.
            expect(promptsSeen[0]).toContain('reviewing the implementation spec')
            expect(promptsSeen.every(p => !p.includes('triaging an implementation spec'))).toBe(
                true
            )
        })
    })

    test('triage failure is non-fatal — falls back to the rewrite', async () => {
        await withTmpTaskDir(async cwd => {
            let call = 0
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] as string
                call++
                // First call is triage: simulate a crash (non-zero exit, no text).
                if (prompt.includes('triaging an implementation spec')) {
                    return agentEndResponse('', 1)
                }
                return agentEndResponse(validSpec)
            })
            const out = await phaseCritique(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                validSpec,
                'refined',
                'qa'
            )
            expect(out).toBe(validSpec.trim())
            expect(call).toBeGreaterThanOrEqual(2)
        })
    })

    test('records triage and rewrite sub-step timings', async () => {
        await withTmpTaskDir(async cwd => {
            const subSteps: Array<{label: string; ms: number}> = []
            const spawn = fakeSpawnByPrompt(args => {
                const prompt = args[args.length - 1] as string
                if (prompt.includes('triaging an implementation spec')) {
                    return agentEndResponse('NEEDS WORK: tighten acceptance')
                }
                return agentEndResponse(validSpec)
            })
            await phaseCritique(
                {
                    cwd,
                    taskId: 'TASK_TEST',
                    signal: new AbortController().signal,
                    spawn,
                    recordSubStep: (label, ms) => subSteps.push({label, ms})
                },
                validSpec,
                'refined',
                'qa'
            )
            const labels = subSteps.map(s => s.label)
            expect(labels).toContain('triage')
            expect(labels).toContain('rewrite')
        })
    })
})

describe('phaseCompose VERIFY block gate', () => {
    // The exact shape that failed TASK_0022: GOAL/CONSTRAINTS/ACCEPTANCE all
    // present, but the `VERIFY:` header has no fenced command block after it.
    // validateSpecShape accepts this (header exists); parseVerifyBlock rejects
    // it (no runnable commands). Compose must apply the stricter bar so it never
    // hands a header-only draft to the downstream gates that reject it.
    const draftHeaderOnly =
        'GOAL\n  build it\n\nCONSTRAINTS\n  - keep x\n\nACCEPTANCE\n  - y works\n\nVERIFY:\n'
    const draftRunnable =
        'GOAL\n  build it\n\nCONSTRAINTS\n  - keep x\n\nACCEPTANCE\n  - y works\n\nVERIFY:\n```sh\nnpm test\n```\n'

    test('a bare `VERIFY:` header with no fenced block is rejected and retried, then throws compose_invalid', async () => {
        await withTmpTaskDir(async cwd => {
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return agentEndResponse(draftHeaderOnly)
            })
            await expect(
                phaseCompose(
                    {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                    'refined',
                    'research',
                    'qa'
                )
            ).rejects.toThrow('compose_invalid')
            // Emphasis retry burned before giving up — two attempts, not one.
            expect(promptsSeen.length).toBe(2)
            // The retry was told what was wrong so it can fix the VERIFY block.
            expect(promptsSeen[1]).toContain('VERIFY block')
        })
    })

    test('a header-only draft recovers when the retry supplies a runnable VERIFY block', async () => {
        await withTmpTaskDir(async cwd => {
            let call = 0
            const spawn = fakeSpawnByPrompt(() => {
                call++
                return agentEndResponse(call === 1 ? draftHeaderOnly : draftRunnable)
            })
            const out = await phaseCompose(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                'qa'
            )
            expect(out).toBe(draftRunnable.trim())
            expect(call).toBe(2)
        })
    })

    test('a first-try draft with a runnable VERIFY block passes without a retry', async () => {
        await withTmpTaskDir(async cwd => {
            let call = 0
            const spawn = fakeSpawnByPrompt(() => {
                call++
                return agentEndResponse(draftRunnable)
            })
            const out = await phaseCompose(
                {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                'qa'
            )
            expect(out).toBe(draftRunnable.trim())
            expect(call).toBe(1)
        })
    })
})

describe('critiqueWithFallback VERIFY-less draft guard', () => {
    const noVerifyDraft = 'GOAL\n  x\n\nCONSTRAINTS\n  - a\n\nACCEPTANCE\n  - b\n\nVERIFY:\n'
    const runnableDraft =
        'GOAL\n  x\n\nCONSTRAINTS\n  - a\n\nACCEPTANCE\n  - b\n\nVERIFY:\n```sh\nnpm test\n```\n'

    const makeP = (spec: string): PhaseContext => ({
        cwd: '',
        id: 'TASK_TEST',
        ctx: stubCtx,
        widgetState: stubWidgetState,
        rawPrompt: '',
        refined: 'refined',
        research: '',
        qa: 'qa',
        spec
    })

    test('re-throws no_verify_block instead of shipping a compose draft that also lacks a VERIFY block', async () => {
        await withTmpTaskDir(async cwd => {
            // Every child (triage is skipped for a VERIFY-less draft; the rewrite
            // then runs) returns a draft with no fenced VERIFY, so phaseCritique
            // throws no_verify_block. The compose draft (p.spec) also lacks one,
            // so falling back to it would persist a spec the handoff gate rejects
            // and resume can't heal — the guard must re-throw.
            const spawn = fakeSpawnByPrompt(() => agentEndResponse(noVerifyDraft))
            const deps = {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn}
            await expect(critiqueWithFallback(deps, makeP(noVerifyDraft))).rejects.toThrow(
                'no_verify_block'
            )
        })
    })

    test('falls back to the compose draft when that draft carries a runnable VERIFY block', async () => {
        await withTmpTaskDir(async cwd => {
            // The rewrite keeps failing to emit a VERIFY block, but the compose
            // draft has one — so the fallback is safe and returns it verbatim.
            const spawn = fakeSpawnByPrompt(() => agentEndResponse(noVerifyDraft))
            const deps = {cwd, taskId: 'TASK_TEST', signal: new AbortController().signal, spawn}
            const out = await critiqueWithFallback(deps, makeP(runnableDraft))
            expect(out).toBe(runnableDraft)
        })
    })
})

describe('phaseResearch service enrichment', () => {
    test('searchFn is called per service from EXTERNAL-DEPENDENCIES section', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const queriesSeen: string[] = []
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'worker-output'}]}
                        ]
                    }
                ]
            }))
            const refined = [
                'GOAL',
                '  do twitch',
                '',
                'EXTERNAL-DEPENDENCIES',
                '  - Twitch  current event subscription API'
            ].join('\n')
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                refined,
                {
                    searchFn: async ({query}) => {
                        queriesSeen.push(query)
                        return {
                            kind: 'ok',
                            results: [
                                {
                                    title: 'EventSub docs',
                                    url: 'https://dev.twitch.tv/docs/eventsub',
                                    description: 'EventSub replaces PubSub'
                                }
                            ]
                        }
                    }
                }
            )
            expect(queriesSeen).toContain('Twitch current event subscription API')
        })
    })

    test('service block appears in worker promptHeader', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            const refined = [
                'EXTERNAL-DEPENDENCIES',
                '  - Twitch  current event subscription API'
            ].join('\n')
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                refined,
                {
                    searchFn: async () => ({
                        kind: 'ok',
                        results: [
                            {
                                title: 'EventSub',
                                url: 'https://dev.twitch.tv/docs/eventsub',
                                description: 'EventSub replaces PubSub'
                            }
                        ]
                    })
                }
            )
            // All 4 workers see the same EXTERNAL CONTEXT prefix.
            for (const p of promptsSeen) {
                expect(p).toContain('### service: Twitch')
                expect(p).toContain('EventSub replaces PubSub')
            }
        })
    })

    test('missing API key emits a single freshness-check skipped block', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            const refined = [
                'EXTERNAL-DEPENDENCIES',
                '  - Twitch  current event subscription API',
                '  - Stripe  webhook signing'
            ].join('\n')
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                refined,
                {
                    searchFn: async () => ({kind: 'no_key', message: 'no key'})
                }
            )
            const headerOccurrences = promptsSeen[0].match(/### freshness-check skipped/g) ?? []
            expect(headerOccurrences.length).toBe(1)
            expect(promptsSeen[0]).toContain('- Twitch')
            expect(promptsSeen[0]).toContain('- Stripe')
            // No per-service block when key is missing.
            expect(promptsSeen[0]).not.toContain('### service: Twitch')
        })
    })

    test('per-service error is dropped silently, others continue', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            const refined = [
                'EXTERNAL-DEPENDENCIES',
                '  - Twitch  current event subscription API',
                '  - Broken  this one errors'
            ].join('\n')
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                refined,
                {
                    searchFn: async ({query}) => {
                        if (query.startsWith('Broken')) {
                            return {kind: 'error', message: 'oops'}
                        }
                        return {
                            kind: 'ok',
                            results: [{title: 'T', url: 'https://t', description: 'd'}]
                        }
                    }
                }
            )
            expect(promptsSeen[0]).toContain('### service: Twitch')
            expect(promptsSeen[0]).not.toContain('### service: Broken')
        })
    })

    test('empty results emit header-only service block', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const promptsSeen: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                promptsSeen.push(args[args.length - 1] as string)
                return {
                    events: [
                        {
                            type: 'agent_end',
                            messages: [
                                {
                                    role: 'assistant',
                                    content: [{type: 'text', text: 'worker-output'}]
                                }
                            ]
                        }
                    ]
                }
            })
            const refined = ['EXTERNAL-DEPENDENCIES', '  - Obscure  no hits expected'].join('\n')
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                refined,
                {searchFn: async () => ({kind: 'ok', results: []})}
            )
            expect(promptsSeen[0]).toContain('### service: Obscure')
            expect(promptsSeen[0]).toContain('Query: Obscure no hits expected')
        })
    })

    test('no services in refined text → searchFn never called', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'worker-output'}]}
                        ]
                    }
                ]
            }))
            let calls = 0
            await phaseResearch(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'GOAL\n  local only\n',
                {
                    searchFn: async () => {
                        calls++
                        return {kind: 'ok', results: []}
                    }
                }
            )
            expect(calls).toBe(0)
        })
    })
})

describe('phaseAutoAnswer service enrichment', () => {
    test('searchFn is called for services found in the question text', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const queriesSeen: string[] = []
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'ANSWER: x'}]}
                        ]
                    }
                ]
            }))
            const question = ['EXTERNAL-DEPENDENCIES', '  - Twitch  current API'].join('\n')
            await phaseAutoAnswer(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                question,
                {
                    searchFn: async ({query}) => {
                        queriesSeen.push(query)
                        return {
                            kind: 'ok',
                            results: [{title: 'T', url: 'https://t', description: 'd'}]
                        }
                    }
                }
            )
            expect(queriesSeen).toContain('Twitch current API')
        })
    })

    test('services have their own cap of 2 independent of pkg+url cap', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            const queriesSeen: string[] = []
            const spawn = fakeSpawnByPrompt(() => ({
                events: [
                    {
                        type: 'agent_end',
                        messages: [
                            {role: 'assistant', content: [{type: 'text', text: 'ANSWER: x'}]}
                        ]
                    }
                ]
            }))
            // 2 packages (fill the existing pkg+url budget of 2) AND 3 services.
            const question = [
                'use `zod` and `ajv`',
                '',
                'EXTERNAL-DEPENDENCIES',
                '  - A  a',
                '  - B  b',
                '  - C  c'
            ].join('\n')
            await phaseAutoAnswer(
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                'refined',
                'research',
                question,
                {
                    // Minimal stub — only the `answer` field is read by the
                    // pkg branch under test. Cast keeps the verbatim plan
                    // intent while satisfying tsc.
                    docsFocused: (async () => ({
                        answer: 'a'
                    })) as unknown as typeof import('../workers/docs-core.js').docsFocused,
                    searchFn: async ({query}) => {
                        queriesSeen.push(query)
                        return {kind: 'ok', results: []}
                    }
                }
            )
            // First 2 services queried; 3rd dropped by the cap.
            expect(queriesSeen.length).toBe(2)
            expect(queriesSeen[0].startsWith('A ')).toBe(true)
            expect(queriesSeen[1].startsWith('B ')).toBe(true)
        })
    })
})

describe('postCommitPhase label generation', () => {
    const longParagraph =
        'Create the database schema and bun:sql setup for ROADSTER — an invite-only used '
        + 'parts marketplace for Mazda MX-5 enthusiasts in Latvia, defining five tables, '
        + 'trigram indexes, and the searchVector generated column exactly as the spec dictates'
    const refined = `GOAL\n${longParagraph}\nCONSTRAINTS\n- follow the spec`

    const refinePhase = {name: 'refine', section: 'refined prompt', field: 'refined'} as PhaseConfig

    function makeCtx(cwd: string, widgetState: WidgetState): PhaseContext {
        return {
            cwd,
            id: 'TASK_0001',
            // postCommitPhase never reads ctx; a stub keeps tsc happy.
            ctx: {} as unknown as ExtensionCommandContext,
            widgetState,
            rawPrompt: '',
            refined: '',
            research: '',
            qa: '',
            spec: ''
        }
    }

    async function seed(cwd: string): Promise<void> {
        await writeTaskFile(
            cwd,
            {
                id: 'TASK_0001',
                state: 'in_progress',
                phase: 'refine',
                created_at: '2026-01-01T00:00:00Z',
                updated_at: '2026-01-01T00:00:00Z',
                title: '(refining…)'
            },
            '\n## raw prompt\n\nx\n'
        )
    }

    test('stores the FULL title plus a compressed label, and updates widget state', async () => {
        await withTmpTaskDir(async cwd => {
            await seed(cwd)
            const widgetState = {
                taskId: 'TASK_0001',
                title: '',
                phase: 'refine',
                startedAt: 0
            } as WidgetState
            const spawn = fakeSpawnByPrompt(() =>
                agentEndResponse('ROADSTER DB schema + bun:sql setup')
            )
            await postCommitPhase(
                refinePhase,
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                makeCtx(cwd, widgetState),
                refined
            )
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            // Full title preserved verbatim — only the label is compressed.
            expect(frontMatter.title).toBe(longParagraph)
            expect(frontMatter.label).toBe('ROADSTER DB schema + bun:sql setup')
            expect(widgetState.title).toBe(longParagraph)
            expect(widgetState.label).toBe('ROADSTER DB schema + bun:sql setup')
        })
    })

    test('still stores the full title and a fallback label when compression fails', async () => {
        await withTmpTaskDir(async cwd => {
            await seed(cwd)
            const widgetState = {
                taskId: 'TASK_0001',
                title: '',
                phase: 'refine',
                startedAt: 0
            } as WidgetState
            const spawn = fakeSpawnByPrompt(() => agentErrorResponse('model died'))
            await postCommitPhase(
                refinePhase,
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                makeCtx(cwd, widgetState),
                refined
            )
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.title).toBe(longParagraph)
            // A label is always present (truncation fallback), never the full title.
            expect(frontMatter.label).toBeDefined()
            expect(frontMatter.label!.length).toBeLessThan(longParagraph.length)
            expect(frontMatter.label!.endsWith('…')).toBe(true)
        })
    })

    test('is a no-op for non-refine phases', async () => {
        await withTmpTaskDir(async cwd => {
            await seed(cwd)
            const widgetState = {
                taskId: 'TASK_0001',
                title: 'unchanged',
                phase: 'grill',
                startedAt: 0
            } as WidgetState
            const grillPhase = {name: 'grill', section: 'grill Q&A', field: 'qa'} as PhaseConfig
            const spawn = fakeSpawnByPrompt(() => agentEndResponse('should not run'))
            await postCommitPhase(
                grillPhase,
                {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
                makeCtx(cwd, widgetState),
                refined
            )
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.title).toBe('(refining…)')
            expect(frontMatter.label).toBeUndefined()
            expect(widgetState.title).toBe('unchanged')
        })
    })
})

// ─── APIS worker: live web search wiring ─────────────────────────────────────

/** Run phaseResearch with a spawn that records each worker's --tools + prompt. */
async function observeResearchWorkers(
    cwd: string
): Promise<Array<{tools: string; prompt: string}>> {
    await writeTaskFile(
        cwd,
        {
            id: 'TASK_0001',
            state: 'in_progress',
            phase: 'research',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            title: 't'
        },
        '\n'
    )
    const observed: Array<{tools: string; prompt: string}> = []
    const spawn: SpawnFn = (_cmd, args) => {
        const argsArr = args as ReadonlyArray<string>
        const toolsIdx = argsArr.indexOf('--tools')
        const proc = makeProc()
        queueMicrotask(() => {
            observed.push({
                tools: toolsIdx === -1 ? '' : argsArr[toolsIdx + 1],
                prompt: proc.stdinData
            })
            proc.stdout!.emit(
                'data',
                Buffer.from(
                    JSON.stringify({
                        type: 'agent_end',
                        messages: [{role: 'assistant', content: [{type: 'text', text: 'out'}]}]
                    }) + '\n'
                )
            )
            proc.emit('close', 0)
        })
        return proc
    }
    await phaseResearch(
        {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
        'plain refined prompt',
        {getFileInventory: async () => ''}
    )
    return observed
}

const apisWorker = (obs: Array<{tools: string; prompt: string}>) =>
    obs.find(o => o.prompt.includes('NPM PACKAGES — use pi-worker-docs'))

test('APIS worker gains search/fetch tools + hint when a Brave key is configured', async () => {
    await withTmpTaskDir(async cwd => {
        const prev = process.env.BRAVE_SEARCH_API_KEY
        const prevProvider = getConfig().searchProvider
        process.env.BRAVE_SEARCH_API_KEY = 'test-key'
        getConfig().searchProvider = 'brave'
        try {
            const obs = await observeResearchWorkers(cwd)
            const apis = apisWorker(obs)
            expect(apis).toBeDefined()
            expect(apis!.tools.split(',')).toContain('pi-worker-search')
            expect(apis!.tools.split(',')).toContain('pi-worker-fetch')
            expect(apis!.prompt).toContain('LIVE WEB — use pi-worker-search')
        } finally {
            if (prev === undefined) delete process.env.BRAVE_SEARCH_API_KEY
            else process.env.BRAVE_SEARCH_API_KEY = prev
            getConfig().searchProvider = prevProvider
        }
    })
})

test('APIS worker has NO search tools with brave selected and no key (the tool would only error)', async () => {
    await withTmpTaskDir(async cwd => {
        const prevA = process.env.BRAVE_SEARCH_API_KEY
        const prevB = process.env.BRAVE_API_KEY
        const prevProvider = getConfig().searchProvider
        delete process.env.BRAVE_SEARCH_API_KEY
        delete process.env.BRAVE_API_KEY
        getConfig().searchProvider = 'brave'
        try {
            const obs = await observeResearchWorkers(cwd)
            const apis = apisWorker(obs)
            expect(apis).toBeDefined()
            expect(apis!.tools).toBe('read,grep,find,ls,pi-worker-docs')
            expect(apis!.prompt).not.toContain('LIVE WEB')
        } finally {
            if (prevA !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevA
            if (prevB !== undefined) process.env.BRAVE_API_KEY = prevB
            getConfig().searchProvider = prevProvider
        }
    })
})

test('APIS worker keeps search tools on a keyless provider without any env key', async () => {
    await withTmpTaskDir(async cwd => {
        const prevA = process.env.BRAVE_SEARCH_API_KEY
        const prevB = process.env.BRAVE_API_KEY
        const prevProvider = getConfig().searchProvider
        delete process.env.BRAVE_SEARCH_API_KEY
        delete process.env.BRAVE_API_KEY
        getConfig().searchProvider = 'exa'
        try {
            const obs = await observeResearchWorkers(cwd)
            const apis = apisWorker(obs)
            expect(apis).toBeDefined()
            expect(apis!.tools.split(',')).toContain('pi-worker-search')
            expect(apis!.prompt).toContain('LIVE WEB — use pi-worker-search')
        } finally {
            if (prevA !== undefined) process.env.BRAVE_SEARCH_API_KEY = prevA
            if (prevB !== undefined) process.env.BRAVE_API_KEY = prevB
            getConfig().searchProvider = prevProvider
        }
    })
})

test('searchConfigured mirrors the search-core contract (keyless providers always on; brave needs a key)', () => {
    expect(searchConfigured(() => undefined, 'brave')).toBe(false)
    expect(searchConfigured(k => (k === 'BRAVE_SEARCH_API_KEY' ? 'x' : undefined), 'brave')).toBe(
        true
    )
    expect(searchConfigured(k => (k === 'BRAVE_API_KEY' ? 'x' : undefined), 'brave')).toBe(true)
    expect(searchConfigured(() => undefined, 'exa')).toBe(true)
    expect(searchConfigured(() => undefined, 'ddg')).toBe(true)
})

describe('empty-vs-failed distinction (issue #10)', () => {
    test('isBareNoneAnswer matches a lone "nothing" token in the shapes workers write', () => {
        for (const s of [
            '(none)',
            'none',
            'N/A',
            'n/a',
            '- none',
            '(no content)',
            '(no entries)',
            '(no response)',
            '  (None.)  '
        ]) {
            expect(isBareNoneAnswer(s)).toBe(true)
        }
    })

    test('isBareNoneAnswer leaves a REASONED non-answer and any real entry alone', () => {
        for (const s of [
            '(no APIs to list — this task creates a plain HTML file with no code symbols)',
            'The directory is empty — no package.json, so there are no verification tools.',
            'package.json  build/lint scripts',
            '- none of the existing routes are touched, but src/app.ts is',
            'none.ts  a file that is actually named none'
        ]) {
            expect(isBareNoneAnswer(s)).toBe(false)
        }
    })

    test('emptySectionBody names the worker and reads as an answer, not an absence', () => {
        const body = emptySectionBody('APIS')
        expect(body).toContain('APIS')
        expect(body).toMatch(/^\(none — /)
        expect(body).toContain('ran and reported no entries')
        // Must not collide with the degraded marker, which means something else.
        expect(body).not.toContain('degraded')
    })
})

describe('extractToolingCommands ignores section markers (issue #10)', () => {
    test('an empty TOOLING section yields no commands, not a marker-shaped one', () => {
        const research = `FILES\nsrc/a.ts  x\n\nTOOLING\n${emptySectionBody('TOOLING')}\n`
        expect(extractToolingCommands(research)).toBeNull()
    })

    test('a degraded TOOLING section still yields its real commands, minus the banner', () => {
        const research =
            'TOOLING\n(degraded: research TOOLING worker timed out; this section may be'
            + ' incomplete)\nlint  bun run lint\n'
        expect(extractToolingCommands(research)).toEqual(['bun run lint'])
    })
})

/**
 * DELIVERY CHECK for the 5B CAP arm's prompt half (see task/research-fanout-budget.ts).
 *
 * The lever is two halves that must agree: the tool refuses past the budget, and the
 * worker is told the number up front. A live A/B cannot see the assembled prompt, and a
 * cap enforced without its notice reads to the worker as a broken tool — so the delivery
 * is proven here, deterministically, instead of being assumed by the harness.
 */
describe('phaseResearch fan-out budget notice (nexttask 5B, UNWIRED)', () => {
    const promptFor = async (
        cwd: string,
        marker: string
    ): Promise<{apis: string; others: string[]}> => {
        const prompts: Array<{isApis: boolean; text: string}> = []
        const spawn = fakeSpawnByPrompt(args => {
            const text = args[args.length - 1] ?? ''
            prompts.push({isApis: text.includes(marker), text})
            return agentEndResponse('- a finding')
        })
        await phaseResearch(
            {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn},
            'a refined goal with no mentions',
            {getFileInventory: async () => ''}
        )
        return {
            apis: prompts.find(p => p.isApis)?.text ?? '',
            others: prompts.filter(p => !p.isApis).map(p => p.text)
        }
    }

    const withTask = async (fn: (cwd: string) => Promise<void>): Promise<void> =>
        withTmpTaskDir(async cwd => {
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'research',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 't'
                },
                '\n'
            )
            await fn(cwd)
        })

    test('OFF by default: no worker prompt mentions a lookup budget', async () => {
        await withTask(async cwd => {
            const {apis, others} = await promptFor(cwd, 'content of an APIS section')
            expect(apis).not.toContain('LOOKUP BUDGET')
            for (const p of others) expect(p).not.toContain('LOOKUP BUDGET')
        })
    })

    test('with the env set, the APIS worker — and only it — is told the number', async () => {
        const saved = process.env[PROJECT_DOCS_BUDGET_ENV]
        process.env[PROJECT_DOCS_BUDGET_ENV] = '20'
        try {
            await withTask(async cwd => {
                const {apis, others} = await promptFor(cwd, 'content of an APIS section')
                expect(apis).toContain(projectDocsBudgetNotice(20))
                // The other three workers have no pi-worker-docs tool at all, so a
                // budget notice there would be an instruction they cannot act on.
                for (const p of others) expect(p).not.toContain('LOOKUP BUDGET')
            })
        } finally {
            if (saved === undefined) delete process.env[PROJECT_DOCS_BUDGET_ENV]
            else process.env[PROJECT_DOCS_BUDGET_ENV] = saved
        }
    })
})

describe('refuted-constraint drop at the compose seam (nexttask 8)', () => {
    const taskMeta = {
        id: 'TASK_0001',
        state: 'in_progress' as const,
        phase: 'compose' as const,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        title: 'scaffold'
    }
    const LEAD_CONSTRAINT =
        '- Add only new entries the task requires (e.g., `hono`, `bun-sql`-equivalent, `argon2`, `sharp`).'
    const LEAD_RESEARCH = [
        'CONTEXT',
        "- Password hashing uses `Bun.password` (built-in argon2id) — no external `argon2` dependency needed despite the task's mention of it.",
        ''
    ].join('\n')
    const refinedText = ['GOAL', 'Scaffold the project.', '', 'CONSTRAINTS', LEAD_CONSTRAINT, ''].join('\n')

    const composePhase = (): PhaseConfig => {
        const p = PHASES.find(x => x.name === 'compose')
        if (!p) throw new Error('compose phase missing')
        return p
    }

    const specReply = [
        'GOAL',
        'Scaffold.',
        '',
        'CONSTRAINTS',
        '- Add `hono` and `sharp`.',
        '',
        'ACCEPTANCE',
        '- deps present',
        '',
        'VERIFY:',
        '```sh',
        'bun test',
        '```'
    ].join('\n')

    test('the drop lands on p.refined, so CRITIQUE sees it too — not just compose', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, taskMeta, '## raw prompt\n\nscaffold\n')
            const prompts: string[] = []
            const spawn = fakeSpawnByPrompt(args => {
                prompts.push(args[args.length - 1] ?? '')
                return agentEndResponse(specReply)
            })
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const pc = {
                cwd,
                id: 'TASK_0001',
                ctx: {} as ExtensionCommandContext,
                widgetState: {} as WidgetState,
                rawPrompt: 'scaffold',
                refined: refinedText,
                research: LEAD_RESEARCH,
                qa: '(no questions produced)',
                spec: ''
            } as PhaseContext

            await composePhase().run(deps as never, pc)

            // The context's refined task no longer requires the refuted token —
            // this is what critique is handed as GROUND TRUTH one phase later.
            expect(pc.refined).not.toContain('`argon2`')
            expect(pc.refined).toContain('`hono`')
            expect(pc.refined).toContain('`sharp`')
            // …and the prompt compose actually sent carries that same text, not
            // the original constraint line.
            expect(prompts.some(p => p.includes(pc.refined))).toBe(true)
            expect(prompts.some(p => p.includes(LEAD_CONSTRAINT))).toBe(false)
        })
    })

    test('the drop is recorded on the gates trail with both source lines', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, taskMeta, '## raw prompt\n\nscaffold\n')
            const spawn = fakeSpawnByPrompt(() => agentEndResponse(specReply))
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const pc = {
                cwd,
                id: 'TASK_0001',
                ctx: {} as ExtensionCommandContext,
                widgetState: {} as WidgetState,
                rawPrompt: 'scaffold',
                refined: refinedText,
                research: LEAD_RESEARCH,
                qa: '(no questions produced)',
                spec: ''
            } as PhaseContext

            await composePhase().run(deps as never, pc)

            const gates = await readSection(cwd, 'TASK_0001', 'gates')
            expect(gates).toContain("constraint refuted by research — dropped 'argon2' from CONSTRAINTS")
            expect(gates).toContain('| constraint: "')
            expect(gates).toContain('no external `argon2` dependency needed')
        })
    })

    test('no refutation ⇒ the refined task reaches compose untouched', async () => {
        await withTmpTaskDir(async cwd => {
            await writeTaskFile(cwd, taskMeta, '## raw prompt\n\nscaffold\n')
            const spawn = fakeSpawnByPrompt(() => agentEndResponse(specReply))
            const deps = {cwd, taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
            const pc = {
                cwd,
                id: 'TASK_0001',
                ctx: {} as ExtensionCommandContext,
                widgetState: {} as WidgetState,
                rawPrompt: 'scaffold',
                refined: refinedText,
                research: 'CONTEXT\n- `package.json` pins `hono` at 4.12.27.\n',
                qa: '(no questions produced)',
                spec: ''
            } as PhaseContext

            await composePhase().run(deps as never, pc)

            expect(pc.refined).toBe(refinedText)
            expect(await readSection(cwd, 'TASK_0001', 'gates')).toBeNull()
        })
    })
})
