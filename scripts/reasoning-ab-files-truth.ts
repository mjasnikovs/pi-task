/**
 * GROUND TRUTH FOR THE RESEARCH GROUP — do the paths the child names exist?
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The research cell was scored by `hasAnswerContent`: production's own test for
 * ">=2 lines of `name<gap>description`", which is exactly the FILES entry shape.
 * That scorer is CORRECT — it replaced one that demanded a bullet FILES entries
 * never carry — and it is still a shape check. It asks "does this look like a
 * FILES list", and a competent model produces one every time. The gate cell went
 * the same way and returned 10/10 in both arms; there is no reason to spend GPU
 * hours discovering that research does too.
 *
 * What a FILES worker is FOR is naming paths that are really there. Its own
 * prompt says so: "locate every path on disk the agent will read, edit, or
 * reference". A path that does not exist is the failure mode that matters, and
 * it is checkable with no model in the loop.
 *
 * WHICH TREE THE PATH MUST EXIST IN, and why it is the AFTER tree
 * --------------------------------------------------------------
 * A FILES list legitimately names two kinds of path: files that already exist
 * and are to be read, and files the task will CREATE. Checking the before-tree
 * would mark every correct "New file — to create" entry as a hallucination.
 * Checking the after-tree accepts both, because a file the task was supposed to
 * create exists in the tree the task shipped. Only a path that exists in neither
 * — a genuine invention — fails.
 *
 * MEASURED over the whole mx5 corpus, scoring each task's OWN RECORDED FILES
 * section against its own after-tree: 469 of 479 paths present, 97.9%, and 50 of
 * 56 tasks perfect. The known-good answer scores at the top of the axis, which
 * is the property a scorer must have before it is allowed to judge anything —
 * see [[ab-scorer-must-match-the-real-prompt]].
 *
 * THE CHILD RUNS IN THE BEFORE TREE, which is the condition the real research
 * worker ran in: the files to be created are genuinely absent, so naming them is
 * a prediction rather than an `ls`. Running in the finished tree would hand the
 * child the answer and push this axis toward the same ceiling the shape check
 * sits on.
 *
 * PRECISION ALONE IS DEAD — MEASURED 2026-08-26, first reading was INSTRUMENT
 * ------------------------------------------------------------------------
 * A 10-rep live run read `off 2/10 vs medium 8/10` and would have written
 * `research: 'medium'` at rung 1. It was the SCORER, twice over:
 *
 *   1. The screen reads a CLEAN recorded FILES section; the live child returns
 *      its WHOLE RAW TURN. Every prose line and every leaked `</tool_call>` had
 *      its first field taken as a path. TASK_0002's `off` answer named 11 paths,
 *      all 11 real, and scored 11/14 on three trailing tool-call tags.
 *   2. `git ls-tree` lists TRACKED files, and the child's tree also carries the
 *      symlinked `node_modules` it was reading. Six trials named a dependency
 *      file they had genuinely opened and were marked as inventing it.
 *
 * Both fixed here. RESCORED from the same stored text, no GPU: `off 10/10 vs
 * medium 10/10`. The axis sits at its ceiling in both arms, exactly like the
 * shape check it replaced, so the research cell stays `inherit` and NOTHING was
 * written into the table. The screen also improved, 50/56 -> 53/56, which is the
 * direction a correct fix moves the known-good answer.
 *
 * THE SCREEN IS NOT OPTIONAL, same as gate's. A task whose own recorded answer
 * does not score 100% is a task where the check disagrees with the known-good
 * answer, and the check loses. MEASURED: 6 of 56 tasks are dropped, TASK_0001
 * worst at 0/4 — a greenfield task whose entries carry a mangled `path:/workspace`
 * suffix that is not a path at all.
 *
 * WHAT REPLACED IT — THE CONJUNCTION, AND WHY THE STIMULI HAD TO CHANGE TOO
 * ------------------------------------------------------------------------
 * The 10/10 tie was not a null result, it was a confound: `off` named 119 real
 * paths to `medium`'s 70, more in 9 of 10 tasks and never fewer. Medium was
 * 1.65x faster because it said less, and a precision-only axis cannot see that.
 * So the axis is now {@link filesAnswered} — every path named is real AND every
 * pre-existing file the task edited is named. Precision alone rewards saying
 * less; recall alone is won outright by one `src/` entry; together neither can
 * be gamed.
 *
 * And the corpus moved with it, which is the part worth remembering.
 * {@link filesStimuli} kept the first ten tasks that scored 100% on precision:
 * TASK_0002..TASK_0012, the greenfield scaffolding at the head of the mx5 run.
 * SEVEN OF THOSE TEN EDIT NO PRE-EXISTING FILE AT ALL — they only create. The
 * run that returned 10/10 vs 10/10 was measuring recall on the tasks where
 * recall does not exist. {@link filesRecallStimuli} screens for it explicitly.
 */
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {isEntryLine} from '../src/workers/pi-worker-core.js'
import {MX5, type ImplTask, implTasks} from './impl-ab-corpus.js'

