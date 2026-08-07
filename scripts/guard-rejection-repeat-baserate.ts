/**
 * STEP 7 of nexttask 15 — how often is a final-gate fix attempt rejected by a
 * write-guard, and how often does the NEXT attempt repeat the same rejected
 * action? That second number is the only thing 15D (carrying the rejection reason
 * into the retry prompt) could act on.
 *
 * Read-only, no model. Walks every `final-gate-debug.log` and every
 * `TASK_AUTO_*.md` under ~/hub, ~/tmp and ~/.cache.
 *
 * MEASURED 2026-08-07 — and the corpus is WIDER than nexttask15.md assumed. The
 * doc said `final-gate-debug.log` exists in exactly one tree; there are 33.
 *
 *     final-gate-debug.log files                      33
 *     fix-pass attempts across all of them            35   (32 trees x1, mx5 x3)
 *     attempts REJECTED by a write-guard               2   (both mx5, both the
 *                                                          deletion guard, both
 *                                                          the same 3 screenshots)
 *     CONSECUTIVE-attempt pairs available              2   (mx5 1→2 and 2→3;
 *                                                          the other 32 trees have
 *                                                          one attempt each, so
 *                                                          they cannot produce a
 *                                                          repeat by construction)
 *     episodes: rejected AND the next attempt
 *               repeated the same rejected action      1   (mx5 attempts 1→2)
 *
 * 1 < 3, so 15D is CLOSED on its pre-registered gate.
 *
 * RECORD THE REASON AS "NOT MEASURABLE ON THIS CORPUS", NOT "DOES NOT HAPPEN".
 * The wider corpus turns out to be 32 single-attempt runs: a run that never took a
 * second attempt cannot exhibit the failure 15D targets, so it contributes to the
 * denominator of "how often are attempts rejected" and to nothing else. And 15A
 * removes THIS episode's cause, which says nothing about the other guards
 * (frozen-path, shrink, scope-shrink, probe-gaming) whose rejections travel the
 * same silent path — `seed = fin.reason` at auto-orchestrator.ts, where `fin` is
 * the ORIGINAL gate outcome and a guard rejection never updates it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const HOME = os.homedir()
const ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]
const MAX_DEPTH = 8

/** Every guard that rejects an attempt and discards its edits (final-gate-fix.ts). */
const REJECTION_RE =
    /DELETION GUARD|SHRINK GUARD|FROZEN-PATH GUARD|edits discarded|removed the gate's own command|probe-gaming/

const rel = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)

function findFiles(root: string, match: (name: string) => boolean): string[] {
    const out: string[] = []
    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            const p = path.join(dir, e.name)
            if (e.isSymbolicLink()) continue
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name === '.git') continue
                walk(p, depth + 1)
            } else if (match(e.name)) {
                out.push(p)
            }
        }
    }
    walk(root, 0)
    return out
}

/** The DELETED path set of each `tree changes` line, in order, for one log. */
function deletionsPerAttempt(text: string): string[][] {
    const out: string[][] = []
    for (const line of text.split('\n')) {
        const m = /tree changes:.*?DELETED \[([^\]]*)\]/.exec(line)
        if (!m) continue
        out.push(
            m[1]
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .sort()
        )
    }
    return out
}

function main(): void {
    const logs: string[] = []
    const autos: string[] = []
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        logs.push(...findFiles(root, n => n === 'final-gate-debug.log'))
        autos.push(...findFiles(root, n => /^TASK_AUTO_.*\.md$/.test(n)))
    }

    let attempts = 0
    let rejections = 0
    let pairs = 0
    let repeats = 0
    const detail: string[] = []

    for (const f of logs) {
        let text: string
        try {
            text = fs.readFileSync(f, 'utf8')
        } catch {
            continue
        }
        const starts = (text.match(/final-fix start/g) ?? []).length
        const rejected = text.split('\n').filter(l => REJECTION_RE.test(l)).length
        attempts += starts
        rejections += rejected
        if (starts > 1) pairs += starts - 1
        if (rejected === 0) continue

        // A REPEAT: attempt N was rejected for deleting a set of paths, and
        // attempt N+1 deleted the same set again.
        const dels = deletionsPerAttempt(text)
        let localRepeats = 0
        for (let i = 0; i + 1 < dels.length; i++) {
            if (dels[i].length > 0 && dels[i].join('|') === dels[i + 1].join('|')) localRepeats += 1
        }
        repeats += localRepeats
        detail.push(
            `  ${rel(f)}\n      attempts ${starts}, guard rejections ${rejected}, `
                + `repeated-action episodes ${localRepeats}`
        )
    }

    const autosWithAttempts = autos.filter(f => {
        try {
            return /autofix attempt/.test(fs.readFileSync(f, 'utf8'))
        } catch {
            return false
        }
    })

    console.log(`scanned roots: ${ROOTS.map(rel).join(', ')} (max depth ${MAX_DEPTH})`)
    console.log('')
    console.log(`final-gate-debug.log files                     ${logs.length}`)
    console.log(`TASK_AUTO_*.md files                           ${autos.length}`)
    console.log(`…of which mention an autofix attempt           ${autosWithAttempts.length}`)
    console.log('')
    console.log(`fix-pass attempts (final-fix start)            ${attempts}`)
    console.log(`attempts REJECTED by a write-guard             ${rejections}`)
    console.log(`consecutive-attempt PAIRS available            ${pairs}`)
    console.log(`episodes: rejected AND next attempt repeated   ${repeats}`)
    console.log('')
    for (const d of detail) console.log(d)
    console.log('')
    console.log(
        repeats < 3 ?
            `VERDICT: ${repeats} < 3 — 15D is CLOSED. The reason is "NOT MEASURABLE ON THIS CORPUS", `
                + `not "does not happen": ${logs.length - 1} of the ${logs.length} runs took exactly ONE fix `
                + `attempt, so they cannot exhibit a repeat by construction.`
        :   `VERDICT: ${repeats} >= 3 — 15D is alive; go to STEP 8.`
    )
}

main()
