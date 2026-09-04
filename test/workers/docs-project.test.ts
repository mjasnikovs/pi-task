import {test, expect, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    projectDocsRaw,
    buildProjectPrompt,
    getProjectName,
    getProjectFiles
} from '../../src/workers/docs-project.js'
import {openCache} from '../../src/workers/docs-cache.js'
import {abstentionSentence, isAbstention} from '../../src/workers/abstention.js'

/**
 * `projectDocsRaw` takes `listFiles` as a parameter, defaulting to
 * `getProjectFiles` (which shells out to `git ls-files`). A test injects its own
 * list instead, so no repo and no git binary are involved.
 *
 * The files still have to EXIST — indexing reads them — but they are ordinary
 * files in a temp dir.
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
    // Beyond the wrapper itself, the tag is named by the output-shape template
    // and by two of the numbered rules; all of them must spell it the same way.
    expect(p).toContain('<project-content>')
    expect(p.match(/<project-content>/g)?.length).toBeGreaterThan(1)
})

test('the project walk skips a cargo target/ and a cabal dist-newstyle/', () => {
    // Build output is not project source. `git ls-files` never lists it, but the
    // fallback walk is what runs outside a repo — and it only knew npm's skips.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-project-skip-'))
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n', 'utf8')
    fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), 'pub fn a() {}', 'utf8')
    fs.mkdirSync(path.join(dir, 'target', 'debug'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'target', 'debug', 'build.rs'), 'fn main() {}', 'utf8')

    const files = getProjectFiles(dir).map(f => path.relative(dir, f).replace(/\\/g, '/'))
    expect(files).toContain('src/lib.rs')
    expect(files.some(f => f.startsWith('target/'))).toBe(false)
    fs.rmSync(dir, {recursive: true, force: true})
})
