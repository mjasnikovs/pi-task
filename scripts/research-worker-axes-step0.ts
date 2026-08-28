/**
 * STEP 0 for the three UNMEASURED research cells — apis, context, tooling.
 *
 * WHY THIS RUNS BEFORE ANY GPU. `research` was split into four cells on
 * 2026-08-28 and only ONE of them has a ledger: `research:files`
 * (ledger-research.jsonl is literally a FILES worker replayed in the before
 * tree). The other three would each need an axis, and this repo's rule is that
 * an axis must clear the KNOWN-GOOD answer before it may judge anything, must
 * still have headroom when it does, and must read the same kind of input the
 * trial produces. All three are checkable offline against the recorded corpus,
 * so the cheapest honest question is asked here: does a candidate axis LOSE
 * against the answers production actually shipped?
 *
 * Each candidate is screened both ways:
 *   CEILING  the recorded section, scored as-is. A recorded answer that fails
 *            means the CHECK is losing, not the model.
 *   FLOOR    the same section with one content token altered per entry. A floor
 *            that still passes means the check says yes to everything.
 *
 * Prints per-task detail, because a screen that only reports a rate reads as
 * "the corpus is like this" when it is really "the check disagreed here".
 *
 *   AB_CORPUS=/home/edgars/hub/ab-grouplab/mx5-copy \
 *     bun run scripts/research-worker-axes-step0.ts [apis|context|tooling|all]
 */
import {execFileSync} from 'node:child_process'
import {openRecordedRun} from './ab-corpus.js'
import {implTasks, MX5} from './impl-ab-corpus.js'
import {treePaths} from './reasoning-ab-files-truth.js'
import {classifyCommand, toolingCommands} from './reasoning-ab-tooling-truth.js'
import {EXIT_CODE} from './ab-verdict.js'

const which = (process.argv[2] ?? 'all').trim()

/** One bare ALL-CAPS block out of a recorded `## research` section. */
export function researchBlock(research: string, heading: string): string | undefined {
    const re = new RegExp(
        `^${heading}[ \\t]*$([\\s\\S]*?)(?=^[A-Z][A-Z -]*[ \\t]*$|(?![\\s\\S]))`,
        'm'
    )
    return re.exec(research)?.[1]
}

// ─── AXIS T lives in reasoning-ab-tooling-truth.ts ───────────────────────────
//
// The screen and the harness MUST run the same checker. A screen that drifts
// from the live one publishes a stimulus set the axis cannot express — that is
// recorded, measured, and the reason the research precision screen shipped ten
// tasks that edit no pre-existing file.

// ─── AXIS C: every project path a CONTEXT bullet backticks is real ───────────

/** A backticked token that LOOKS like a repo path — has a slash or a known ext. */
const PATHISH = /^[A-Za-z0-9._@][\w./@+-]*$/
const EXT = /\.(ts|tsx|js|jsx|mts|cts|json|sql|css|html|yml|yaml|toml|md|sh)$/