/**
 * Every path a FILES section names, one per line.
 *
 * The format its own prompt specifies is `<path>[:<line>]  <one-line purpose>`,
 * so the path is everything up to the first run of whitespace, minus a trailing
 * `:<digits>` line anchor. A bare `:` suffix that is NOT digits is left alone —
 * TASK_0001 emitted `package.json:/workspace`, and silently trimming that would
 * turn a malformed entry into a passing one.
 */
export function filesPaths(section: string): string[] {
    const out: string[] = []
    for (const raw of section.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        // A bare section heading is not an entry. FILES output carries none by
        // contract ("No section header"), but a recorded section keeps its own.
        if (/^[A-Z][A-Z -]*$/.test(line)) continue
        // AND NEITHER IS PROSE. The screen reads a CLEAN recorded section; the
        // live child returns its whole raw turn, preamble and leaked tool-call
        // tags included. Taking every line's first field made `</tool_call>` and
        // "Now I have complete context. Here is the FILES section:" into invented
        // paths, and an answer whose 11 real paths were all correct scored 11/14.
        // Production's own entry test decides it, so the two inputs are read by
        // one rule — see [[ab-scorer-must-match-the-real-prompt]].
        if (!isEntryLine(line)) continue
        const first = line
            .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
            .split(/\s{2,}|\t|\s+[—–-]\s+/)[0]
            ?.trim()
        if (!first) continue
        out.push(first.replace(/:\d+$/, ''))
    }
    return out
}

/**
 * A path git does not list but that is really on disk.
 *
 * `git ls-tree` reports TRACKED files, and the tree the child works in also
 * carries `node_modules` — impl-ab-corpus symlinks it in, because a worker that
 * cannot read its dependencies cannot do the job. Six research trials named a
 * `node_modules/**` file they had genuinely just read and were scored as having
 * invented it.
 *
 * Deliberately narrow: present on disk AND ignored by this repo's own rules.
 * "Present on disk" alone would accept a stray file the corpus never had, which
 * is the loose-scorer failure that is harder to spot than a strict one.
 */
const ignoredCache = new Map<string, boolean>()
export function ignoredButPresent(p: string, cwd: string = MX5): boolean {
    const key = `${cwd}\u0000${p}`
    const hit = ignoredCache.get(key)
    if (hit !== undefined) return hit
    let ok = false
    if (p !== '' && !p.startsWith('/') && fs.existsSync(path.join(cwd, p))) {
        try {
            // Exit 0 = ignored, 1 = not. execFileSync throws on non-zero.
            execFileSync('git', ['check-ignore', '-q', '--', p], {cwd, stdio: 'ignore'})
            ok = true
        } catch {
            ok = false
        }
    }
    ignoredCache.set(key, ok)
    return ok
}

/** Everything `git ls-tree` reports for a commit, plus every directory prefix. */
export function treePaths(commit: string, cwd: string = MX5): ReadonlySet<string> {
    const out = execFileSync('git', ['ls-tree', '-r', '--name-only', commit], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    })
    const set = new Set<string>()
    for (const f of out.split('\n')) {
        if (f === '') continue
        set.add(f)
        // Directory entries are legal FILES output — the prompt says to collapse
        // a whole tree to its root entry ("src/  one-line purpose") rather than
        // enumerate it. git lists no directories, so they are derived here.
        let d = path.posix.dirname(f)
        while (d !== '.' && d !== '/' && d !== '') {
            set.add(d)
            d = path.posix.dirname(d)
        }
    }
    return set
}

