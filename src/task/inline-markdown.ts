/**
 * Inline-markdown helpers for the question dialogs (grill, clarify, /task-plan).
 *
 * The question arrives carrying markdown because our own prompts ask for it:
 * auto-prompts.ts and plan-prompts.ts both say "Put the core question in
 * **bold** ... Backticks around code/identifiers are fine."
 *
 * One question then needs two forms, and question-dialog.ts `settleQuestion`
 * builds both:
 *   • RENDERED — passed as `localTitle`, which reaches `ctx.ui.input`. pi wraps
 *     that title in `theme.fg("accent", ...)` and hands it to a pi-tui `Text`,
 *     which passes embedded escape sequences straight through, so the bold and
 *     code spans survive to the terminal.
 *   • STRIPPED — passed as the browser card's `question`, as the editable
 *     `recommended` default, and as the text recorded in QaTranscript, whose
 *     `forRecord()` is written into the task file's `grill Q&A` section. All
 *     three are plain text, never ANSI.
 */

/**
 * Minimal theme surface we need. pi's `Theme` satisfies it: it declares
 * `bold(text)` and `fg(color, text)`, and `mdCode` is one of its `ThemeColor`
 * values, so `ctx.ui.theme` is passed in directly.
 */
export interface InlineMarkdownTheme {
    bold(text: string): string
    fg(color: 'mdCode', text: string): string
}

const BOLD_SPAN = /\*\*(.+?)\*\*/g
const CODE_SPAN = /`([^`]+)`/g

/** Render **bold** and `code` spans to themed terminal styling for display. */
export function renderInlineMarkdown(text: string, theme: InlineMarkdownTheme): string {
    return text
        .replace(BOLD_SPAN, (_, b: string) => theme.bold(b))
        .replace(CODE_SPAN, (_, c: string) => theme.fg('mdCode', c))
        .replace(/\*\*/g, '') // drop stray/unbalanced bold markers
        .replace(/`/g, '') // drop stray backticks
}

/** Strip **bold** and `code` markers to plain text (for defaults and storage). */
export function stripInlineMarkdown(text: string): string {
    return text
        .replace(BOLD_SPAN, '$1')
        .replace(CODE_SPAN, '$1')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .trim()
}
