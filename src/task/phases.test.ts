import {describe, expect, test} from 'bun:test'
import {
    extractToolingCommands,
    replaceToolingWithVerified,
    phaseResearch,
    phaseAutoAnswer,
    phaseGrill,
    phaseCritique
} from './phases.js'
import {parseVerifyToolingOutput} from './parsers.js'
import {
    agentEndResponse,
    fakeSpawnByPrompt,
    fakeSpawnQueue,
    makeProc
} from '../test-utils/fake-spawn.js'
import type {SpawnFn} from '../shared/child-process.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {writeTaskFile} from './task-io.js'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {WidgetState} from './widget.js'
import {getBridge, answerPrompt} from '../remote/bridge.js'
import {getState, _setSink, reset} from '../remote/session-state.js'

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
                observed.push({
                    tools: argsArr[toolsIdx + 1],
                    prompt: argsArr[argsArr.length - 1]
                })
                const proc = makeProc()
                queueMicrotask(() => {
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
                return agentEndResponse('worker-output')
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
                return agentEndResponse('worker-output')
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
                return agentEndResponse('worker-output')
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
                        'This is a concrete implementation decision. Here\'s the analysis:'
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

            const spawn: SpawnFn = (_cmd: string, args: ReadonlyArray<string>) => {
                const proc = makeProc()
                const prompt = args[args.length - 1]
                const isAuto = prompt.includes('pre-answering a clarifying question')
                const isGen = prompt.includes('preparing clarifying questions')
                if (isGen) genPrompts.push(prompt)

                queueMicrotask(() => {
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

    test('two-option grill: picking A/B in the select picker stores that option, not the label', async () => {
        // The binary fork renders as a select() picker labelled "A:" / "B:".
        // Records must store the chosen option's full text so the next grill-gen
        // call can reason over it — storing the bare "A" (or the "A: " label)
        // would leave a dangling reference the model can't decode.
        const pickIndex = (idx: number) =>
            ({
                hasUI: true,
                ui: {
                    theme: {fg: (_: string, s: string) => s, bold: (s: string) => s},
                    select: async (_t: string, options: string[]) => options[idx],
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

    test('triage runs tool-less (--no-tools), the rewrite keeps read access', async () => {
        await withTmpTaskDir(async cwd => {
            const observed: Array<{argv: ReadonlyArray<string>; prompt: string}> = []
            const spawn: SpawnFn = (_cmd, args) => {
                const argv = args as ReadonlyArray<string>
                const prompt = argv[argv.length - 1]
                observed.push({argv, prompt})
                const proc = makeProc()
                queueMicrotask(() => {
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