/** How many of a FILES section's paths are real, against one tree. */
export function groundedPaths(
    section: string,
    tree: ReadonlySet<string>,
    cwd: string = MX5
): {total: number; present: number; missing: string[]} {
    const paths = filesPaths(section)
    const missing = paths.filter(p => {
        const c = p.replace(/\/+$/, '')
        return !tree.has(c) && !ignoredButPresent(c, cwd)
    })
    return {total: paths.length, present: paths.length - missing.length, missing}
}

/**
 * THE RESEARCH QUALITY AXIS: every path the child named is real.
 *
 * STRICT on purpose. A fractional threshold would let a run hide one invented
 * path per answer, and one invented path is what sends an implementation child
 * to a file that is not there. The recorded answers clear this bar on 50 of 56
 * tasks, so it is a bar real work meets rather than an ideal.
 *
 * An answer naming NO paths scores false. That is not a shape check sneaking
 * back in: a FILES worker that located nothing did not do its job, and vacuous
 * truth would otherwise make the empty answer the highest-scoring one.
 */
export function filesGrounded(text: string, tree: ReadonlySet<string>): boolean {
    const g = groundedPaths(text, tree)
    return g.total > 0 && g.missing.length === 0
}

/**
 * THE FILES THE TASK REALLY HAD TO FIND: paths that existed BEFORE the turn and
 * that the turn then edited, deleted or renamed away.
 *
 * WHY THIS IS THE RECALL TRUTH, AND WHY IT EXCLUDES ADDED FILES
 * ------------------------------------------------------------
 * The precision axis above asks "is every path you named real". It saturated —
 * both arms 100% — and the ceiling hid a confound: `off` named 119 real paths to
 * `medium`'s 70, more in 9 of 10 tasks and never fewer. Medium was 1.65x faster
 * BECAUSE IT SAID LESS, and a precision-only axis cannot weigh that. Recall is
 * the missing half, and it must come from the SHIPPED TREE rather than from the
 * recorded answer — the recorded answers name only 37 paths across those ten
 * tasks, far fewer than either arm, so "more is better" is not established by
 * them either.
 *
 * ADDED files are deliberately NOT truth. MEASURED over the whole corpus: with
 * created files counted, the recorded answers score 49.0% recall and only 26 of
 * 55 tasks perfect — the CHECK loses, exactly the way phase's "every backticked
 * path exists" lost at 56.2%. That is not the answers being bad. Naming a file
 * that does not exist yet is a PREDICTION of a filename the spec never fixes,
 * while naming one that does exist is the located-it-on-disk job the prompt
 * actually sets. Restricted to pre-existing files the recorded answers score
 * 86.6% (71/82 paths, 29 of 38 tasks perfect), a bar real work meets.
 *
 * Generated artefacts are excluded for the same reason: `bun.lock` and the
 * `-snapshots/*.png` a test run writes are outputs of the turn, not paths anyone
 * researched.
 *
 * `.pi-tasks/` is the run's own state, written by the harness on every task.
 */
const GENERATED =
    /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.(png|jpe?g|webp|gif|ico|snap)$|-snapshots\/|__screenshots__\//
export function editedExistingPaths(
    preCommit: string,
    postCommit: string,
    cwd: string = MX5
): string[] {
    const out = execFileSync(
        'git',
        ['diff', '--name-status', '-z', `${preCommit}..${postCommit}`],
        {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}
    )
    // -z so a path with a space or a quote arrives whole. Renames and copies
    // carry TWO paths, so the record length varies and a fixed stride would
    // desynchronise the whole list at the first one.
    const f = out.split('\0').filter(s => s !== '')
    const files: string[] = []
    for (let i = 0; i < f.length; ) {
        const status = f[i]![0]
        if (status === 'R' || status === 'C') {
            // The OLD path is the one that existed before the turn. A copy's
            // old path was not edited, so only a rename counts.
            if (status === 'R') files.push(f[i + 1]!)
            i += 3
        } else {
            if (status === 'M' || status === 'D') files.push(f[i + 1]!)
            i += 2
        }
    }
    return files.filter(p => !p.startsWith('.pi-tasks/') && !GENERATED.test(p))
}

