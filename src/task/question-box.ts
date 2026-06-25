/**
 * Boxed question dialog for the clarify / grill phases.
 *
 * The built-in `ctx.ui.select` renders every option as a bare line under one
 * outer frame — the question, the recommendation, and the choices all read as a
 * single blob. The remote (browser) prompt card instead gives each response its
 * own bounded panel, tints the recommended one green, and separates everything
 * with margins. This module mirrors that remote style in the terminal: a custom
 * `ctx.ui.custom` component that draws each answer in its own bounding box with a
 * green RECOMMENDED tag, an accent-highlighted cursor box, and clear vertical
 * spacing.
 *
 * `renderQuestionBox` is the pure layout — width in, lines out — so the visual
 * structure (borders, tag, cursor arrow, padding) is unit-testable without a
 * live TUI. The component and `askQuestionBox` wire it to keyboard input and the
 * "type a different answer" free-text fallback.
 */

import {getKeybindings, visibleWidth, wrapTextWithAnsi} from '@earendil-works/pi-tui'
import type {Component} from '@earendil-works/pi-tui'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

// ─── Types ───────────────────────────────────────────────────────────────────

/** One answer card. `label` may carry ANSI (rendered markdown); width math is
 *  ANSI-aware so the box borders still line up. */
export interface BoxCard {
    label: string
    /** Recommended answer → green chrome + RECOMMENDED tag. */
    recommended?: boolean
}

/** Chrome colourers, injected so tests can pass identity fns and assert on the
 *  plain box structure. A real theme is adapted by {@link boxColors}. */
export interface BoxColors {
    border: (s: string) => string
    borderRecommended: (s: string) => string
    borderSelected: (s: string) => string
    recommendedTag: (s: string) => string
    questionLabel: (s: string) => string
    hint: (s: string) => string
    arrow: (s: string) => string
}

type ThemeLike = ExtensionCommandContext['ui']['theme']

// ─── Constants ───────────────────────────────────────────────────────────────

/** Left gutter: two columns reserved for the cursor bar so boxes stay aligned. */
const GUTTER = 2
/** Cap the dialog at a readable column count. Without this the boxes stretch the
 *  full terminal width on wide/ultrawide screens — long question lines become
 *  hard to scan and short answers leave a huge empty right margin inside the box. */
const MAX_CONTENT_WIDTH = 96
const RECOMMENDED_TAG = 'RECOMMENDED'
/** Smallest box that still fits "┌─ RECOMMENDED ─┐". Below this we drop the tag. */
const TAG_MIN_BOX_WIDTH = visibleWidth(`┌─ ${RECOMMENDED_TAG} ─┐`)
export const QUESTION_LABEL = 'QUESTION'
export const HINT_TEXT = '↑↓ navigate · enter select · esc cancel'
export const MANUAL_CARD_LABEL = '✎ Type a different answer…'

// ─── Pure renderer ─────────────────────────────────────────────────────────────

function padTo(line: string, width: number): string {
    const pad = width - visibleWidth(line)
    return pad > 0 ? line + ' '.repeat(pad) : line
}

function renderCard(card: BoxCard, selected: boolean, boxWidth: number, c: BoxColors): string[] {
    const borderFn =
        selected ? c.borderSelected
        : card.recommended ? c.borderRecommended
        : c.border
    const innerWidth = Math.max(1, boxWidth - 4) // "│ " + content + " │"
    const dash = (n: number) => '─'.repeat(Math.max(0, n))

    // Top border, with a RECOMMENDED tag woven in when it fits.
    let top: string
    if (card.recommended && boxWidth >= TAG_MIN_BOX_WIDTH) {
        // TAG_MIN_BOX_WIDTH is the width at one trailing dash, so add it back.
        const dashes = boxWidth - TAG_MIN_BOX_WIDTH + 1
        top = borderFn('┌─ ') + c.recommendedTag(RECOMMENDED_TAG) + borderFn(` ${dash(dashes)}┐`)
    } else {
        top = borderFn(`┌${dash(boxWidth - 2)}┐`)
    }

    const bodyLines = wrapTextWithAnsi(card.label, innerWidth)
    const body = (bodyLines.length > 0 ? bodyLines : ['']).map(
        line => borderFn('│ ') + padTo(line, innerWidth) + borderFn(' │')
    )
    const bottom = borderFn(`└${dash(boxWidth - 2)}┘`)

    // A full-height accent bar in the gutter marks the selected card — far more
    // visible than a single "▸" glyph on the top border alone.
    const cursor = selected ? c.arrow('▌') + ' ' : '  '
    return [cursor + top, ...body.map(b => cursor + b), cursor + bottom]
}

/**
 * Lay the whole dialog out for `width` columns: a QUESTION label + wrapped
 * question, one bounding box per card (recommended tinted green, the cursor box
 * highlighted with an accent border and "▸" arrow), and a key-hint footer.
 */
