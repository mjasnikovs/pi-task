/**
 * docs-chunk — cutting source text into retrievable chunks, for both corpora the
 * docs Worker tool indexes: an npm package's `.d.ts` + README (docs-index.ts),
 * and the local project's own `.ts`/`.tsx` (docs-project.ts).
 *
 * The chunk boundary is load-bearing for retrieval: a chunk that splits a
 * declaration in half matches on neither half's terms, so one boundary rule for
 * both corpora is the point of this module.
 *
 * What is NOT shared: the two INDEX bodies. They key on genuinely different
 * provenance. A package is `(name, version)` with a content hash, and re-indexing
 * runs `DELETE FROM chunks WHERE name = ? AND version = ?`, so older versions
 * survive. The project is a cwd-hash name with a max-mtime version, and
 * re-indexing runs `DELETE FROM chunks WHERE name = ?`, dropping every older
 * version. Collapsing them would change one of those behaviours, not describe it.
 */

/**
 * Chunk ceiling, in UTF-8 bytes. Sized against the retrieval budget: retrieved
 * chunks are assembled into `RETRIEVE_CONTENT_BUDGET` (24,000 characters) before
 * going to the extraction child, so this caps any one chunk at about a third of
 * what the child will ever see.
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
        // Advance by ONE, not by the match length. The regex's trailing `\s+` can
        // span a newline, so the next line-anchored declaration may start INSIDE
        // what this match consumed: `export\nfunction a(){}` is two chunks here
        // and one if the scan resumes past the match.
        re.lastIndex = m.index + 1
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length ? parts : [text]
}

/**
 * Cut a string into pieces of at most `maxBytes` UTF-8 bytes, never splitting a
 * character.
 *
 * The cut point is walked BACK to a UTF-8 lead byte first. Cutting at exactly
 * `maxBytes` and letting `Buffer.toString('utf8')` tidy up does not work: decoding
 * a buffer that ends mid-character yields U+FFFD. That replacement is 3 bytes
 * wide, so the decoded slice measures LONGER than the cut — a 100-byte cut of
 * `€`-dense text decodes to 102 bytes — and advancing by the decoded length then
 * skips past the straddling character entirely.
 *
 * It matters beyond looking wrong: a chunk is quoted back as an `<excerpt>` and
 * checked verbatim against the source (`excerptVerified`), and an excerpt carrying
 * a replacement character can never be found, so the answer is flagged as a
 * possible hallucination. Only reachable on non-ASCII text past the chunk ceiling.
 */
export function sliceBytes(s: string, maxBytes: number): string[] {
    const out: string[] = []
    let buf = Buffer.from(s, 'utf8')
    while (buf.length > maxBytes) {
        // Continuation bytes are 0b10xxxxxx. Back up while the byte we are about
        // to cut before is one, so the cut lands on a character boundary.
        let end = maxBytes
        while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
        // A single character wider than the whole cap cannot be placed. Cut anyway
        // rather than loop forever — this is the one path that DOES emit U+FFFD.
        // Unreachable for any cap >= 4: the widest UTF-8 character is 4 bytes.
        if (end === 0) end = maxBytes
        out.push(buf.subarray(0, end).toString('utf8'))
        buf = buf.subarray(end)
    }
    if (buf.length) out.push(buf.toString('utf8'))
    return out
}

/**
 * Chunk a declaration file, one chunk per declaration, each labelled with the
 * file it came from.
 *
 * `relPath` is a MODEL-FACING label and is used exactly as given. docs-index.ts
 * normalises it to POSIX (`.replace(/\\/g, '/')`) so a package index is identical
 * across platforms; docs-project.ts passes `path.relative` through with the native
 * separator. It is never re-joined to the filesystem, so neither is wrong — this
 * leaves the choice with the caller that has a reason for it.
 *
 * `splitRe` and `commentPrefix` default to the TypeScript pair, which is what
 * both the project corpus and npm packages are written in.
 */
export function chunkDeclarations(
    content: string,
    relPath: string,
    splitRe: RegExp = DECL_SPLIT_RE,
    commentPrefix = '//'
): string[] {
    const chunks: string[] = []
    for (const part of splitAtMatches(content, new RegExp(splitRe.source, 'gm'))) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const prefixed = `${commentPrefix} ${relPath}\n${trimmed}`
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