/**
 * How many of the files a task really edited the answer names.
 *
 * EXACT paths only — a named directory does NOT cover the files beneath it.
 * The prompt does allow collapsing a subtree to one entry, so this looked like a
 * cost, and it is not: MEASURED over all 38 tasks with truth, ZERO recorded
 * answers need directory coverage to score. Allowing it would let one `src/`
 * entry claim perfect recall over the whole repository, which is the loose-
 * scorer failure that is harder to spot than a strict one.
 */
export function namedRecall(
    section: string,
    truth: readonly string[]
): {total: number; found: number; missing: string[]} {
    const named = new Set(filesPaths(section).map(p => p.replace(/\/+$/, '')))
    const missing = truth.filter(t => !named.has(t))
    return {total: truth.length, found: truth.length - missing.length, missing}
}

/**
 * THE RESEARCH QUALITY AXIS, BOTH HALVES: every path named is real AND every
 * file the task really edited is named.
 *
 * The conjunction is the point. Precision alone saturates and rewards saying
 * less; recall alone is won by naming the whole tree. Neither half can be
 * gamed without losing the other.
 *
 * A trial with no truth files scores FALSE rather than vacuously true — see
 * {@link filesRecallStimuli}, which refuses to make such a task a stimulus at
 * all, so this is a guard against a caller that skipped the screen.
 */
export function filesAnswered(
    text: string,
    tree: ReadonlySet<string>,
    truth: readonly string[]
): boolean {
    if (truth.length === 0) return false
    return filesGrounded(text, tree) && namedRecall(text, truth).missing.length === 0
}

/** One task whose recorded FILES answer is fully grounded in its own after-tree. */
export interface FilesStimulus {
    id: string
    /** The tree the child works in — the files to create are genuinely absent. */
    beforeCommit: string
    /** The tree a named path must exist in, created files included. */
    afterCommit: string
    /** The `## refined prompt` the real FILES worker was handed. */
    refined: string
    /**
     * The pre-existing files the task edited — the recall half of the axis.
     * Absent on a stimulus screened by {@link filesStimuli}, which measures
     * precision only.
     */
    edited?: readonly string[]
}

export interface FilesScreenOutcome {
    id: string
    usable: boolean
    detail: string
}

/**
 * Screen every task by scoring its OWN recorded FILES section against its own
 * after-tree, and keep only the ones that score 100%.
 *
 * No model, no trees on disk, no GPU: `git ls-tree` and a string split. The
 * whole corpus screens in under a second, which is why this one is not behind a
 * task-list knob the way gate's is.
 */
export function filesStimuli(opts: {
    /** `(task) => the task's recorded FILES section`, from the corpus doc. */
    recordedFiles: (t: ImplTask) => string | undefined
    /** `(task) => the task's recorded `## refined prompt``. */
    refinedPrompt: (t: ImplTask) => string | undefined
    limitTasks?: number
    log?: (line: string) => void
}): {stimuli: FilesStimulus[]; screened: FilesScreenOutcome[]} {
    const log = opts.log ?? ((l: string) => console.log(l))
    const screened: FilesScreenOutcome[] = []
    const stimuli: FilesStimulus[] = []
    for (const t of implTasks()) {
        if (opts.limitTasks !== undefined && stimuli.length >= opts.limitTasks) break
        const recorded = opts.recordedFiles(t)
        const refined = opts.refinedPrompt(t)
        if (!recorded || recorded.trim() === '' || !refined || refined.trim() === '') {
            screened.push({id: t.id, usable: false, detail: 'no recorded FILES or refined prompt'})
            continue
        }
        const g = groundedPaths(recorded, treePaths(t.postCommit))
        if (g.total === 0) {
            screened.push({id: t.id, usable: false, detail: 'recorded FILES names no path'})
            continue
        }
        if (g.missing.length > 0) {
            screened.push({
                id: t.id,
                usable: false,
                // The CHECK is what failed here, not the recorded answer. Scoring
                // a child against a bar the known-good answer misses would mark
                // correct work wrong — the loose-scorer trap, inverted.
                detail:
                    `recorded FILES is ${g.present}/${g.total} grounded`
                    + ` (${g.missing.slice(0, 3).join(', ')}) — the CHECK loses, not the answer`
            })
            continue
        }
        screened.push({id: t.id, usable: true, detail: `recorded FILES ${g.total}/${g.total}`})
        stimuli.push({
            id: t.id,
            beforeCommit: t.preCommit,
            afterCommit: t.postCommit,
            refined
        })
    }
    log(
        `files screen: ${stimuli.length}/${screened.length} task(s) whose own recorded`
            + ' FILES is fully grounded in their own after-tree'
    )
    return {stimuli, screened}
}

