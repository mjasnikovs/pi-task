import {describe, expect, test} from 'bun:test'
import {isDuplicateQuestion, jaccard, tokenizeQuestion} from './question-dedup.js'

// The exact 10 questions /task-auto asked on the real mx5 run (.pi-tasks/
// TASK_AUTO_0001.md). The user's complaint: it kept re-asking the same
// "Bun bundler vs Vite / how to build+serve the SPA" decision. Q2, Q3, Q8 and Q9
// are all that same fork worded differently; Q1/Q4/Q5/Q6/Q7/Q10 are genuinely
// distinct subsystems. This fixture is the ground truth the detector must split.
const Q = [
    /* Q1 */ "Should the search index use the PostgreSQL pg_trgm extension's similarity() function, or should we use a simpler approach like LIKE '%term%' to avoid the extension dependency?",
    /* Q2 */ "Should the Hono app's entry point (src/server/index.ts) also serve the React SPA's index.html as a static catch-all, or should a separate frontend build step produce static assets served by an external tool like Vite dev server in development and nginx/Express in production?",
    /* Q3 */ "Should the React SPA's build and dev workflow use Bun's built-in bundler (esbuild), or should a separate Vite configuration be added?",
    /* Q4 */ 'Should the UI use Shadcn/Radix UI primitives or a lighter custom component set built only on Tailwind + Wouter?',
    /* Q5 */ 'Should the image upload pipeline process/resize images server-side before storing them in PostgreSQL, or store them as raw uploaded blobs?',
    /* Q6 */ "Should the database layer use Bun's built-in bun:sql raw SQL driver, or should an ORM/query builder like Drizzle ORM be added on top?",
    /* Q7 */ 'Should image processing with sharp include automatic JPEG/PNG compression quality tuning in addition to resizing, or just resize without recompression?',
    /* Q8 */ 'How should the React SPA be built and served by Bun without Vite — a single bun index.ts entry that runs the Hono app and compiles .tsx client files at runtime, or a separate build step (bun build src/client/main.tsx --outdir dist/client) with a production serve task for static assets?',
    /* Q9 */ "Should the Hono entry point (src/server/index.ts) load .tsx pages directly at runtime via Bun's bundler in development with HMR, or should ALL .tsx page components be pre-compiled by bun build into dist/client even during development?",
    /* Q10 */ 'Should the image upload endpoint use Multer middleware to parse multipart/form-data in the Hono route handler, or should we implement streaming multipart parsing natively without an external middleware layer?'
]

// Indices (0-based) the user flagged as redundant re-asks of the SPA build/serve
// fork. Each should be caught as a duplicate of an EARLIER question.
const REDUNDANT = [2, 7, 8] // Q3, Q8, Q9
// These open genuinely different decisions and must NOT be suppressed.
const DISTINCT = [0, 3, 4, 5, 9] // Q1, Q4, Q5, Q6, Q10

describe('question-dedup against the real mx5 /task-auto run', () => {
    test('flags the repeated SPA-build/serve questions as duplicates', () => {
        for (const i of REDUNDANT) {
            const prior = Q.slice(0, i)
            expect(isDuplicateQuestion(prior, Q[i])).toBe(true)
        }
    })

    test('does not suppress the genuinely distinct subsystem questions', () => {
        for (const i of DISTINCT) {
            const prior = Q.slice(0, i)
            expect(isDuplicateQuestion(prior, Q[i])).toBe(false)
        }
    })

    test('the very first question is never a duplicate (no prior)', () => {
        expect(isDuplicateQuestion([], Q[0])).toBe(false)
    })
})

describe('tokenizeQuestion / jaccard', () => {
    test('drops markdown, backticks, stopwords and 1-char tokens', () => {
        const t = tokenizeQuestion('**Should** we use `pg_trgm` or LIKE?')
        expect(t.has('pg')).toBe(true)
        expect(t.has('trgm')).toBe(true)
        expect(t.has('should')).toBe(false)
        expect(t.has('we')).toBe(false)
        expect(t.has('use')).toBe(false)
    })

    test('jaccard is 0 against an empty set and 1 for identical sets', () => {
        expect(jaccard(new Set(), new Set(['a']))).toBe(0)
        expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1)
    })
})
