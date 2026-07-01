/**
 * Text-file reads with line endings normalized to LF.
 *
 * Every task-file parser in pi-task assumes `\n` line endings: the front-matter
 * regex (`^---\n`), the body-delimiter strip, `sectionRegex` (`## h[ \t]*\n`),
 * the checkbox/VERIFY-token line splits. On Windows a task file can carry CRLF
 * (an editor save, or a `git` checkout with `core.autocrlf=true`), and classic
 * Mac tooling can emit lone CR. Any of those makes `parseFrontMatter` return
 * null ("malformed front matter") and every `extractSection` miss.
 *
 * Rather than teach each parser about `\r`, we normalize ONCE at the read
 * boundary — the single place file bytes enter the task layer — so everything
 * downstream sees LF. See GitHub issue #1.
 */

import * as fsp from 'node:fs/promises'

/** Collapse CRLF and lone CR to LF. `\r\n?` matches Windows CRLF and classic-Mac CR. */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/g, '\n')
}

/** Read a UTF-8 text file with line endings normalized to LF. */
export async function readTextFile(filePath: string): Promise<string> {
    return normalizeNewlines(await fsp.readFile(filePath, 'utf8'))
}
