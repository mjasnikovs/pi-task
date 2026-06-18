/**
 * Log-replay validation for the orientation core (see orientation.ts).
 *
 * Ground truth: the per-worker `read:` sequences captured in a real /task-auto-run
 * over the mx5 codebase (28 tasks, 4 sequential research workers each), extracted
 * verbatim from the debug logs into mx5-read-traces.json along with each file's
 * real byte size. No live model is involved — we replay the reads the workers
 * actually issued and measure how many the orientation pre-supply would remove.
 *
 * The pre-supplied set is computed by the *actual shipping* buildOrientation,
 * driven by a reader that returns each file at its real recorded size — so the
 * real selection ranking, byte budget, per-file cap and file-count cap all apply
 * exactly as they would in production. A read is *eliminated* iff its path is in
 * that supplied set. Pre-supply is purely additive (nothing is blocked), so the
 * no-regression check is structural: every supplied path is a real tracked file
 * the workers actually read, so it can never hide a file a worker needed.
 */
import {describe, expect, test} from 'bun:test'
import {buildOrientation} from './orientation.js'
import fixture from './__fixtures__/mx5-read-traces.json'

const {traces, sizes} = fixture as {
    traces: Record<string, Record<string, string[]>>
    sizes: Record<string, number>
}

function allReads(): string[] {
    const out: string[] = []
    for (const workers of Object.values(traces))
        for (const reads of Object.values(workers)) out.push(...reads)
    return out
}

// Orientation is applied only to the read-heavy workers (FILES, APIS) — verified
// by live A/B that CONTEXT/TOOLING read ~0 files and only paid prefill. So the
// reads it can remove are exactly those workers' reads. See phaseResearch.
const ORIENTED_WORKERS = new Set(['worker:files', 'worker:apis'])
function orientedReads(): string[] {
    const out: string[] = []
    for (const workers of Object.values(traces))
        for (const [name, reads] of Object.entries(workers))
            if (ORIENTED_WORKERS.has(name)) out.push(...reads)
    return out
}

// The inventory a real run sees is `git ls-files` — tracked project files only.
// Model it from the paths that have a recorded size (the ones that exist in the
// repo); node_modules / absolute escapes are excluded by the selector regardless.
const inventory = Object.keys(sizes)

// Reader backing buildOrientation with content of the file's real byte length, so
// the budget logic sees true sizes without shipping file bodies in the fixture.
const sizeReader = async (p: string): Promise<string | null> =>
    p in sizes ? 'x'.repeat(sizes[p]) : null

describe('current status (baseline from real mx5 run)', () => {
    test('workers re-read the same files: a large share of reads are repeats', () => {
        const total = allReads().length
        let crossWorkerRepeats = 0
        for (const workers of Object.values(traces)) {
            // Within one task, a file read by more than one worker is redundant
            // work — the second+ worker re-derives what the first already had.
            const seenInTask = new Set<string>()
            for (const reads of Object.values(workers)) {
                const seenInWorker = new Set<string>()
                for (const p of reads) {
                    if (seenInWorker.has(p)) continue // intra-worker dup (guarded elsewhere)
                    seenInWorker.add(p)
                    if (seenInTask.has(p)) crossWorkerRepeats++
                    else seenInTask.add(p)
                }
            }
        }
        // Recorded reality: 2067 reads, and hundreds are a different worker
        // re-reading a file already read in the same task — the targeted waste.
        expect(total).toBe(2067)
        expect(crossWorkerRepeats).toBeGreaterThan(600)
    })
})

describe('orientation pre-supply effect (replay through shipping buildOrientation)', () => {
    test('removes a meaningful share of the read-heavy workers reads', async () => {
        const {block, supplied} = await buildOrientation(inventory, sizeReader)
        // Ceiling, not a measured speedup: how many reads issued by the oriented
        // workers land on a pre-supplied file. Live A/B confirmed the model then
        // does not re-read those (0 core re-reads), so this is the upper bound on
        // reads removed. The wall-clock win is bimodal — biggest when a worker
        // would otherwise spiral (FILES 19-22 reads, APIS 37 reads / 221s) — and
        // is measured live, not here.
        const reads = orientedReads()
        const removable = reads.filter(p => supplied.has(p)).length
        const pct = Math.round((100 * removable) / reads.length)
        const blockKB = (Buffer.byteLength(block, 'utf8') / 1024).toFixed(1)
        console.log(
            `orientation supplies ${supplied.size} files in a ${blockKB}KB block; `
                + `removable FILES+APIS reads: ${removable}/${reads.length} (${pct}%)`
        )
        // Floor, so a selection regression (dropping a hot tier, budget shrink)
        // trips the test. The bound is enforced by buildOrientation itself.
        expect(removable).toBeGreaterThan(200)
        expect(pct).toBeGreaterThanOrEqual(25)
    })

    test('the hot orientation files are captured under the real budget', async () => {
        const {supplied} = await buildOrientation(inventory, sizeReader)
        // The files the recorded run read most often must survive selection AND
        // the byte budget — these are exactly the cold re-reads being removed.
        for (const hot of [
            'package.json',
            'src/types/index.ts',
            'src/server/lib/zod-schemas.ts',
            'src/client/lib/api.ts',
            'tsconfig.json',
            'src/server/index.ts'
        ]) {
            expect(supplied.has(hot)).toBe(true)
        }
    })

    test('no regression: every supplied path is a file the workers actually read', async () => {
        const {supplied} = await buildOrientation(inventory, sizeReader)
        const everRead = new Set(allReads())
        for (const p of supplied) expect(everRead.has(p)).toBe(true)
    })
})
