/**
 * The grammar table is the point. Twenty-four hand-written `section()` copies
 * disagreed on all of these cases, and no test anywhere covered any of them.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    declaredPackages,
    findCorpusFiles,
    openPools,
    openRecordedRun,
    readOnlyGit,
    readSection
} from './ab-corpus.js'

const DOC = [
    '# TASK_0001',
    '',
    '## raw prompt',
    'Wire the dev build pipeline.',
    '',
    '## spec',
    'GOAL',
    '  do the thing',
    '',
    '## empty section',
    '',
    '## handoff',
    'done'
].join('\n')

describe('readSection — one grammar', () => {
    test('finds a section and stops at the next heading', () => {
        expect(readSection(DOC, 'spec')).toBe('GOAL\n  do the thing')
    })

    test('reads the last section to end of document', () => {
        expect(readSection(DOC, 'handoff')).toBe('done')
    })

    test('a MISSING section is undefined, an EMPTY one is the empty string', () => {
        // The distinction eleven harnesses could not make. Scoring a corpus that was
        // never written as "zero findings" is the false pass this whole module is
        // arranged around.
        expect(readSection(DOC, 'research')).toBeUndefined()
        expect(readSection(DOC, 'empty section')).toBe('')
    })

    test('the heading match is case-insensitive', () => {
        // Two of the six old dialects were case-sensitive on a single literal space,
        // so `## Spec` silently yielded nothing in five harnesses.
        for (const doc of ['## SPEC\nbody', '## Spec\nbody', '## spec\nbody']) {
            expect(readSection(doc, 'spec')).toBe('body')
        }
    })

    test('spacing after ## does not matter', () => {
        expect(readSection('##  spec\nbody', 'spec')).toBe('body')
        expect(readSection('##\tspec\nbody', 'spec')).toBe('body')
    })

    test('a name is matched whole, not as a prefix', () => {
        expect(readSection('## spec details\nbody', 'spec')).toBeUndefined()
    })

    test('regex metacharacters in a name are literal', () => {
        expect(readSection('## grill Q&A\nbody', 'grill Q&A')).toBe('body')
        expect(readSection('## a.b\nbody', 'a.b')).toBe('body')
        expect(readSection('## a.b\nbody', 'axb')).toBeUndefined()
    })

    test('it never throws — the failure mode four harnesses had', () => {
        expect(() => readSection('', 'spec')).not.toThrow()
        expect(readSection('', 'spec')).toBeUndefined()
        expect(readSection('no headings at all', 'spec')).toBeUndefined()
    })

    test('a deeper heading does not terminate a section', () => {
        expect(readSection('## spec\na\n### sub\nb\n## next\nc', 'spec')).toBe('a\n### sub\nb')
    })
})

describe('openRecordedRun', () => {
    let root = ''
    let empty = ''

    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), 'ab-corpus-'))
        mkdirSync(path.join(root, 'run', '.pi-tasks'), {recursive: true})
        writeFileSync(path.join(root, 'run', '.pi-tasks', 'TASK_0002.md'), DOC)
        writeFileSync(
            path.join(root, 'run', '.pi-tasks', 'TASK_0001.md'),
            DOC.replace('TASK_0001', 'TASK_0001')
        )
        writeFileSync(path.join(root, 'run', '.pi-tasks', 'notes.md'), 'ignored')
        writeFileSync(path.join(root, 'run', '.pi-tasks', 'requirements-owned.md'), 'OWNED: "x"')
        writeFileSync(
            path.join(root, 'run', 'package.json'),
            JSON.stringify({dependencies: {hono: '4'}, devDependencies: {typescript: '5'}})
        )
        empty = path.join(root, 'no-corpus')
        mkdirSync(empty, {recursive: true})
    })
    afterAll(() => {
        if (root !== '') rmSync(root, {recursive: true, force: true})
    })

    test('a tree with no .pi-tasks is null, not an empty run', () => {
        // Null is the caller's cue to ABSTAIN. An empty run would reach a scorer
        // looking exactly like a corpus that produced no findings.
        expect(openRecordedRun(empty)).toBeNull()
        expect(openRecordedRun(path.join(root, 'does-not-exist'))).toBeNull()
    })

    test('tasks are the TASK_NNNN files, sorted, and nothing else', () => {
        const run = openRecordedRun(path.join(root, 'run'))!
        expect(run.tasks().map(t => t.id)).toEqual(['TASK_0001', 'TASK_0002'])
    })

    test('a task carries its own section reader', () => {
        const run = openRecordedRun(path.join(root, 'run'))!
        const t = run.tasks()[0]!
        expect(t.section('spec')).toBe('GOAL\n  do the thing')
        expect(t.section('research')).toBeUndefined()
    })

    test('ledgers are undefined when absent, never empty strings', () => {
        const run = openRecordedRun(path.join(root, 'run'))!
        expect(run.ownedLedger()).toBe('OWNED: "x"')
        expect(run.acceptDebt()).toBeUndefined()
    })

    test('packages reads both dependency maps', () => {
        const run = openRecordedRun(path.join(root, 'run'))!
        expect(run.packages().sort()).toEqual(['hono', 'typescript'])
    })

    test('the label defaults to the directory name and can be overridden for a pin', () => {
        expect(openRecordedRun(path.join(root, 'run'))!.label).toBe('run')
        expect(openRecordedRun(path.join(root, 'run'), 'mx5@5138b30')!.label).toBe('mx5@5138b30')
    })
})

describe('declaredPackages', () => {
    let dir = ''
    beforeAll(() => {
        dir = mkdtempSync(path.join(os.tmpdir(), 'ab-corpus-pkg-'))
    })
    afterAll(() => {
        if (dir !== '') rmSync(dir, {recursive: true, force: true})
    })

    test('a malformed or missing package.json is no packages, not a throw', () => {
        expect(declaredPackages(dir)).toEqual([])
        writeFileSync(path.join(dir, 'package.json'), '{not json')
        expect(declaredPackages(dir)).toEqual([])
        writeFileSync(path.join(dir, 'package.json'), '"a string"')
        expect(declaredPackages(dir)).toEqual([])
    })
})

describe('findCorpusFiles', () => {
    let root = ''
    beforeAll(() => {
        root = mkdtempSync(path.join(os.tmpdir(), 'ab-corpus-find-'))
        for (const p of ['a', 'b/nested']) {
            mkdirSync(path.join(root, p, '.pi-tasks'), {recursive: true})
            writeFileSync(path.join(root, p, '.pi-tasks', 'accept-debt.md'), 'debt')
        }
        mkdirSync(path.join(root, 'node_modules', 'x', '.pi-tasks'), {recursive: true})
        writeFileSync(path.join(root, 'node_modules', 'x', '.pi-tasks', 'accept-debt.md'), 'no')
        mkdirSync(path.join(root, 'c', '.pi-tasks'), {recursive: true})
    })
    afterAll(() => {
        if (root !== '') rmSync(root, {recursive: true, force: true})
    })

    test('finds nested ledgers and skips node_modules', () => {
        const found = findCorpusFiles(root, 'accept-debt.md')
        expect(found).toHaveLength(2)
        expect(found.some(f => f.includes('node_modules'))).toBe(false)
    })

    test('a .pi-tasks without the named file is not a hit', () => {
        expect(findCorpusFiles(root, 'accept-debt.md').some(f => f.includes(`${path.sep}c${path.sep}`))).toBe(
            false
        )
    })

    test('depth is bounded', () => {
        expect(findCorpusFiles(root, 'accept-debt.md', 0)).toHaveLength(0)
    })

    test('an unreadable root is empty, not a throw', () => {
        expect(findCorpusFiles(path.join(root, 'nope'), 'accept-debt.md')).toEqual([])
    })
})

describe('openPools', () => {
    test('absent pools are skipped, not returned as empty runs', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'ab-corpus-pools-'))
        mkdirSync(path.join(root, 'mx5', '.pi-tasks'), {recursive: true})
        const runs = openPools(root, ['mx5', 'gofer-pixel', 'IAR1'])
        expect(runs.map(r => r.label)).toEqual(['mx5'])
        rmSync(root, {recursive: true, force: true})
    })
})

describe('readOnlyGit', () => {
    test('a non-repo is a non-zero exit, never a throw', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-corpus-git-'))
        const r = readOnlyGit(dir, ['rev-parse', '--show-toplevel'])
        expect(r.exitCode).not.toBe(0)
        expect(typeof r.stdout).toBe('string')
        rmSync(dir, {recursive: true, force: true})
    })

    test('it reports this repo, and the shape matches makeGit', () => {
        const r = readOnlyGit(path.resolve(import.meta.dir, '..'), ['rev-parse', '--is-inside-work-tree'])
        expect(r.exitCode).toBe(0)
        expect(r.stdout.trim()).toBe('true')
    })
})
