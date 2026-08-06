import {describe, expect, test} from 'bun:test'
import {
    fetchRaw,
    fetchFocused,
    selectContent,
    shippedStrategy,
    normaliseSourceUrl,
    NOT_COVERED_ANSWER,
    UNCLEAR_ANSWER
} from './fetch-core.js'
import {FetchAndCleanError} from './html-clean.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

describe('fetchRaw', () => {
    test('returns markdown/finalUrl/title from injected fetchAndClean', async () => {
        const r = await fetchRaw({
            url: 'https://example.com/',
            fetchAndClean: async () => ({
                markdown: '# Hi\n\nbody',
                finalUrl: 'https://example.com/',
                title: 'Hi'
            })
        })
        expect(r.markdown).toContain('body')
        expect(r.title).toBe('Hi')
        expect(r.finalUrl).toBe('https://example.com/')
    })

    test('propagates FetchAndCleanError', async () => {
        await expect(
            fetchRaw({
                url: 'https://example.com/',
                fetchAndClean: async () => {
                    throw new FetchAndCleanError('too big', 'too-large')
                }
            })
        ).rejects.toBeInstanceOf(FetchAndCleanError)
    })
})

describe('normaliseSourceUrl', () => {
    test('rewrites a github blob URL to raw.githubusercontent.com', () => {
        expect(
            normaliseSourceUrl(
                'https://github.com/shadcn-ui/ui/blob/main/apps/v4/registry/new-york-v4/ui/button.tsx'
            )
        ).toBe(
            'https://raw.githubusercontent.com/shadcn-ui/ui/main/apps/v4/registry/new-york-v4/ui/button.tsx'
        )
    })

    test('keeps a ref that contains slashes, and drops viewer-only query params', () => {
        expect(normaliseSourceUrl('https://github.com/o/r/blob/release/1.x/src/a.ts?plain=1')).toBe(
            'https://raw.githubusercontent.com/o/r/release/1.x/src/a.ts'
        )
    })

    test('leaves every non-blob URL byte-identical', () => {
        for (const u of [
            'https://raw.githubusercontent.com/o/r/main/a.ts',
            'https://github.com/honojs/hono/issues/3148',
            'https://github.com/o/r/tree/main/src',
            'https://github.com/o/r',
            'https://gist.github.com/o/deadbeef',
            'https://hono.dev/docs/guides/rpc',
            'https://example.com/blob/main/x.ts',
            // `/blob/{ref}` with no file path names no file — nothing to rewrite.
            'https://github.com/o/r/blob/main'
        ]) {
            expect(normaliseSourceUrl(u)).toBe(u)
        }
    })

    test('the rewritten URL is what gets fetched, while the caller keeps the original', async () => {
        let requested = ''
        const r = await fetchFocused({
            url: 'https://github.com/o/r/blob/main/a.ts',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async (url: string) => {
                requested = url
                return {markdown: 'export const a = 1', finalUrl: url, title: 'a.ts'}
            },
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>a is 1</answer>\n<excerpt>export const a = 1</excerpt>'
            }))
        })
        expect(requested).toBe('https://raw.githubusercontent.com/o/r/main/a.ts')
        expect(r.excerptVerified).toBe(true)
    })
})

