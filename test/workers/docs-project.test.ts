import {test, expect, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {projectDocsRaw, buildProjectPrompt, getProjectName} from '../../src/workers/docs-project.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {abstentionSentence, isAbstention} from '../../src/workers/abstention.js'

/**
 * docs-project.ts had NO test file. It could not easily have one: `getProjectFiles`
 * shelled out to a real `git ls-files` with no injection, so any test of the
 * project path needed a real temp directory, real files, and a machine with git
 * where the temp dir was not itself inside a repo. `listFiles` is now injectable.
 *
 * The files still have to EXIST — indexing reads them — but they are ordinary
 * files in a temp dir, with no repo and no git binary involved.
 */
function withFiles<T>(files: Record<string, string>, fn: (cwd: string, abs: string[]) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-project-'))
    const abs: string[] = []
    try {
        for (const [rel, content] of Object.entries(files)) {
            const full = path.join(dir, rel)
            fs.mkdirSync(path.dirname(full), {recursive: true})
            fs.writeFileSync(full, content)
            abs.push(full)
        }
        return fn(dir, abs)
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

describe('projectDocsRaw', () => {
    test('indexes the supplied files and retrieves a matching chunk', () => {
        withFiles(
            {'src/auth.ts': 'export function signInWithPassword(email: string) {}\n'},
            (cwd, abs) => {
                const cache = openCache(':memory:')
                const r = projectDocsRaw(cache, cwd, 'sign in with password', undefined, () => abs)
                expect(r.kind).toBe('ok')
                if (r.kind !== 'ok') return
                expect(r.filesIngested).toBe(1)
                expect(r.chunks.length).toBeGreaterThan(0)
                expect(r.chunks.map(c => c.content).join('')).toContain('signInWithPassword')
            }
        )
    })

    test('a project with no source files is no_chunks, not an error', () => {
        withFiles({'README.md': '# hi\n'}, cwd => {
            const cache = openCache(':memory:')
            const r = projectDocsRaw(cache, cwd, 'anything', undefined, () => [])
            expect(r.kind).toBe('no_chunks')
        })
    })

    test('files that vanish between listing and reading are skipped, not fatal', () => {
        withFiles({'src/a.ts': 'export const a = 1\n'}, (cwd, abs) => {
            const cache = openCache(':memory:')
            const r = projectDocsRaw(cache, cwd, 'a', undefined, () => [
                ...abs,
                path.join(cwd, 'src/gone.ts')
            ])
            expect(r.kind).toBe('ok')
            if (r.kind === 'ok') expect(r.filesIngested).toBe(1)
        })
    })

    test('a retrieval fault degrades to error rather than throwing at the caller', () => {
        withFiles({'src/a.ts': 'export const a = 1\n'}, (cwd, abs) => {
            const cache = openCache(':memory:')
            const r = projectDocsRaw(
                cache,
                cwd,
                'a',
                () => {
                    throw new Error('fts5 exploded')
                },
                () => abs
            )
            expect(r.kind).toBe('error')
            if (r.kind === 'error') expect(r.message).toContain('fts5 exploded')
        })
    })

    test('a re-index with unchanged files hits the cache', () => {
        withFiles({'src/a.ts': 'export const a = 1\n'}, (cwd, abs) => {
            const cache = openCache(':memory:')
            projectDocsRaw(cache, cwd, 'a', undefined, () => abs)
            const second = projectDocsRaw(cache, cwd, 'a', undefined, () => abs)
            expect(second.kind).toBe('ok')
            if (second.kind === 'ok') expect(second.hitCache).toBe(true)
        })
    })
})

describe('getProjectName', () => {
    test('prefers the package.json name', () => {
        withFiles({'package.json': '{"name": "my-app"}'}, cwd => {
            expect(getProjectName(cwd)).toBe('my-app')
        })
    })

    test('falls back to the directory name when package.json is absent or broken', () => {
        withFiles({'package.json': 'not json'}, cwd => {
            expect(getProjectName(cwd)).toBe(path.basename(cwd))
        })
    })
})

test('the project prompt instructs the abstention the host actually recognises', () => {
    const p = buildProjectPrompt('my-app', 'how do I log in?', 'export function login() {}')
    expect(p).toContain(abstentionSentence('project'))
    expect(isAbstention(abstentionSentence('project'))).toBe(true)
    // The content tag is referenced by three separate rules; they must agree.
    expect(p).toContain('<project-content>')
    expect(p.match(/<project-content>/g)?.length).toBeGreaterThan(1)
})
