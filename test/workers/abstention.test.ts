import {test, expect, describe} from 'bun:test'
import {
    abstentionSentence,
    isAbstention,
    type AbstentionKind
} from '../../src/workers/abstention.js'
import {buildProjectPrompt} from '../../src/workers/docs-project.js'
import {UNCLEAR_ANSWER} from '../../src/workers/fetch-core.js'

const KINDS: readonly AbstentionKind[] = ['package', 'project', 'page']

describe('every sentinel a prompt can emit is recognised by the matcher', () => {
    // The property that could not be written before: the sentences were bare
    // literals inside three prompt templates, and the four matchers each knew a
    // different subset of them. typeonly-log records what that cost — matching
    // only "package" silently scored every PROJECT abstention as a real answer.
    for (const kind of KINDS) {
        test(`the ${kind} sentinel round-trips`, () => {
            expect(isAbstention(abstentionSentence(kind))).toBe(true)
        })
    }
})

test('a wrapped sentinel still counts — models rarely emit it bare', () => {
    expect(
        isAbstention('Unclear from this package — the README does not mention this option.')
    ).toBe(true)
    expect(isAbstention('<answer>unclear from this page</answer>')).toBe(true)
})

test('a real answer is not an abstention', () => {
    expect(isAbstention('Call `fetch(url, {method: "POST"})` to send a body.')).toBe(false)
    // The sibling sentinel fetch-core anchors separately. It is a COVERAGE miss
    // ("these two symbols are not covered by this page"), not a refusal to answer,
    // and it must not be swallowed by this predicate.
    expect(isAbstention('not covered by this page')).toBe(false)
})

test('the word alone is not enough — it has to be the sentinel', () => {
    expect(isAbstention('The docs are unclear about retries, but the type says number.')).toBe(
        false
    )
})

test('the sentences the prompts actually ship are the ones the matcher knows', () => {
    // Reads the emitted prompt, not a copy of it, so a prompt edited to a
    // different phrasing fails here rather than silently disabling the check.
    const projectPrompt = buildProjectPrompt('my-app', 'how do I log in?', 'chunk text')
    expect(projectPrompt).toContain(abstentionSentence('project'))
    expect(isAbstention(UNCLEAR_ANSWER)).toBe(true)
})
