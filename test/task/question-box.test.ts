import {describe, expect, test} from 'bun:test'
import {visibleWidth} from '@earendil-works/pi-tui'
import {
    askQuestionBox,
    HINT_TEXT,
    MANUAL_CARD_LABEL,
    QUESTION_LABEL,
    QuestionBoxComponent,
    renderQuestionBox,
    type BoxCard,
    type BoxColors
} from '../../src/task/question-box.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'

// Identity colourers → output is plain text we can assert structure on.
const PLAIN: BoxColors = {
    border: s => s,
    borderRecommended: s => s,
    borderSelected: s => s,
    recommendedTag: s => s,
    questionLabel: s => s,
    hint: s => s,
    arrow: s => s
}

const CARDS: BoxCard[] = [
    {label: 'Use Vite', recommended: true},
    {label: 'Use Bun bundler'},
    {label: MANUAL_CARD_LABEL}
]

describe('renderQuestionBox', () => {
    test('renders the question label and text', () => {
        const out = renderQuestionBox(80, 'Which bundler?', CARDS, 0, PLAIN).join('\n')
        expect(out).toContain(QUESTION_LABEL)
        expect(out).toContain('Which bundler?')
        expect(out).toContain(HINT_TEXT)
    })

    test('each card is its own bounding box', () => {
        const lines = renderQuestionBox(80, 'Q?', CARDS, 0, PLAIN)
        // One ┌…┐ top and one └…┘ bottom per card.
        expect(lines.filter(l => l.includes('┌') && l.includes('┐')).length).toBe(CARDS.length)
        expect(lines.filter(l => l.includes('└') && l.includes('┘')).length).toBe(CARDS.length)
        // Body lines have both vertical borders.
        expect(lines.some(l => l.includes('│ Use Vite') && l.trimEnd().endsWith('│'))).toBe(true)
    })

    test('recommended card carries the RECOMMENDED tag', () => {
        const out = renderQuestionBox(80, 'Q?', CARDS, 1, PLAIN).join('\n')
        expect(out).toContain('RECOMMENDED')
        // Exactly one card is tagged.
        expect(out.match(/RECOMMENDED/g)?.length).toBe(1)
    })

    test('the selected card is marked with a full-height cursor bar', () => {
        const sel0 = renderQuestionBox(80, 'Q?', CARDS, 0, PLAIN)
        const sel1 = renderQuestionBox(80, 'Q?', CARDS, 1, PLAIN)
        // The bar spans every line of the selected card (top, body, bottom) — not
        // a single glyph — so it is clearly visible.
        expect(sel0.filter(l => l.startsWith('▌')).length).toBeGreaterThan(1)
        // Only the selected card carries the bar: card 0 (one body line) marks 3 rows.
        expect(sel0.filter(l => l.startsWith('▌')).length).toBe(3)
        // Moving the cursor moves the bar.
        expect(sel0).not.toEqual(sel1)
    })

    test('the manual fallback card is always present', () => {
        const out = renderQuestionBox(80, 'Q?', CARDS, 0, PLAIN).join('\n')
        expect(out).toContain(MANUAL_CARD_LABEL)
    })

    test('no rendered line exceeds the viewport width', () => {
        for (const width of [80, 40, 24, 12]) {
            const lines = renderQuestionBox(
                width,
                'A reasonably long question that wraps',
                CARDS,
                0,
                PLAIN
            )
            for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width)
        }
    })

    test('narrow widths drop the tag but keep boxes intact', () => {
        const lines = renderQuestionBox(14, 'Q?', CARDS, 0, PLAIN)
        expect(lines.filter(l => l.includes('┌')).length).toBe(CARDS.length)
        // Too narrow for "┌─ RECOMMENDED ─┐", so the tag is omitted.
        expect(lines.join('\n')).not.toContain('RECOMMENDED')
    })

    test('long answer text wraps inside the box', () => {
        const long =
            'This is a deliberately long answer option that must wrap across multiple body lines inside its bounding box'
        const lines = renderQuestionBox(40, 'Q?', [{label: long, recommended: true}], 0, PLAIN)
        const bodyLines = lines.filter(l => l.includes('│') && !l.includes('┌') && !l.includes('└'))
        expect(bodyLines.length).toBeGreaterThan(1)
    })
})

