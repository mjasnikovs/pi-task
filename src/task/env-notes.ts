/**
 * env-notes — a per-run cache of ENVIRONMENT FACTS shared across gate children.
 *
 * The failure this serves (mx5 run 7, F8): every gate child re-discovers the
 * same environment facts from scratch — where the DB credentials live, which
 * services are reachable, which tools are installed — burning minutes of
 * archaeology per child through the serial model bottleneck.
 *
 * Mechanism: children EMIT facts as `ENV-NOTE: <fact>` lines in their answer
 * text; the HOST parses and appends them to `.pi-tasks/env-notes.md` (children
 * never write the file — no artifact corruption, host-side dedupe). The file
 * lives under `.pi-tasks/`, so it survives discardEdits and the git-state
 * guard, both of which exclude that directory by design.
 *
 * SCOPE — facts only, never verdicts, never spec content: an endpoint, a
 * credential LOCATION, a tool's presence/version, a service's reachability.
 * And the cache must not become a pre-prepared runway that masks missing
 * project setup: the verify-as-shipped rule ("any prep you needed IS the
 * defect") still governs every verdict — the block injected into prompts says
 * so explicitly. The cache only kills re-discovery time.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'

const ENV_NOTES_FILE = 'env-notes.md'
/** Cap kept notes so a chatty run cannot grow the prompt block unboundedly. */
const MAX_NOTES = 40
/** A single fact is one line; anything longer is prose, not a fact. */
const MAX_NOTE_LENGTH = 240

export function envNotesFile(cwd: string): string {
    return path.join(tasksDir(cwd), ENV_NOTES_FILE)
}

/** The cached notes, one fact per line ('' when none were recorded yet). */
export async function readEnvNotes(cwd: string): Promise<string> {
    try {
        return (await fsp.readFile(envNotesFile(cwd), 'utf8')).trim()
    } catch {
        return ''
    }
}

/**
 * Pull `ENV-NOTE: <fact>` lines out of a child's answer text. Deduplicated,
 * length-capped; verdict markers can never match (different prefix).
 */
export function extractEnvNotes(text: string): string[] {
    const notes: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(/^[ \t]*ENV-NOTE:[ \t]*(.+)$/gm)) {
        const note = m[1].trim()
        if (note.length === 0 || note.length > MAX_NOTE_LENGTH) continue
        const key = note.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        notes.push(note)
    }
    return notes
}

/**
 * Append newly discovered facts to the cache, deduplicated against what is
 * already there (case-insensitive full-line match), keeping the newest
 * MAX_NOTES. Failures are swallowed — the cache is a sharpener, never a
 * blocker.
 */
export async function appendEnvNotes(cwd: string, notes: string[]): Promise<void> {
    if (notes.length === 0) return
    try {
        const existing = (await readEnvNotes(cwd)).split('\n').filter(l => l.trim().length > 0)
        const seen = new Set(existing.map(l => l.trim().toLowerCase()))
        const merged = [...existing]
        for (const note of notes) {
            const key = note.trim().toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(note.trim())
        }
        const kept = merged.slice(-MAX_NOTES)
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        await fsp.writeFile(envNotesFile(cwd), kept.join('\n') + '\n', 'utf8')
    } catch {
        // best-effort cache
    }
}

/**
 * The prompt block a gate child receives when notes exist. The caveat is
 * load-bearing: facts save re-discovery time but grant no waiver from the
 * verify-as-shipped rule.
 */
export function buildEnvNotesBlock(notes: string): string {
    if (notes.trim().length === 0) return ''
    return [
        'KNOWN ENVIRONMENT FACTS — discovered by earlier verification passes in this run',
        '(informational, may be stale):',
        ...notes
            .trim()
            .split('\n')
            .map(n => `- ${n}`),
        'These facts only save you re-discovery time (where credentials/config live, which',
        'tools are installed, which services are reachable). They are NOT a license to',
        'prepare or repair the run: the verify-as-shipped rules below still govern the',
        'verdict — if the project needs something its own committed files do not provide,',
        'that remains the defect no matter what is listed here.',
        ''
    ].join('\n')
}

/** The emit instruction appended to bash-capable gate-child prompts. */
export const ENV_NOTE_EMIT_INSTRUCTION = [
    'ENVIRONMENT FACTS — share what you discover: when you establish a durable fact about',
    'THIS MACHINE or the project environment (a service reachable/absent at an address, where',
    'credentials/config live, a tool or runtime present/missing and its version), emit a line',
    '  ENV-NOTE: <one-line fact>',
    'anywhere in your answer, one per fact. Facts about the ENVIRONMENT only — never task',
    'verdicts, never spec content, never code judgments. These are cached for later',
    'verification passes in this run so they do not re-discover the same things.'
].join('\n')