export function renderQuestionBox(
    width: number,
    question: string,
    cards: BoxCard[],
    selected: number,
    c: BoxColors,
    hintText: string = HINT_TEXT
): string[] {
    const W = Math.min(Math.max(width, 12), MAX_CONTENT_WIDTH)
    const boxWidth = Math.max(6, W - GUTTER)
    const out: string[] = ['']

    out.push('  ' + c.questionLabel(QUESTION_LABEL))
    for (const line of wrapTextWithAnsi(question, W - GUTTER)) out.push('  ' + line)
    out.push('')

    for (let i = 0; i < cards.length; i++) {
        out.push(...renderCard(cards[i], i === selected, boxWidth, c))
        out.push('')
    }

    for (const line of wrapTextWithAnsi(hintText, W - GUTTER)) out.push('  ' + c.hint(line))
    out.push('')
    return out
}

// ─── Theme adapter ─────────────────────────────────────────────────────────────

export function boxColors(theme: ThemeLike): BoxColors {
    return {
        border: s => theme.fg('borderMuted', s),
        borderRecommended: s => theme.fg('success', s),
        borderSelected: s => theme.fg('accent', s),
        recommendedTag: s => theme.fg('success', theme.bold(s)),
        questionLabel: s => theme.fg('accent', theme.bold(s)),
        hint: s => theme.fg('muted', s),
        arrow: s => theme.fg('accent', theme.bold(s))
    }
}

// ─── Component ─────────────────────────────────────────────────────────────────

/** Focusable picker component; navigation mirrors the built-in select dialog. */
export class QuestionBoxComponent implements Component {
    private selected = 0

    /** Card labels in display order (recommended first, manual last). Read-only
     *  view for tests that drive the picker without parsing rendered output. */
    get cardLabels(): string[] {
        return this.cards.map(c => c.label)
    }

    /** The question header text. Read-only view for tests. */
    get headerText(): string {
        return this.question
    }

    constructor(
        private readonly question: string,
        private readonly cards: BoxCard[],
        private readonly colors: BoxColors,
        private readonly onChoose: (index: number) => void,
        private readonly onCancel: () => void
    ) {}

    render(width: number): string[] {
        return renderQuestionBox(width, this.question, this.cards, this.selected, this.colors)
    }

    invalidate(): void {}

    handleInput(data: string): void {
        const kb = getKeybindings()
        if (kb.matches(data, 'tui.select.up') || data === 'k') {
            this.selected = Math.max(0, this.selected - 1)
        } else if (kb.matches(data, 'tui.select.down') || data === 'j') {
            this.selected = Math.min(this.cards.length - 1, this.selected + 1)
        } else if (kb.matches(data, 'tui.select.confirm') || data === '\n' || data === '\r') {
            this.onChoose(this.selected)
        } else if (kb.matches(data, 'tui.select.cancel')) {
            this.onCancel()
        }
    }
}

// ─── Driver ────────────────────────────────────────────────────────────────────

export interface BoxOption {
    label: string
    value: string
    recommended?: boolean
}

export interface AskQuestionBoxSpec {
    /** Display question for the box header (may carry ANSI). */
    question: string
    /** Plain title for the free-text fallback input dialog. */
    inputTitle: string
    options: BoxOption[]
    signal: AbortSignal
}

/**
 * Show the boxed picker and resolve to the chosen option's `value`, the text the
 * user typed via "type a different answer", or undefined when cancelled/aborted.
 */
export async function askQuestionBox(
    ctx: ExtensionCommandContext,
    spec: AskQuestionBoxSpec
): Promise<string | undefined> {
    const {question, options, inputTitle, signal} = spec
    const cards: BoxCard[] = [
        ...options.map(o => ({label: o.label, recommended: o.recommended})),
        {label: MANUAL_CARD_LABEL}
    ]
    const colors = boxColors(ctx.ui.theme)
    const manualIndex = options.length

    const choice = await ctx.ui.custom<number | undefined>((_tui, _theme, _kb, done) => {
        if (signal.aborted) {
            done(undefined)
            return new QuestionBoxComponent(
                question,
                cards,
                colors,
                () => {},
                () => {}
            )
        }
        const onAbort = () => done(undefined)
        signal.addEventListener('abort', onAbort, {once: true})
        const finish = (result: number | undefined) => {
            signal.removeEventListener('abort', onAbort)
            done(result)
        }
        return new QuestionBoxComponent(
            question,
            cards,
            colors,
            index => finish(index),
            () => finish(undefined)
        )
    })

    if (choice === undefined) return undefined
    if (choice === manualIndex) {
        return ctx.ui.input(inputTitle, undefined, {signal})
    }
    return options[choice]?.value
}
