/**
 * Log-replay validation for the orientation core (see orientation.ts).
 *
 * The fixture holds the per-worker `read:` sequences from a recorded /task-auto
 * run — 28 tasks, each with between one and four of the research workers — plus
 * each read file's byte size. No model runs here: the reads are replayed and
 * counted against the set orientation would have pre-supplied.
 *
 * That set comes from the shipping `buildOrientation`, driven by a reader that
 * returns each file at its recorded size, so the real ranking, byte budget,
 * per-file cap and file-count cap all apply. A read is eliminated iff its path is
 * in the supplied set. Pre-supply is purely additive — nothing is blocked — so
 * the no-regression check is structural: every supplied path must be a file the
 * workers actually read, and then it cannot hide one they needed.
 */
import {describe, expect, test} from 'bun:test'
import {buildOrientation} from '../../src/task/orientation.js'
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

// phaseResearch hands the orientation block to every worker that explores by
// reading — FILES, APIS and CONTEXT (which holds `read,grep`) — so a pre-supplied
// core replaces reads they would make. TOOLING is scoped to the GOAL prose and
// single-read-guarded, so for it the block is prefill with no read to displace.
const ORIENTED_WORKERS = new Set(['worker:files', 'worker:apis', 'worker:context'])
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

// The design doc the recorded run was planned from — the file the tasks @-cite,
// and the one the selector cannot reach by convention. Replaying without it would
// measure a selector the real run never used.
const CITED = ['DESIGN/mx5-marketplace-design.md']

describe('the recorded baseline', () => {
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
        // Both numbers are read off the fixture: the total, and how many reads are a
        // SECOND worker in the same task re-reading a file a sibling already read.
        expect(total).toBe(2067)
        expect(crossWorkerRepeats).toBeGreaterThan(600)
    })
})

describe('orientation pre-supply effect (replay through shipping buildOrientation)', () => {
    test('removes a meaningful share of the read-heavy workers reads', async () => {
        const {block, supplied} = await buildOrientation(inventory, sizeReader, {cited: CITED})
        // A ceiling, not a speedup: how many reads the oriented workers issued that
        // land on a pre-supplied file. Whether the model then skips such a read is
        // not decidable from a replay, so this is an upper bound.
        const reads = orientedReads()
        const removable = reads.filter(p => supplied.has(p)).length
        const pct = Math.round((100 * removable) / reads.length)
        const blockKB = (Buffer.byteLength(block, 'utf8') / 1024).toFixed(1)
        console.log(
            `orientation supplies ${supplied.size} files in a ${blockKB}KB block; `
                + `removable reading-worker reads: ${removable}/${reads.length} (${pct}%)`
        )
        // Floor, so a selection regression (dropping a hot tier, budget shrink)
        // trips the test. The bound is enforced by buildOrientation itself.
        expect(removable).toBeGreaterThan(350)
        expect(pct).toBeGreaterThanOrEqual(35)
    })

    test('the hot orientation files are captured under the real budget', async () => {
        const {supplied} = await buildOrientation(inventory, sizeReader, {cited: CITED})
        // The files the recorded run read most often must survive selection AND
        // the byte budget — these are exactly the cold re-reads being removed. The
        // 29KB design doc is on the list and does not displace the rest, which is
        // what the cited purse is for.
        for (const hot of [
            ...CITED,
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
        const {supplied} = await buildOrientation(inventory, sizeReader, {cited: CITED})
        const everRead = new Set(allReads())
        for (const p of supplied) expect(everRead.has(p)).toBe(true)
    })
})
