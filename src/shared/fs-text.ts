/**
 * Text-file reads with line endings normalized to LF.
 *
 * A checked-out task file need not hold LF. Confirmed against real git: with
 * `core.autocrlf=true`, a blob committed as LF comes back into the working tree
 * as CRLF while the stored object is unchanged. Other tooling can write a lone CR.
 *
 * CRLF alone would not need this any more — `parseFrontMatter` and `sectionRegex`
 * both spell `\r?\n`, and a CRLF task file parses correctly with or without
 * normalization. LONE CR is the case that still does. Measured on an otherwise
 * valid task file: with CR line endings `parseFrontMatter` returns null and
 * `extractSection` finds nothing; normalized first, both succeed. Neither parser
 * regex can match a lone CR, because both require an `\n`.
 *
 * Normalizing once at the read boundary is what keeps that from becoming a third
 * line-ending case in every parser. Every task-file read goes through
 * `readTextFile`; the `readFileSync` calls elsewhere in the task layer read
 * package.json, Makefiles and .env files, which have parsers of their own.
 */

import * as fsp from 'node:fs/promises'

/** Collapse CRLF and lone CR to LF. The optional `\n` in `\r\n?` consumes a CRLF
 *  pair as one unit, so a CRLF file does not come back with doubled newlines. */
export function normalizeNewlines(text: string): string {
    return text.replace(/\r\n?/g, '\n')
}

/** Read a UTF-8 text file with line endings normalized to LF. */
export async function readTextFile(filePath: string): Promise<string> {
    return normalizeNewlines(await fsp.readFile(filePath, 'utf8'))
}
