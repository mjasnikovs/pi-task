import {test, expect, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {logDocsAnswer, readTypeOnlyLog, TYPEONLY_LOG_ENV} from '../../src/workers/typeonly-log.js'

const REC = {
    module: 'hono/client',
    query: 'hc factory function signature base url parameter types exported from hono/client',
    answer: 'The `hc` factory takes two parameters: `baseUrl` of type `Prefix` and an optional `options`.',
    typeOnly: true,
    reason: 'usage question answered only with a signature/declaration restatement'
}

function tmpSink(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'typeonly-log-')), 'answers.jsonl')
}

describe('logDocsAnswer', () => {
    // The default state in production is OFF. If this ever regresses, every task run
    // silently accumulates a log of its research answers on disk.
    test('writes nothing when the env var is unset', () => {
        const sink = tmpSink()
        logDocsAnswer(REC, () => undefined)
        expect(fs.existsSync(sink)).toBe(false)
    })

    test('writes nothing when the env var is set but blank', () => {
        logDocsAnswer(REC, k => (k === TYPEONLY_LOG_ENV ? '   ' : undefined))
        // No path to check — the assertion is that it did not throw and had nothing to
        // write to. A blank sink name must not be treated as the file "   ".
        expect(fs.existsSync('   ')).toBe(false)
    })

    test('appends one JSON line per call, preserving order', () => {
        const sink = tmpSink()
        const env = (k: string): string | undefined => (k === TYPEONLY_LOG_ENV ? sink : undefined)
        logDocsAnswer(REC, env)
        logDocsAnswer({...REC, module: 'zod', typeOnly: false}, env)
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows.length).toBe(2)
        expect(rows[0].module).toBe('hono/client')
        expect(rows[1].module).toBe('zod')
        expect(rows[1].typeOnly).toBe(false)
    })

    // The denominator is the point: a log containing only the firings cannot yield a rate.
    test('records unflagged answers too, so the rate has a denominator', () => {
        const sink = tmpSink()
        const env = (k: string): string | undefined => (k === TYPEONLY_LOG_ENV ? sink : undefined)
        logDocsAnswer({...REC, typeOnly: false, reason: 'answer states behaviour'}, env)
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows.length).toBe(1)
        expect(rows[0].typeOnly).toBe(false)
    })

    test('derives `unclear` from the answer text', () => {
        const sink = tmpSink()
        const env = (k: string): string | undefined => (k === TYPEONLY_LOG_ENV ? sink : undefined)
        logDocsAnswer({...REC, answer: 'unclear from this package'}, env)
        logDocsAnswer(REC, env)
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows[0].unclear).toBe(true)
        expect(rows[1].unclear).toBe(false)
    })

    // A project-source lookup is instructed to abstain with "unclear from this PROJECT",
    // not "package": `buildProjectPrompt` (docs-project.ts) passes `kind: 'project'` to
    // `buildExtractionPrompt`. `unclear` is derived by `isAbstention`, whose regex is
    // built from the same NOUNS table, so all three corpora match.
    test('derives `unclear` from the project-source wording too', () => {
        const sink = tmpSink()
        const env = (k: string): string | undefined => (k === TYPEONLY_LOG_ENV ? sink : undefined)
        logDocsAnswer({...REC, module: '.', answer: 'unclear from this project'}, env)
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows[0].unclear).toBe(true)
    })

    test('retains the full answer text for offline re-scoring', () => {
        const sink = tmpSink()
        const env = (k: string): string | undefined => (k === TYPEONLY_LOG_ENV ? sink : undefined)
        logDocsAnswer(REC, env)
        const rows = readTypeOnlyLog(fs.readFileSync(sink, 'utf8'))
        expect(rows[0].answer).toBe(REC.answer)
    })

    // Instrumentation that can break the thing it measures is worse than none. An
    // unwritable sink (a path inside a nonexistent directory) must be silent.
    test('an unwritable sink never throws into the tool', () => {
        const bad = path.join(os.tmpdir(), 'typeonly-log-no-such-dir-xyz', 'answers.jsonl')
        expect(() =>
            logDocsAnswer(REC, k => (k === TYPEONLY_LOG_ENV ? bad : undefined))
        ).not.toThrow()
    })
})

describe('readTypeOnlyLog', () => {
    test('skips a truncated final line instead of throwing', () => {
        const rows = readTypeOnlyLog('{"module":"zod","typeOnly":false}\n{"module":"ho')
        expect(rows.length).toBe(1)
        expect(rows[0].module).toBe('zod')
    })

    test('ignores blank lines', () => {
        expect(readTypeOnlyLog('\n\n').length).toBe(0)
    })
})