describe('QuestionBoxComponent', () => {
    function make() {
        const chosen: number[] = []
        let cancelled = 0
        const comp = new QuestionBoxComponent(
            'Q?',
            CARDS,
            PLAIN,
            i => chosen.push(i),
            () => cancelled++
        )
        return {
            comp,
            chosen,
            get cancelled() {
                return cancelled
            }
        }
    }

    test('down/up arrows move the cursor and clamp at the ends', () => {
        const {comp} = make()
        // Start at 0; up clamps.
        comp.handleInput('\x1b[A') // up
        expect(comp.render(80).some(l => l.startsWith('▌'))).toBe(true)
        // Down to the last card then clamp.
        comp.handleInput('\x1b[B')
        comp.handleInput('\x1b[B')
        comp.handleInput('\x1b[B')
        const lines = comp.render(80)
        const barRow = lines.findIndex(l => l.startsWith('▌'))
        // The bar should reach the last (manual) card's top border.
        const manualRow = lines.findIndex(l => l.includes(MANUAL_CARD_LABEL))
        expect(barRow).toBeLessThanOrEqual(manualRow)
        expect(barRow).toBeGreaterThan(-1)
    })

    test('enter chooses the highlighted card', () => {
        const {comp, chosen} = make()
        comp.handleInput('\x1b[B') // move to index 1
        comp.handleInput('\r')
        expect(chosen).toEqual([1])
    })

    test('escape cancels', () => {
        const t = make()
        t.comp.handleInput('\x1b')
        expect(t.cancelled).toBe(1)
    })
})

// ─── Driver: where the free-text card sits ───────────────────────────────────

describe('askQuestionBox manualPosition', () => {
    const OPTS = [
        {label: 'A', value: 'a'},
        {label: 'B', value: 'b'},
        {label: '▶ proceed', value: '__proceed__'}
    ]
    const ask = async (pick: string, manualPosition?: number) => {
        const {ctx, captured, queueSelect, queueInput} = makeFakeCtx(process.cwd())
        queueSelect(pick)
        queueInput('typed text')
        const value = await askQuestionBox(ctx, {
            question: 'Q?',
            inputTitle: 'title',
            options: OPTS,
            signal: new AbortController().signal,
            ...(manualPosition !== undefined && {manualPosition})
        })
        return {value, labels: captured.selects[0]?.options ?? []}
    }

    test('defaults to last, and every option still maps to its own value', async () => {
        expect((await ask('A')).labels).toEqual(['A', 'B', '▶ proceed', MANUAL_CARD_LABEL])
        expect((await ask('A')).value).toBe('a')
        expect((await ask('▶ proceed')).value).toBe('__proceed__')
        expect((await ask(MANUAL_CARD_LABEL)).value).toBe('typed text')
    })

    test('an earlier position slots the card in without shifting any value', async () => {
        expect((await ask('A', 2)).labels).toEqual(['A', 'B', MANUAL_CARD_LABEL, '▶ proceed'])
        // Cards after the inserted manual card still resolve to their own option.
        expect((await ask('▶ proceed', 2)).value).toBe('__proceed__')
        expect((await ask('B', 2)).value).toBe('b')
        expect((await ask('A', 2)).value).toBe('a')
        expect((await ask(MANUAL_CARD_LABEL, 2)).value).toBe('typed text')
    })

    test('out-of-range positions clamp instead of dropping a card', async () => {
        expect((await ask('A', 0)).labels).toEqual([MANUAL_CARD_LABEL, 'A', 'B', '▶ proceed'])
        expect((await ask('A', 0)).value).toBe('a')
        expect((await ask('A', 99)).labels).toEqual(['A', 'B', '▶ proceed', MANUAL_CARD_LABEL])
        expect((await ask('A', -1)).value).toBe('a')
    })
})
