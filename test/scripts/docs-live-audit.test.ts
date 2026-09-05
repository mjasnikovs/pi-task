import {test, expect} from 'bun:test'
import {inventedSymbols} from '../../scripts/docs-live-audit.js'

// The tool's return embeds the answer prose, so scoring the answer against it asks
// whether the answer contains itself. It always does: two live runs read 13/13,
// 12/12, 10/10, 13/13, 4/4 and 2/2 clean — 54 answers, not one miss — while one of
// them shipped `decodeFile`, a function aeson 2 does not have.
const ANSWER = 'Use `decodeFile` to read a file.'
const TOOL_TEXT = `### hackage: aeson\n\nPer aeson@2.2.5.1:\n\n${ANSWER}\n\nSource excerpt:\n> decodeFileStrict :: FromJSON a => FilePath -> IO (Maybe a)`
const RETRIEVED = '-- src/Data/Aeson.hs\ndecodeFileStrict :: FromJSON a => FilePath -> IO (Maybe a)'

test('the tool return excuses any symbol, because it contains the answer', () => {
    expect(inventedSymbols(ANSWER, TOOL_TEXT)).toEqual([])
})

test('the retrieved chunks catch it', () => {
    expect(inventedSymbols(ANSWER, RETRIEVED)).toContain('decodeFile')
})

test('a symbol the retrieved chunks DO carry stays clean', () => {
    expect(inventedSymbols('Use `decodeFileStrict` here.', RETRIEVED)).toEqual([])
})