describe('fetchFocused', () => {
    test('returns parsed answer + excerpt on success', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: '# title\n\nThe key fact.',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>The key fact.</answer>\n<excerpt>The key fact.</excerpt>'
            }))
        })
        expect(r.answer).toBe('The key fact.')
        expect(r.excerpt).toBe('The key fact.')
        expect(r.excerptVerified).toBe(true)
    })

    test('flags excerptVerified false when excerpt is fabricated', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'unrelated',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>x</answer>\n<excerpt>fabricated</excerpt>'
            }))
        })
        expect(r.excerptVerified).toBe(false)
    })

    test('sets coverageMiss when the child reports the page does not cover the topic', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'This page is about version 2.0 only.',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: `<answer>${NOT_COVERED_ANSWER}</answer>\n<excerpt>This page is about version 2.0 only.</excerpt>`
            }))
        })
        expect(r.coverageMiss).toBe(true)
        // A coverage miss is a distinct outcome, NOT the ambiguity fallback.
        expect(r.answer.includes(UNCLEAR_ANSWER)).toBe(false)
        // 14B: the miss carries the next step, not just the verdict.
        expect(r.nextStep).toContain('do not re-read it')
        expect(r.nextStep).toContain('https://example.com/')
    })

    test('a coverage miss on a rewritten blob URL names the page that was actually read', async () => {
        const r = await fetchFocused({
            url: 'https://github.com/o/r/blob/main/a.ts',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async (url: string) => ({
                markdown: 'a different file',
                finalUrl: url,
                title: 'a.ts'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: `<answer>${NOT_COVERED_ANSWER}</answer>\n<excerpt>a different file</excerpt>`
            }))
        })
        expect(r.nextStep).toContain('https://raw.githubusercontent.com/o/r/main/a.ts')
        expect(r.nextStep).toContain('returns exactly this')
    })

    test('an answered fetch carries no next step', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'The key fact.',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>The key fact.</answer>\n<excerpt>The key fact.</excerpt>'
            }))
        })
        expect(r.nextStep).toBeUndefined()
    })

    test('coverageMiss is false when a sourced answer merely mentions the sentinel wording', async () => {
        const answer =
            'The `audio_convert_info` struct contains four fields. The functions '
            + '`obs_add_raw_audio_callback` and `obs_remove_raw_audio_callback` are not covered by this page.'
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'struct audio_convert_info',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: `<answer>${answer}</answer>\n<excerpt>struct audio_convert_info</excerpt>`
            }))
        })
        expect(r.coverageMiss).toBe(false)
    })

    test('coverageMiss is false for an ordinary sourced answer', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'The key fact.',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>The key fact.</answer>\n<excerpt>The key fact.</excerpt>'
            }))
        })
        expect(r.coverageMiss).toBe(false)
    })

    test('retains excerptCheck diagnostics so a false verification is attributable', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'real content here',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>x</answer>\n<excerpt>fabricated</excerpt>'
            }))
        })
        expect(r.excerptVerified).toBe(false)
        expect(r.excerptCheck?.verified).toBe(false)
        expect(r.excerptCheck?.normalisedExcerpt).toBe('fabricated')
        expect(r.excerptCheck?.contentLength).toBe('real content here'.length)
        expect(r.excerptCheck?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    })

    test('anchors a #fragment section past the head window, and reports which section', async () => {
        // A page whose relevant section sits far past HEAD_CHARS (25k). Without fragment
        // anchoring the head-truncation drops it; with it, the child sees the section.
        const filler = 'x'.repeat(40_000)
        const md =
            `# Intro\n\nintro text\n${filler}\n`
            + `## setInputFiles[](#the-target "Direct link")\n\nUpload files: pass {buffer, name, mimeType}.\n\n`
            + `## next[](#next)\n\nunrelated`
        let sawPrompt = ''
        const r = await fetchFocused({
            url: 'https://example.com/page#the-target',
            query: 'how to pass files',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: md,
                finalUrl: 'https://example.com/page',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(args => {
                sawPrompt = args[args.length - 1]
                return {
                    stdout: '<answer>pass {buffer, name, mimeType}</answer>\n<excerpt>Upload files: pass {buffer, name, mimeType}.</excerpt>'
                }
            })
        })
        expect(r.anchoredSection).toBe('the-target')
        expect(sawPrompt).toContain('Upload files: pass {buffer, name, mimeType}')
        expect(sawPrompt).toContain('#the-target')
        // The unrelated following section is NOT dragged in.
        expect(sawPrompt).not.toContain('unrelated')
        // Excerpt still verifies against the FULL page.
        expect(r.excerptVerified).toBe(true)
    })

    test('selectContent falls back to truncation when the fragment names no heading', () => {
        const md = '# Only Heading[​](#only)\n\nbody'
        const sel = selectContent(md, 'https://example.com/#does-not-exist')
        expect(sel.section).toBeUndefined()
        expect(sel.content).toContain('body')
    })

    test('selectContent does not match a prefix fragment (#foo != #foobar)', () => {
        const md = '# A[](#foobar)\n\nbar section\n\n# B[](#other)\n\nother'
        expect(selectContent(md, 'https://x/#foo').section).toBeUndefined()
        expect(selectContent(md, 'https://x/#foobar').section).toBe('foobar')
    })

    test('recalibrated prompt tells the child to answer partial content and use a distinct coverage miss', () => {
        const prompt = shippedStrategy.buildPrompt({query: 'q', url: 'u', title: 't', content: 'c'})
        expect(prompt).toContain('INCLUDING a partial')
        expect(prompt).toContain(NOT_COVERED_ANSWER)
        expect(prompt).toContain(UNCLEAR_ANSWER)
        // The pre-change rule 5 ("unclear ... or absent") must be gone — absence now routes to
        // the coverage-miss channel, not to the ambiguity fallback.
        expect(prompt).not.toContain('unclear, ambiguous, or absent')
    })

    test('surfaces non-zero exitCode when child fails', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'x',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1, stderr: 'oops'}))
        })
        expect(r.childExitCode).toBe(1)
        expect(r.answer).toBe('')
    })
})
