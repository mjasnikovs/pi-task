/**
 * ledger — the ONE read-modify-write ritual behind every run-level line file under
 * `.pi-tasks/` (contracts, launch-contract, env-notes, accept-debt, repair-queue,
 * requirements, requirements-owned).
 *
 * Six modules each kept their own copy of the same seven steps: read the file
 * (ANY error → ''), parse it into records, key the records, drop an incoming item
 * whose key is already present, cap to the newest MAX (oldest dropped), mkdir the
 * tasks dir, write the whole file back (`lines.join('\n') + '\n'`, plain
 * `writeFile`, NOT atomic), and swallow every fault — a ledger is a sharpener or
 * an auditing aid, never a blocker of the phase or gate that calls it. What
 * genuinely varied per site is the DATA SHAPE (file name, cap, key, line format,
 * parser) and exactly one RULE — what an append does when it adds nothing new
 * (see `onNoop`). Everything else here is the ritual, so a module that keeps a
 * ledger is an ADAPTER: it declares its ledger and calls read/append/write.
 *
 * Contract details a caller can rely on:
 *   • `readRaw` is the trimmed file text ('' when absent or unreadable). Prompt-block
 *     builders take this string.
 *   • `read` is `parse(readRaw)`; every parser skips blank lines and lines it cannot
 *     read, so a corrupt line is dropped, never thrown on.
 *   • `append` with an empty batch is a no-op (no read, no write). Within a batch
 *     the first item with a key wins; a key already stored wins over the batch.
 *   • `write` overwrites with exactly these records; an empty list writes an empty
 *     file (this is how a drained queue and a fully-resolved debt ledger look).
 *   • Neither `append` nor `write` ever throws.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'

export interface LedgerSpec<T> {
    /** File name under `.pi-tasks/` (e.g. `contracts.md`). */
    file: string
    /**
     * Keep the newest `max` records on append (oldest dropped). Absent = uncapped
     * (a ledger that is only ever overwritten whole, like requirements-owned).
     */
    max?: number
    /** Dedupe key — two records with equal keys are one record. */
    key: (item: T) => string
    /** One record → one stored line (must not contain '\n'). */
    serialize: (item: T) => string
    /** Stored text → records; skips what it cannot read rather than throwing. */
    parse: (raw: string) => T[]
    /**
     * What `append` does when every incoming item was already stored:
     *   'rewrite' (default) — write the merged list back anyway, which re-caps an
     *     over-long file and canonicalises lines the parser normalised or dropped;
     *   'skip' — leave the file untouched (a single-record "no double-record"
     *     ledger: a duplicate is a return, not a write).
     * The two are observably different when the file has drifted from what the
     * writer produces, so it is an option, not a unification.
     */
    onNoop?: 'rewrite' | 'skip'
}

export interface Ledger<T> {
    /** Absolute path of the ledger file for this cwd. */
    path(cwd: string): string
    /** Trimmed stored text; '' when absent or on any read error. */
    readRaw(cwd: string): Promise<string>
    /** Parsed records; [] when absent or on any read error. */
    read(cwd: string): Promise<T[]>
    /** Merge new records in (deduped, capped) and write back. Never throws. */
    append(cwd: string, items: T[]): Promise<void>
    /** Overwrite with exactly these records. Never throws. */
    write(cwd: string, items: T[]): Promise<void>
}

export function makeLedger<T>(spec: LedgerSpec<T>): Ledger<T> {
    const {file, max, key, serialize, parse} = spec
    const onNoop = spec.onNoop ?? 'rewrite'
    const filePath = (cwd: string): string => path.join(tasksDir(cwd), file)

    async function readRaw(cwd: string): Promise<string> {
        try {
            return (await fsp.readFile(filePath(cwd), 'utf8')).trim()
        } catch {
            return ''
        }
    }

    async function read(cwd: string): Promise<T[]> {
        return parse(await readRaw(cwd))
    }

    async function persist(cwd: string, items: T[]): Promise<void> {
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        const content = items.length === 0 ? '' : items.map(serialize).join('\n') + '\n'
        await fsp.writeFile(filePath(cwd), content, 'utf8')
    }

    async function append(cwd: string, items: T[]): Promise<void> {
        if (items.length === 0) return
        try {
            const existing = await read(cwd)
            const seen = new Set(existing.map(key))
            const merged = [...existing]
            for (const item of items) {
                const k = key(item)
                if (seen.has(k)) continue
                seen.add(k)
                merged.push(item)
            }
            if (merged.length === existing.length && onNoop === 'skip') return
            const kept = max === undefined ? merged : merged.slice(-max)
            await persist(cwd, kept)
        } catch {
            // best-effort ledger
        }
    }

    async function write(cwd: string, items: T[]): Promise<void> {
        try {
            await persist(cwd, items)
        } catch {
            // best-effort ledger
        }
    }

    return {path: filePath, readRaw, read, append, write}
}
