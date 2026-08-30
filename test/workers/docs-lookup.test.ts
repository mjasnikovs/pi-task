/**
 * The docs tail: concatenate → extract → verify → format.
 *
 * One implementation, `docsLookup`. `pi-worker-docs` runs it for both its arms —
 * only the CORPUS differs — and `docs-core`'s `docsFocused` runs it for the
 * package one. So a property proven here holds for every docs answer.
 */
import {describe, expect, test} from 'bun:test'
import {docsLookup, type DocsCorpus} from '../../src/workers/docs-lookup.js'
import {packageCorpus} from '../../src/workers/docs-core.js'
import {projectCorpus} from '../../src/workers/docs-project.js'
import type {SpawnFn} from '../../src/shared/child-process.js'
import {EventEmitter} from 'node:events'

/** A child that answers with `<answer>`/`<excerpt>`, capturing its prompt. */
function fakeChild(
    body: string,
    exitCode = 0
): {spawn: SpawnFn; prompts: string[]; thinking: string[][]} {
    const prompts: string[] = []
    const thinking: string[][] = []
    const spawn = ((_cmd: string, args: readonly string[]) => {
        const idx = args.indexOf('--thinking')
        thinking.push(idx === -1 ? [] : [args[idx]!, args[idx + 1]!])
        const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
        const stdout = new EventEmitter()
        const stderr = new EventEmitter()
        proc.stdout = stdout
        proc.stderr = stderr
        proc.stdin = {
            write: (d: string) => prompts.push(d),
            end: () => {},
            on: () => {}
        }
        proc.kill = () => true
        queueMicrotask(() => {
            stdout.emit('data', Buffer.from(body))
            proc.emit('close', exitCode)
        })
        return proc
    }) as unknown as SpawnFn
    return {spawn, prompts, thinking}
}

const CHUNKS = [{content: 'export function greet(name: string): string'}, {content: 'README body'}]

const run = (corpus: DocsCorpus, child: ReturnType<typeof fakeChild>) =>
    docsLookup({
        corpus,
        chunks: CHUNKS,
        query: 'what does greet return?',
        cwd: process.cwd(),
        spawn: child.spawn,
        thinking: ['--thinking', 'off']
    })

const PKG = {
    name: 'greeter',
    version: '1.2.3',
    root: '/x/greeter',
    entryDts: null,
    readme: null
}

describe('the shared tail', () => {
    test('prompts with the concatenated chunks, and verifies against that same text', async () => {
        const child = fakeChild(
            '<answer>It returns a greeting string.</answer>'
                + '<excerpt>export function greet(name: string): string</excerpt>'
        )
        const r = await run(packageCorpus(PKG), child)

        expect(r.kind).toBe('answer')
        if (r.kind !== 'answer') return
        // The join is the contract: an excerpt verified against a SUBSET of what
        // was prompted with is how a citation check goes quietly false.
        expect(r.content).toBe(`${CHUNKS[0]!.content}\n\n${CHUNKS[1]!.content}`)
        expect(child.prompts[0]).toContain(CHUNKS[0]!.content)
        expect(child.prompts[0]).toContain(CHUNKS[1]!.content)
        expect(r.excerptVerified).toBe(true)
    })

    test('an unverifiable excerpt is reported, not hidden', async () => {
        const child = fakeChild(
            '<answer>It returns a number.</answer><excerpt>function greet(): number</excerpt>'
        )
        const r = await run(packageCorpus(PKG), child)

        expect(r.kind).toBe('answer')
        if (r.kind !== 'answer') return
        expect(r.excerptVerified).toBe(false)
    })

    test('a dead child is a failure, carrying its own evidence', async () => {
        const child = fakeChild('', 1)
        const r = await run(packageCorpus(PKG), child)

        expect(r.kind).toBe('failed')
        if (r.kind !== 'failed') return
        expect(r.extraction.exitCode).toBe(1)
        expect(r.extraction.failure.length).toBeGreaterThan(0)
    })

    test('the caller decides the thinking level; the lookup never reads config', async () => {
        const child = fakeChild('<answer>a</answer><excerpt>README body</excerpt>')
        await run(packageCorpus(PKG), child)

        expect(child.thinking[0]).toEqual(['--thinking', 'off'])
    })
})

describe('the two corpora differ only where they should', () => {
    test('each names itself in the answer header', async () => {
        const pkgChild = fakeChild('<answer>a</answer><excerpt>README body</excerpt>')
        const projChild = fakeChild('<answer>a</answer><excerpt>README body</excerpt>')

        const pkg = await run(packageCorpus(PKG), pkgChild)
        const proj = await run(projCorpusFor('pi-task'), projChild)

        expect(pkg.kind).toBe('answer')
        expect(proj.kind).toBe('answer')
        if (pkg.kind !== 'answer' || proj.kind !== 'answer') return
        expect(pkg.body).toContain('greeter@1.2.3')
        // A project-source citation must be distinguishable from a package one at
        // a glance: they are read and cited alike and mean very different things.
        expect(proj.body).toContain('pi-task (project source)')
        expect(proj.body).not.toContain('greeter')
    })

    test('each names itself when the run is aborted', () => {
        expect(packageCorpus(PKG).abortedMessage).toBe('Docs lookup aborted.')
        expect(projCorpusFor('pi-task').abortedMessage).toBe('Project docs lookup aborted.')
    })

    test('the ids are the abstention kinds the prompts already use', () => {
        expect(packageCorpus(PKG).id).toBe('package')
        expect(projCorpusFor('pi-task').id).toBe('project')
    })
})

function projCorpusFor(name: string): DocsCorpus {
    return projectCorpus(name)
}
