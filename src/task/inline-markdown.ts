/**
 * Inline-markdown helpers for the clarify/grill question dialogs.
 *
 * The model often wraps the core question in **bold** (and code in backticks)
 * because it makes the question easier to read at a glance. ctx.ui.input titles
 * accept ANSI styling, so we RENDER those spans to terminal bold/code for the
 * displayed prompt, and STRIP them to plain text for the editable input default
 * and the persisted task file (which must stay ANSI-free).
 */

/** Minimal theme surface we need; ExtensionCommandContext['ui'].theme satisfies it. */
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
