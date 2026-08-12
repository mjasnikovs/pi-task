/**
 * docs-chunk — cutting source text into retrievable chunks, for every corpus the
 * docs Worker tool indexes.
 *
 * There are two corpora — an npm package's `.d.ts` + README, and the local
 * project's own `.ts`/`.tsx` — and they were chunked by two copies of this code.
 * Not similar code: the same chunk-split regex, the same size cap, byte-identical
 * `chunkDts`/`chunkTs` bodies, and byte-identical `splitAtMatches`/`sliceBytes`,
 * in `docs-index.ts` and `docs-project.ts`. One copy had tests; the other
 * (`docs-project.ts`, 319 lines) had no test file at all and was only ever
 * reached incidentally through the worker's own suite.
 *
 * The chunk boundary is load-bearing for retrieval quality — a chunk that splits
 * a declaration in half retrieves as neither — so having it in two places was two
 * places for it to drift.
 *
 * What is NOT unified: the two INDEX bodies. They key on genuinely different
 * provenance (a package is name+version with a content hash and keeps its old
 * versions; the project is a cwd key with a max-mtime version and drops its old
 * ones on every re-index), and collapsing them would change one of those
 * behaviours rather than describe them.
 */

/**
 * Chunk ceiling. Chosen against the retrieval budget: chunks are assembled into
 * a fixed character budget for the extraction child, so a chunk larger than this
 * would crowd out every other result.
 */
export const MAX_CHUNK_BYTES = 8 * 1024

/**
 * Where a declaration starts. Splitting here keeps a signature and its body in
 * one chunk, which is what makes a retrieved chunk quotable as evidence.
 */
export const DECL_SPLIT_RE =
    /^(?:export\s+|declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|module|const|let|var|enum)\s+/m

/** Where a README section starts. */
export const README_SPLIT_RE = /^#{1,2} /m

/**
 * Split at every match, keeping the match with the text that FOLLOWS it — so a
 * declaration keyword opens its chunk rather than closing the previous one.
 *
 * Never returns empty: a text with no match is one chunk, not zero.
 */
export function splitAtMatches(text: string, re: RegExp): string[] {
    const parts: string[] = []
    let lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
        if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index))
        lastIndex = m.index
        // Advance by ONE, not by the match length: the next declaration can begin
        // inside what this match consumed (`export default async function`).
        re.lastIndex = m.index + 1
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length ? parts : [text]
}

/**
 * Cut a string into pieces of at most `maxBytes` UTF-8 bytes, never splitting a
 * character.
 *
 * The cut point is walked BACK to a UTF-8 lead byte first. Both copies of this
 * function used to cut at exactly `maxBytes` and rely on
 * `Buffer.toString('utf8')` to tidy up, which it does not: decoding a buffer that
 * ends mid-character yields a U+FFFD replacement character. That replacement is
 * 3 bytes wide, so measuring the advance by the decoded slice's byte length then
 * skipped PAST the straddling character. A `€`-dense chunk came out as
 * `€€€�€€€�…` — corrupted, and one character shorter per slice.
 *
 * It matters beyond looking wrong: a chunk is quoted back as an `<excerpt>` and
 * checked verbatim against the source, and an excerpt carrying a replacement
 * character can never be found, so the answer is flagged as a possible
 * hallucination. Only reachable on non-ASCII text past the 8 KB chunk ceiling,
 * which is why two copies of it survived untested.
 */
export function sliceBytes(s: string, maxBytes: number): string[] {
    const out: string[] = []
    let buf = Buffer.from(s, 'utf8')
    while (buf.length > maxBytes) {
        // Continuation bytes are 0b10xxxxxx. Back up while the byte we are about
        // to cut before is one, so the cut lands on a character boundary.
        let end = maxBytes
        while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
        // A single character wider than the whole cap cannot be placed. Cut
        // anyway rather than loop forever; unreachable for any cap >= 4.
        if (end === 0) end = maxBytes
        out.push(buf.subarray(0, end).toString('utf8'))
        buf = buf.subarray(end)
    }
    if (buf.length) out.push(buf.toString('utf8'))
    return out
}

/**
 * Chunk a declaration file (`.d.ts`, `.ts`, `.tsx`), one chunk per declaration,
 * each labelled with the file it came from.
 *
 * `relPath` is a MODEL-FACING label and is used exactly as given — the npm path
 * normalises it to POSIX first so an index is identical across platforms, while
 * the project path keeps the native separator. It is never re-joined to the
 * filesystem, so neither choice is wrong; passing it through keeps that decision
 * with the caller that has a reason for it.
 */
export function chunkDeclarations(content: string, relPath: string): string[] {
    const chunks: string[] = []
    for (const part of splitAtMatches(content, new RegExp(DECL_SPLIT_RE.source, 'gm'))) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const prefixed = `// ${relPath}\n${trimmed}`
        if (Buffer.byteLength(prefixed, 'utf8') > MAX_CHUNK_BYTES) {
            for (const slice of sliceBytes(prefixed, MAX_CHUNK_BYTES)) chunks.push(slice)
        } else {
            chunks.push(prefixed)
        }
    }
    return chunks
}

/** Chunk a README, one chunk per top-level section, each labelled by heading. */
export function chunkReadme(content: string): string[] {
    const chunks: string[] = []
    for (const part of splitAtMatches(content, new RegExp(README_SPLIT_RE.source, 'gm'))) {
        // Trailing whitespace only — leading blank lines carry the section break.
        const trimmed = part.replace(/\s+$/, '')
        if (!trimmed) continue
        const headingMatch = /^(#{1,2}) (.+)$/m.exec(trimmed)
        const heading = headingMatch ? headingMatch[2] : '(intro)'
        const prefixed = `<!-- README: ${heading} -->\n${trimmed}`
        if (Buffer.byteLength(prefixed, 'utf8') > MAX_CHUNK_BYTES) {
            for (const slice of sliceBytes(prefixed, MAX_CHUNK_BYTES)) chunks.push(slice)
        } else {
            chunks.push(prefixed)
        }
    }
    return chunks
}
