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
 *
 * The modifiers are SEQUENTIAL, not alternatives. Written as `export|declare`
 * they excluded `export declare function` — which is what `tsc --declaration`
 * emits for every exported function in a module: 6,935 such lines in a
 * 4,000-file sample, 3,479 of them functions, and not one started a chunk.
 * `undici-types/fetch.d.ts` put `export declare function fetch(` inside a chunk
 * headed `export type RequestInfo`, so nothing could retrieve the chunk that
 * defines `fetch`.
 */
export const DECL_SPLIT_RE =
    /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|module|const|let|var|enum)\s+/m

/**
 * Where a member of an oversized declaration begins — the same heads, indented.
 *
 * `declare module "bun" { … }` is ONE top-level declaration holding a whole module,
 * so `DECL_SPLIT_RE` matches once and everything after it was cut at byte offsets.
 * That shape is rare and enormous: 3.8% of indexed chunks sat at the cap and held
 * 51.1% of all indexed bytes, 86.8% of `@types/node`'s and 78.1% of `bun-types`'.
 *
 * Only reached when a declaration does not fit. A member split applied to every
 * declaration would cut an interface away from its own members, which is the thing
 * `DECL_SPLIT_RE` exists to prevent.
 */
export const MEMBER_SPLIT_RE =
    /^[ \t]+(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|module|const|let|var|enum)\s+/m

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
    let acceptedEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
        // Scan resumes ONE character in, not past the match: the regex's trailing
        // `\s+` can span a newline, so a genuinely separate line-anchored
        // declaration may start inside what this match consumed.
        re.lastIndex = m.index + 1
        // But a match that starts inside the last ACCEPTED one is that match's own
        // tail, not a new declaration, and cutting there severs a declaration from
        // the modifiers and attributes that open it. `export\nfunction a(){}` is
        // one declaration; so is a cargo `#[cfg(…)]` above its `impl`, which
        // CARGO_DECL_SPLIT_RE absorbs on purpose and this used to hand back as a
        // chunk holding nothing but the attribute.
        if (m.index < acceptedEnd) continue
        if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index))
        lastIndex = m.index
        acceptedEnd = m.index + m[0].length
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
    // A non-positive cap never shrinks the buffer, so the loop below runs forever.
    // Guarded here rather than at the callers: the cap is usually computed, and the
    // next caller to compute one must not have to rediscover this.
    if (maxBytes <= 0) return s ? [s] : []
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
 * Slice a body that will not fit, giving every piece the same header.
 *
 * The header was applied once and then sliced, so only the first piece said where
 * it came from: 487 of 12,815 indexed chunks had no provenance line, 53% of
 * `@types/node`'s and 22% of `bun-types`'. A `node:url` query for `fileURLToPath`
 * came back as two 8,192-byte pieces that began mid-sentence inside a doc comment
 * and named no file.
 *
 * The cap counts the header, so the body budget is what is left after it.
 */
export function headedSlices(header: string, body: string, maxBytes: number): string[] {
    const prefixed = `${header}\n${body}`
    if (Buffer.byteLength(prefixed, 'utf8') <= maxBytes) return [prefixed]
    // The header is a LABEL, and `chunkReadme` builds it from an unbounded heading line.
    // Left whole it starves the body: a header two bytes short of the cap turned a 200 KB
    // section into 100,000 two-byte chunks, each re-carrying the 8 KB header. Splitting the
    // cap evenly is the one division that needs no tuning, and a cut label still names the
    // source.
    const head = sliceBytes(header, Math.floor(maxBytes / 2))[0] ?? ''
    const room = maxBytes - Buffer.byteLength(`${head}\n`, 'utf8')
    // Only a cap of a byte or two reaches this. Slice the prefixed string and accept the
    // degenerate result: the body pieces carry no provenance — the very defect this
    // function exists to fix, but the alternative here is emitting nothing.
    if (room <= 0) return sliceBytes(prefixed, maxBytes)
    return sliceBytes(body, room).map(slice => `${head}\n${slice}`)
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
    commentPrefix = '//',
    memberRe: RegExp = MEMBER_SPLIT_RE
): string[] {
    const chunks: string[] = []
    const header = `${commentPrefix} ${relPath}`
    for (const part of splitAtMatches(content, new RegExp(splitRe.source, 'gm'))) {
        const trimmed = part.trim()
        if (!trimmed) continue
        chunks.push(...splitOversized(header, trimmed, memberRe))
    }
    return chunks
}

/**
 * Cut a declaration that does not fit at its own member boundaries, keeping the
 * line that says what it is a member OF.
 *
 * Without that line a piece of `declare module "bun"` is an anonymous list of
 * functions: a `Bun.file` question came back carrying slices about S3 ETags and
 * tar archives, because bm25 was matching words in the middles of byte cuts that
 * shared no subject.
 *
 * Byte slicing stays as the floor. A single member wider than the cap — one
 * function with a 20 KB doc comment — still has to be cut somewhere.
 */
export function splitOversized(header: string, body: string, memberRe: RegExp): string[] {
    if (Buffer.byteLength(`${header}\n${body}`, 'utf8') <= MAX_CHUNK_BYTES) {
        return [`${header}\n${body}`]
    }
    const parts = splitAtMatches(body, new RegExp(memberRe.source, 'gm'))
    if (parts.length < 2) return headedSlices(header, body, MAX_CHUNK_BYTES)
    // The first part carries the enclosing head; every later one has to be told.
    const enclosing = parts[0].split('\n')[0].trim()
    const out: string[] = []
    for (const [i, part] of parts.entries()) {
        const trimmed = part.replace(/\s+$/, '')
        if (!trimmed.trim()) continue
        const withContext = i === 0 ? trimmed : `${enclosing}\n${trimmed}`
        out.push(...headedSlices(header, withContext, MAX_CHUNK_BYTES))
    }
    return out
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
        chunks.push(...headedSlices(`<!-- README: ${heading} -->`, trimmed, MAX_CHUNK_BYTES))
    }
    return chunks
}
