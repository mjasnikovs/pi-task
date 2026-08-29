import {describe, expect, test} from 'bun:test'
import {detectLeakedToolCall} from '../../src/shared/leaked-tool-call.js'

describe('detectLeakedToolCall', () => {
    test('detects a leaked <tool_call>/<function=>/<parameter=> block', () => {
        const text = [
            'Let me check the file.',
            '<tool_call>',
            '<function=bash>',
            '<parameter=command>',
            'grep -n "z.object" src/client/pages/Auth.tsx | head -20',
            '</parameter>',
            '</function>',
            '</tool_call>'
        ].join('\n')
        const marker = detectLeakedToolCall(text)
        expect(marker).not.toBeNull()
        expect(typeof marker).toBe('string')
    })

    test('detects the function/parameter dialect without a <tool_call> wrapper', () => {
        const text = '<function=read><parameter=file_path>/a/b.ts</parameter></function>'
        expect(detectLeakedToolCall(text)).not.toBeNull()
    })

    test('returns null for an ordinary prose answer', () => {
        expect(
            detectLeakedToolCall('The Auth page validates email and password with zod.')
        ).toBeNull()
    })

    test('returns null for a spec with a shell VERIFY block but no tool-call XML', () => {
        const spec = 'GOAL\n...\nVERIFY\n  bun test src/\n  grep -n "foo" src/x.ts'
        expect(detectLeakedToolCall(spec)).toBeNull()
    })

    test('does not flag the bare words "function"/"parameter" in prose', () => {
        expect(
            detectLeakedToolCall('Define a function that returns the parameter list.')
        ).toBeNull()
    })

    test('does not flag a <function=> tag with no accompanying <parameter=>', () => {
        // A stray "<function=x>" in prose/source is not a confident leak signal;
        // only the structural combo (or a <tool_call> wrapper) counts.
        expect(detectLeakedToolCall('see <function=foo> in the old template')).toBeNull()
    })
})
