import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Stable content hash for a thinking block. Determinism of the compressor at
 *  temperature 0 (validated against the local model) makes this a safe cache
 *  key: identical reasoning compresses to identical output, so each unique
 *  block is sent to the model exactly once, ever. */
export function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}

/** Disk-backed `hash -> compressed text` store. The on-disk file lets the
 *  "compress once" guarantee survive process restarts, not just jiti reloads. */
export class CompressionCache {
    private mem = new Map<string, string>()
    private loaded = false
    constructor(private readonly file: string) {}

    private load(): void {
        if (this.loaded) return
        this.loaded = true
        try {
            const obj = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>
            for (const [k, v] of Object.entries(obj)) this.mem.set(k, v)
        } catch {
            // No cache file yet (or unreadable) — start empty.
        }
    }

    get(hash: string): string | undefined {
        this.load()
        return this.mem.get(hash)
    }

    has(hash: string): boolean {
        this.load()
        return this.mem.has(hash)
    }

    set(hash: string, compressed: string): void {
        this.load()
        this.mem.set(hash, compressed)
        try {
            fs.mkdirSync(path.dirname(this.file), {recursive: true})
            fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.mem)))
        } catch {
            // Best-effort persistence; the in-memory copy still serves this run.
        }
    }

    get size(): number {
        this.load()
        return this.mem.size
    }
}