export function contextPaths(block: string): string[] {
    const out: string[] = []
    for (const m of block.matchAll(/`([^`]+)`/g)) {
        const t = m[1]!.trim()
        if (!PATHISH.test(t)) continue
        // A bare `foo.ts` with no directory is a filename, not a path — the
        // phase path-axis audit found those are what a suffix match saturates
        // on. Keep only tokens that carry a directory OR a real extension.
        if (!t.includes('/') && !EXT.test(t)) continue
        out.push(t.replace(/[:#].*$/, '').replace(/\/+$/, ''))
    }
    return [...new Set(out)]
}

// ─── AXIS A: every dotted symbol an APIS entry names is in the tree ──────────

const SYMBOLISH = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)+$/

export function apisSymbols(block: string): string[] {
    const out: string[] = []
    for (const raw of block.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        const first = line.split(/\s{2,}|\t/)[0]?.trim()
        if (!first || !SYMBOLISH.test(first)) continue
        out.push(first)
    }
    return [...new Set(out)]
}

/** Is the symbol's LAST segment present anywhere in the tracked source? */
function symbolInTree(sym: string, commit: string, cache: Map<string, boolean>): boolean {
    const last = sym.split('.').pop()!
    const hit = cache.get(last)
    if (hit !== undefined) return hit
    let ok: boolean
    try {
        execFileSync('git', ['grep', '-q', '-w', '-F', '--', last, commit], {
            cwd: MX5,
            stdio: 'ignore'
        })
        ok = true
    } catch {
        ok = false
    }
    cache.set(last, ok)
    return ok
}

// ─── The screen ──────────────────────────────────────────────────────────────

/**
 * IMPORT-SAFE. Everything below runs only when this file is the entry point.
 * Without the guard, importing one of the exported checkers LAUNCHES THE WHOLE
 * SCREEN — the same trap live-reasoning-group-ab.ts's top-level `await main()`
 * set, which is why the scorers live in their own module. Measured: a two-line
 * script that imported `classifyCommand` printed the entire three-axis report
 * before its own first line.
 */
function main(): void {

    const run = openRecordedRun(MX5)
    if (!run) {
        console.error(`ABSTAIN — no recorded run at ${MX5}.`)
        process.exit(EXIT_CODE.ABSTAIN)
}
    const byId = new Map(run.tasks().map(t => [t.id, t]))
    const tasks = implTasks()
    console.log(`corpus: ${MX5}`)
    console.log(`tasks with both trees: ${tasks.length}`)
    console.log('')

    interface Row {
        id: string
        total: number
        bad: number
        detail: string
}

    function report(name: string, rows: Row[], floor: Row[]): void {
        const scored = rows.filter(r => r.total > 0)
        const clean = scored.filter(r => r.bad === 0)
        const fscored = floor.filter(r => r.total > 0)
        const fclean = fscored.filter(r => r.bad === 0)
        const items = scored.reduce((a, r) => a + r.total, 0)
        const badItems = scored.reduce((a, r) => a + r.bad, 0)
        console.log(`── ${name} ──`)
        console.log(`  material:  ${scored.length}/${rows.length} task(s) have something to score`)
        console.log(`  CEILING:   ${clean.length}/${scored.length} recorded answers clean`)
        console.log(`             ${items - badItems}/${items} items grounded`)
        const fitems = fscored.reduce((a, r) => a + r.total, 0)
        const fbad = fscored.reduce((a, r) => a + r.bad, 0)
        console.log(
            `  FLOOR:     ${fclean.length}/${fscored.length} mutated answers still clean`
                + ` (${fitems - fbad}/${fitems} items correctly rejected)`
        )
        for (const r of scored.filter(x => x.bad > 0).slice(0, 12)) {
            console.log(`    ${r.id}: ${r.bad}/${r.total} bad — ${r.detail}`)
        }
        console.log('')
}

    /**
     * Alter the DECISIVE token so a real item becomes a near-miss.
     *
     * The first version altered the first lowercase triple anywhere in the string,
     * which for `Hono.delete` produced `Honozq.delete` — same last segment, still
     * grounded. A floor that leaves the checked token intact measures nothing, and
     * it read 13/28 APIS answers as "still clean" for exactly that reason.
     */
    const mutateLast = (s: string): string => {
        const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('.'), s.lastIndexOf(' '))
        const head = s.slice(0, i + 1)
        const tail = s.slice(i + 1)
        return head + (tail.length >= 3 ? `zq${tail}` : `${tail}zq`)
}

    if (which === 'tooling' || which === 'all') {
        const rows: Row[] = []
        const floor: Row[] = []
        for (const t of tasks) {
            const research = byId.get(t.id)?.section('research')?.trim()
            // TOOLING FIRST, VERIFIED-TOOLING ONLY AS A FALLBACK. The live
            // trial scores the worker's RAW output; `phaseVerifyTooling`
            // replaces TOOLING with the verify child's FILTERED `verified`
            // list, so preferring VERIFIED-TOOLING computed this ceiling on a
            // post-verification artefact and judged the axis on a pre-
            // verification one — [[ab-scorer-must-see-the-same-input]]. A task
            // whose TOOLING was replaced in place still falls back, because a
            // filtered block is better than no block.
            const block =
                research ?
                    (researchBlock(research, 'TOOLING') ?? researchBlock(research, 'VERIFIED-TOOLING'))
                :   undefined
            if (!block) {
                rows.push({id: t.id, total: 0, bad: 0, detail: 'no tooling block'})
                floor.push({id: t.id, total: 0, bad: 0, detail: ''})
                continue
            }
            const cmds = toolingCommands(block)
            const scored = cmds.map(c => ({c, v: classifyCommand(c, t.preCommit)}))
            const checkable = scored.filter(s => s.v.verdict !== 'unknown')
            const bad = checkable.filter(s => s.v.verdict === 'invented')
            rows.push({
                id: t.id,
                total: checkable.length,
                bad: bad.length,
                detail:
                    bad.map(b => `${b.c} (${b.v.why})`).slice(0, 2).join('; ')
                    + ` [${cmds.length - checkable.length} unknown]`
            })
            // THE FLOOR IS SCORED ONLY OVER COMMANDS THE CHECK CALLED REAL, and it
            // asks whether breaking one flips it to `invented`. Mutating every
            // command and dropping the `unknown`s read 24/45 "still clean" — the
            // mutation had turned `bunx tsc` into `bunx zqtsc`, which is unknown
            // rather than wrong, so the floor was measuring its own blind spot.
            const wasReal = scored.filter(s => s.v.verdict === 'real' && s.v.token)
            const flipped = wasReal.filter(s => {
                // Break THE TOKEN THE CHECK DECIDED ON, not the last word. Mutating
                // the last word turned `bunx tsc --noEmit` into `bunx tsc zq--noEmit`
                // — same binary, still real — and only 9 of 102 commands flipped.
                const broken = s.c.replace(s.v.token!, `zq${s.v.token!}`)
                return classifyCommand(broken, t.preCommit).verdict === 'invented'
            })
            floor.push({
                id: t.id,
                total: wasReal.length,
                bad: wasReal.length - flipped.length,
                detail: ''
            })
        }
        report('TOOLING — every command is runnable in the before-tree', rows, floor)
}

    if (which === 'context' || which === 'all') {
        const rows: Row[] = []
        const floor: Row[] = []
        for (const t of tasks) {
            const research = byId.get(t.id)?.section('research')?.trim()
            const block = research ? researchBlock(research, 'CONTEXT') : undefined
            if (!block) {
                rows.push({id: t.id, total: 0, bad: 0, detail: 'no CONTEXT block'})
                floor.push({id: t.id, total: 0, bad: 0, detail: ''})
                continue
            }
            const tree = treePaths(t.postCommit)
            const paths = contextPaths(block)
            const missing = paths.filter(p => !tree.has(p))
            rows.push({
                id: t.id,
                total: paths.length,
                bad: missing.length,
                detail: missing.slice(0, 4).join(', ')
            })
            const fpaths = paths.map(mutateLast)
            floor.push({
                id: t.id,
                total: fpaths.length,
                bad: fpaths.filter(p => !tree.has(p)).length,
                detail: ''
            })
        }
        report('CONTEXT — every backticked project path exists in the after-tree', rows, floor)
}

    if (which === 'apis' || which === 'all') {
        const rows: Row[] = []
        const floor: Row[] = []
        for (const t of tasks) {
            const research = byId.get(t.id)?.section('research')?.trim()
            const block = research ? researchBlock(research, 'APIS') : undefined
            if (!block) {
                rows.push({id: t.id, total: 0, bad: 0, detail: 'no APIS block'})
                floor.push({id: t.id, total: 0, bad: 0, detail: ''})
                continue
            }
            const cache = new Map<string, boolean>()
            const syms = apisSymbols(block)
            const missing = syms.filter(s => !symbolInTree(s, t.postCommit, cache))
            rows.push({
                id: t.id,
                total: syms.length,
                bad: missing.length,
                detail: missing.slice(0, 4).join(', ')
            })
            const fsyms = syms.map(mutateLast)
            floor.push({
                id: t.id,
                total: fsyms.length,
                bad: fsyms.filter(s => !symbolInTree(s, t.postCommit, cache)).length,
                detail: ''
            })
        }
        report('APIS — every dotted symbol named is present in the after-tree', rows, floor)
}
}

if (import.meta.main) main()
