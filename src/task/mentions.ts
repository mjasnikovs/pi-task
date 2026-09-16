/**
 * `@file` references in a prompt, and the two things done with them: inlining the
 * file's contents for the planning children, and naming the files themselves.
 *
 * Its own module because both the PLANNING side (auto-orchestrator, which threads
 * the spec doc into every task title) and the PHASE side (research, which lets the
 * orientation core select a cited doc) need the same answer, and the phase side
 * cannot import the orchestrator that imports it.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {readTextFile} from '../shared/fs-text.js'

const MENTION_RE = /(?:^|\s)@([^\s]+)/g

// Trailing punctuation a user naturally types AFTER an @-mention when it sits in
// prose — "Implement @design.md, reuse…" or "see @spec.md." — which the greedy
// [^\s]+ above would otherwise swallow into the path. Left unstripped, the
// resulting "design.md," resolves to no file, expansion is silently skipped, and
// the planner reasons over a one-line "Implement @design.md" with NO spec inline
// → it fabricates generic questions and tasks the spec never called for.
//
// Measured against a real file: the greedy token from "Implement @design.md,
// reuse the parser" is `design.md,`, which does not exist; stripped, `design.md`
// does. None of these chars are legitimate trailing characters of a doc path.
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/** The cleaned path token of an @-mention: greedy match minus trailing prose punctuation. */
function mentionPath(token: string): string {
    return token.replace(MENTION_TRAILING_PUNCT, '')
}

/** Every distinct @-mention path in `text`, in first-seen order. */
function mentionPaths(text: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(MENTION_RE)) {
        const rel = mentionPath(m[1])
        if (rel === '' || seen.has(rel)) continue
        seen.add(rel)
        out.push(rel)
    }
    return out
}

/**
 * Expand any @file references in the feature text by appending each referenced
 * file's contents, so the planning children (clarify, decompose) always see the
 * real spec inline instead of relying on the model to open the file itself.
 * Without this, clarify on a one-line "Implement @spec.md" tends to bail with
 * NONE because, to the model, the request looks small and unambiguous.
 * Unreadable mentions (typos, non-file @tokens) are left untouched; the feature
 * is returned verbatim when nothing readable is referenced.
 */
export async function expandFeatureMentions(cwd: string, feature: string): Promise<string> {
    const blocks: string[] = []
    for (const rel of mentionPaths(feature)) {
        try {
            // Normalize CRLF/CR so an @-mentioned design doc saved on Windows
            // inlines with LF endings the downstream phase parsers expect.
            const body = await readTextFile(path.resolve(cwd, rel))
            if (body.trim().length > 0) {
                blocks.push(`--- contents of ${rel} ---\n${body.trim()}`)
            }
        } catch {
            // not a readable file — leave the @token in place, skip expansion
        }
    }
    return blocks.length === 0 ? feature : `${feature.trim()}\n\n${blocks.join('\n\n')}`
}

/**
 * The @file references in the feature that point at a readable file on disk —
 * the bare path tokens, deduped, in first-seen order. Unreadable mentions
 * (typos, non-file @tokens) are dropped so we never advertise a missing file as
 * an authoritative spec.
 */
export async function readableMentions(cwd: string, feature: string): Promise<string[]> {
    const out: string[] = []
    for (const rel of mentionPaths(feature)) {
        try {
            await fsp.access(path.resolve(cwd, rel))
            out.push(rel)
        } catch {
            // not a readable file — don't thread it into task titles
        }
    }
    return out
}
