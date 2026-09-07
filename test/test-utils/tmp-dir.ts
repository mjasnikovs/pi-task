/**
 * tmpDir — a throwaway directory that is removed even when the test throws.
 *
 * WHY NOT try/finally AT EACH SITE. `withTmpTaskDir` in this directory does exactly
 * that and is correct, and `pi-task-test-` still left 2,237 directories in `/tmp`:
 * a helper only cleans up for the callers that use it, and a test that throws
 * between a bare `mkdtemp` and its own `rmSync` cleans up for nobody. Across eight
 * prefixes the suite filled a tmpfs — 1,048,576 of 1,048,576 inodes — and what broke
 * first was `docker exec`, unable to create its own control file.
 *
 * WHY THE HOOK LIVES HERE AND NOT IN A PRELOAD. A preload that wrapped `mkdtemp`
 * would need no cooperation at all, and `node:fs`'s exports are readonly under bun:
 * "Attempted to assign to readonly property". Registering `afterAll` at module scope
 * is the next best thing — `--isolate` gives each test file its own module registry,
 * so this initialises once per file and its hook belongs to that file.
 *
 * Removal is best-effort. A directory a test already removed, or one still held
 * open, must never fail a run that is otherwise green.
 */
import {afterAll} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const made: string[] = []

afterAll(() => {
    for (const dir of made) {
        try {
            fs.rmSync(dir, {recursive: true, force: true})
        } catch {
            // See the header.
        }
    }
    made.length = 0
})

/** A fresh directory under the system temp dir, swept when the file finishes. */
export function tmpDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    made.push(dir)
    return dir
}