/**
 * Screen for the CONJUNCTION axis: keep a task only if its own recorded FILES
 * section is both fully grounded in the after-tree AND names every pre-existing
 * file the task went on to edit.
 *
 * WHY THIS SCREEN IS SEPARATE FROM {@link filesStimuli}, AND WHY IT MUST BE
 * ---------------------------------------------------------------------------
 * It selects a DIFFERENT CORPUS, and that is the finding this axis produced
 * before it measured anything. The precision screen kept the first ten tasks
 * that scored 100%, which are TASK_0002..TASK_0012 — the greenfield scaffolding
 * at the start of the mx5 run. MEASURED: seven of those ten tasks edit NO
 * pre-existing file at all; they only create. There is no recall to measure
 * there, so the ten trials that scored 10/10 vs 10/10 on precision could not
 * have shown a recall difference however large it was. A limit that takes the
 * first N passing tasks took exactly the tasks the axis cannot see.
 *
 * `minEdited` defaults to 2 for the same reason the saturation guard exists. A
 * task that edits ONE pre-existing file gives the child one chance to miss, and
 * an answer naming a dozen paths usually contains it. Requiring two leaves the
 * axis somewhere to move. MEASURED over the corpus: 27 tasks clear both halves
 * with at least one edited file, 10 with at least two.
 */
export function filesRecallStimuli(opts: {
    recordedFiles: (t: ImplTask) => string | undefined
    refinedPrompt: (t: ImplTask) => string | undefined
    /** How many pre-existing edited files a task must have to be a stimulus. */
    minEdited?: number
    limitTasks?: number
    log?: (line: string) => void
}): {stimuli: FilesStimulus[]; screened: FilesScreenOutcome[]} {
    const log = opts.log ?? ((l: string) => console.log(l))
    const minEdited = opts.minEdited ?? 2
    const screened: FilesScreenOutcome[] = []
    const stimuli: FilesStimulus[] = []
    for (const t of implTasks()) {
        if (opts.limitTasks !== undefined && stimuli.length >= opts.limitTasks) break
        const recorded = opts.recordedFiles(t)
        const refined = opts.refinedPrompt(t)
        if (!recorded || recorded.trim() === '' || !refined || refined.trim() === '') {
            screened.push({id: t.id, usable: false, detail: 'no recorded FILES or refined prompt'})
            continue
        }
        const edited = editedExistingPaths(t.preCommit, t.postCommit)
        if (edited.length < minEdited) {
            screened.push({
                id: t.id,
                usable: false,
                detail:
                    `edits ${edited.length} pre-existing file(s), needs ${minEdited}`
                    + ' — nothing to recall'
            })
            continue
        }
        const g = groundedPaths(recorded, treePaths(t.postCommit))
        if (g.total === 0 || g.missing.length > 0) {
            screened.push({
                id: t.id,
                usable: false,
                detail:
                    g.total === 0 ?
                        'recorded FILES names no path'
                    :   `recorded FILES is ${g.present}/${g.total} grounded — the CHECK loses`
            })
            continue
        }
        const r = namedRecall(recorded, edited)
        if (r.missing.length > 0) {
            screened.push({
                id: t.id,
                usable: false,
                // Same rule as the precision half: a bar the known-good answer
                // misses may not judge a child.
                detail:
                    `recorded FILES names ${r.found}/${r.total} edited file(s)`
                    + ` (missing ${r.missing.slice(0, 3).join(', ')}) — the CHECK loses`
            })
            continue
        }
        screened.push({
            id: t.id,
            usable: true,
            detail: `recorded FILES ${g.total}/${g.total} real, ${r.total}/${r.total} edited named`
        })
        stimuli.push({
            id: t.id,
            beforeCommit: t.preCommit,
            afterCommit: t.postCommit,
            refined,
            edited
        })
    }
    log(
        `files recall screen: ${stimuli.length}/${screened.length} task(s) whose own recorded`
            + ` FILES is 100% real AND names every one of its >=${minEdited} edited files`
    )
    return {stimuli, screened}
}
