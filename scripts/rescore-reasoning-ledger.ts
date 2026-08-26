/**
 * Re-decide a finished A/B from its ledger, without touching the GPU.
 *
 * A ledger stores TRIALS, not a verdict: one JSON line per measured trial, with
 * the arm, whether it was usable, whether it terminated, and how long it took.
 * That makes a verdict recomputable at any time — so when the decision rule
 * changes, hours of measurement do not have to be spent again to find out what
 * the same data now says. It also means a verdict on disk can silently disagree
 * with the rule in the tree, which is what this script is for.
 *
 * Two ledger dialects exist, because two harnesses wrote them:
 *   live-reasoning-group-ab.ts       usable / nonTerminating
 *   live-implementation-thinking-ab.ts   pass / dead
 * Both are the same two axes under different names, so both are accepted and
 * the axis LABELS follow the dialect — a rescored implementation run must not
 * print "usable output" when what was measured was a VERIFY pass.
 *
 * TWO THINGS CAN BE RESCORED, and they are different.
 *
 *   the RULE      default. Re-runs the decision ladder over the stored
 *                 judgements. Cheap, and it is what a rung change needs.
 *   the SCORER    `--from-text`. Re-derives `usable` from the child's own
 *                 OUTPUT TEXT with the group's current production validator,
 *                 then re-runs the ladder. This is what a WRONG SCORER needs,
 *                 and three of five were wrong. Only ledgers written after the
 *                 harness started storing `output` can do it; the 28 voided
 *                 phase trials could not, which is why the field exists.
 *
 *   bun run scripts/rescore-reasoning-ledger.ts <ledger.jsonl> [group] [--from-text]
 *
 * `--axis precision` is a RESEARCH-only escape hatch. The live axis is the
 * conjunction — every named path real AND every edited file named — and the
 * precision half alone is the SATURATED axis that preceded it. It stays
 * reachable because the research cell's comment cites numbers measured on it,
 * and a citation nobody can re-run is a citation nobody can check.
 */
import {readFileSync} from 'node:fs'
import {REASONING_ON_LEVEL} from '../src/config/reasoning.js'
import {MX5, type ImplTask, implTasks} from './impl-ab-corpus.js'
import {type ArmStats, type AxisLabels, decide} from './reasoning-ab-decide.js'
import {
    editedExistingPaths,
    filesAnswered,
    filesGrounded,
    groundedPaths,
    namedRecall,
    treePaths
} from './reasoning-ab-files-truth.js'
import {GROUP_SCORERS, gateVerdictCorrect} from './reasoning-ab-scorers.js'

interface Row {
    arm?: unknown
    usable?: unknown
    truth?: unknown
    source?: unknown
    nonTerminating?: unknown
    pass?: unknown
    dead?: unknown
    ms?: unknown
    output?: unknown
    truncated?: unknown
}

const argv = process.argv.slice(2)
const fromText = argv.includes('--from-text')
const precisionOnly = argv.includes('--axis') && argv[argv.indexOf('--axis') + 1] === 'precision'
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--axis')
const path = positional[0]
if (path === undefined) {
    console.error(
        'usage: rescore-reasoning-ledger.ts <ledger.jsonl> [group] [--from-text]'
            + ' [--axis precision]'
    )
    process.exit(2)
}
const group = positional[1] ?? 'group'

const rows = readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Row)

if (rows.length === 0) {
    console.error(`ABSTAIN — ${path} holds no trials.`)
    process.exit(2)
}

// The dialect is read off the DATA, not off the filename: a ledger renamed or
// copied to another directory is still the run it recorded.
const impl = rows.some(r => 'pass' in r)
const labels: AxisLabels =
    impl ? {quality: 'VERIFY pass', termination: 'turn died'}
        // A gate row that carries `truth` was scored on whether the verdict was
        // RIGHT. Printing "usable output" beside it would name the saturated
        // axis this group was moved off, which is how a reader mistakes a real
        // measurement for the ceiling that preceded it.
    : group === 'gate' && rows.some(r => typeof r.truth === 'string') ?
        {quality: 'correct verdict', termination: 'no verdict at all'}
    : group === 'research' && fromText ?
        {
            quality: precisionOnly ? 'every path real' : 'real + edited named',
            termination: 'non-termination'
        }
    :   {quality: 'usable output', termination: 'non-termination'}
const dead = (r: Row): boolean => (impl ? r.dead === true : r.nonTerminating === true)
const stored = (r: Row): boolean => (impl ? r.pass === true : r.usable === true)

/**
 * The quality axis, either as the run recorded it or as today's scorer reads the
 * text back.
 *
 * A dead trial is never usable however its text scores: a worker that exited
 * non-zero can still have written something, and scoring that would count a
 * crash as an answer.
 */
let good = stored
if (fromText) {
    /**
     * `gate` is the one group whose quality is not a property of the text alone:
     * the same answer is right against one tree and wrong against the other. The
     * ledger carries `truth` for exactly this — the verdict the tree made
     * correct, executed with no model in the loop — so the row stays rescorable
     * without the corpus. A gate row written before that field existed was
     * scored on the SATURATED shape axis (10/10 both arms) and cannot be
     * upgraded from text; refusing is the only honest answer.
     */
    if (group === 'gate') {
        const noTruth = rows.filter(r => typeof r.truth !== 'string')
        if (noTruth.length > 0) {
            console.error(
                `ABSTAIN — ${noTruth.length}/${rows.length} gate rows carry no "truth" field.`
                    + ' Those trials ran against one corpus tree whose correct verdict was'
                    + ' unknown, so they were scored on "did it state a verdict at all" — an'
                    + ' axis that returned 10/10 in BOTH arms. There is nothing in the text'
                    + ' that can recover which answer was right. Re-measure against screened'
                    + ' trees; do not rescore.'
            )
            process.exit(2)
        }
    }
    /**
     * `research` is the second group whose quality is not a property of the text
     * alone: a named path is right or wrong only against the TREE the task
     * shipped. `GROUP_SCORERS.research` is production's `hasAnswerContent`, the
     * SATURATED shape check this group was moved off, so reaching it here would
     * quietly rescore onto a dead axis and print a verdict for it.
     *
     * The row carries `source` — the task id — and the corpus supplies the
     * after-tree, so the trial is fully rescorable with the corpus present.
     */
    if (group === 'research') {
        const noSource = rows.filter(r => typeof r.source !== 'string')
        if (noSource.length > 0) {
            console.error(
                `ABSTAIN — ${noSource.length}/${rows.length} research rows carry no "source".`
                    + ' A named path is real only against the tree ITS OWN task shipped, and'
                    + ' without the task id there is no tree to check it against.'
            )
            process.exit(2)
        }
        let tasks: Map<string, ImplTask>
        try {
            tasks = new Map(implTasks().map(t => [t.id, t]))
        } catch (e) {
            console.error(
                `ABSTAIN — the corpus at ${MX5} could not be read (${String(e).slice(0, 80)}).`
                    + ' Research rows are scored against each task\'s after-tree, so this one'
                    + ' needs AB_CORPUS pointed at the mx5 copy.'
            )
            process.exit(2)
        }
        const treeCache = new Map<string, ReadonlySet<string>>()
        const afterTree = (id: string): ReadonlySet<string> => {
            const t = tasks.get(id)
            if (!t) throw new Error(`ledger names ${id}, which is not in the corpus at ${MX5}`)
            let hit = treeCache.get(t.postCommit)
            if (!hit) {
                hit = treePaths(t.postCommit)
                treeCache.set(t.postCommit, hit)
            }
            return hit
        }
        const editCache = new Map<string, readonly string[]>()
        const edited = (id: string): readonly string[] => {
            const t = tasks.get(id)
            if (!t) throw new Error(`ledger names ${id}, which is not in the corpus at ${MX5}`)
            let hit = editCache.get(id)
            if (!hit) {
                hit = editedExistingPaths(t.preCommit, t.postCommit)
                editCache.set(id, hit)
            }
            return hit
        }
        if (precisionOnly) {
            good = (r: Row): boolean =>
                !dead(r) && filesGrounded(String(r.output), afterTree(String(r.source)))
        } else {
            /**
             * A task that edited NO pre-existing file has no recall to score,
             * and scoring it either way would be an invention: `false` marks a
             * correct answer wrong, `true` is vacuous truth. Refuse, and name
             * the reason — this is not a corner case. SEVEN of the ten tasks in
             * the first research ledger are greenfield scaffolding that only
             * creates files, which is why that run's 10/10 vs 10/10 could not
             * have separated the arms whatever they did.
             */
            const noTruth = [
                ...new Set(rows.map(r => String(r.source)).filter(id => edited(id).length === 0))
            ]
            if (noTruth.length > 0) {
                console.error(
                    `ABSTAIN — ${noTruth.length} task(s) in ${path} edit no pre-existing file:`
                        + ` ${noTruth.join(', ')}. The quality axis is the CONJUNCTION of "every`
                        + ' path named is real" and "every file the task edited is named", and'
                        + ' the second half does not exist for a task that only creates files.'
                        + ' Nothing in the stored text can recover it. Re-measure on tasks'
                        + ' screened by filesRecallStimuli; do not rescore.'
                )
                console.error(
                    '  To reproduce the SATURATED precision-only numbers this cell cites,'
                        + ' pass --axis precision.'
                )
                process.exit(2)
            }
            good = (r: Row): boolean =>
                !dead(r)
                && filesAnswered(
                    String(r.output),
                    afterTree(String(r.source)),
                    edited(String(r.source))
                )
        }
        const moved = rows.filter(r => good(r) !== stored(r)).length
        console.log(
            `rescored from text against each task's after-tree`
                + `${precisionOnly ? ' (PRECISION ONLY — the saturated axis)' : ''}:`
                + ` ${moved}/${rows.length} trial(s) changed side`
                + (moved === 0 ? ' — the stored judgements already agree with it' : '')
        )
        /**
         * VOLUME, per arm, printed whether or not it changed a verdict.
         *
         * The precision-only run tied 10/10 and the tie was a confound: `off`
         * named 119 real paths to `medium`'s 70. Those counts were computed by
         * hand after the fact, which is how a confound stays invisible for a
         * day. They are part of the output now.
         */
        for (const arm of ['off', REASONING_ON_LEVEL]) {
            const mine = rows.filter(r => r.arm === arm && !dead(r))
            let real = 0
            let found = 0
            let truth = 0
            for (const r of mine) {
                const g = groundedPaths(String(r.output), afterTree(String(r.source)))
                real += g.present
                const t = edited(String(r.source))
                if (t.length > 0) {
                    const rc = namedRecall(String(r.output), t)
                    found += rc.found
                    truth += rc.total
                }
            }
            console.log(
                `  ${arm.padEnd(6)} named ${real} real path(s)`
                    + (truth > 0 ? `, and ${found}/${truth} of the files its tasks edited` : '')
            )
        }
        console.log('')
    }
    const scorer =
        group === 'gate' || group === 'research' ? undefined : GROUP_SCORERS[group]
    if (group !== 'gate' && group !== 'research' && !scorer) {
        console.error(
            `ABSTAIN — no text scorer for group "${group}".`
                + ` Known: ${Object.keys(GROUP_SCORERS).join(', ')}.`
                + ' Pass the group as the second argument.'
        )
        process.exit(2)
    }
    const noText = rows.filter(r => typeof r.output !== 'string')
    if (noText.length > 0) {
        console.error(
            `ABSTAIN — ${noText.length}/${rows.length} rows in ${path} have no "output" field,`
                + ' so there is no text to rescore. That ledger predates the harness storing it;'
                + ' its trials can only be rescored against the RULE, not against the SCORER.'
        )
        process.exit(2)
    }
    const clipped = rows.filter(r => r.truncated === true)
    if (clipped.length > 0) {
        console.error(
            `ABSTAIN — ${clipped.length}/${rows.length} rows are truncated. Scoring a clipped`
                + ' answer is a new wrong scorer, which is the thing this mode exists to undo.'
        )
        process.exit(2)
    }
    if (group === 'gate') {
        good = (r: Row): boolean =>
            !dead(r) && gateVerdictCorrect(String(r.output), String(r.truth))
    } else if (group !== 'research') {
        good = (r: Row): boolean => !dead(r) && scorer!(String(r.output))
    }
    if (group !== 'research') {
        const moved = rows.filter(r => good(r) !== stored(r)).length
        console.log(
            `rescored from text with the "${group}" production scorer:`
                + ` ${moved}/${rows.length} trial(s) changed side`
                + (moved === 0 ? ' — the stored judgements already agree with it' : '')
        )
        console.log('')
    }
}

const stats = (arm: string): ArmStats => {
    const mine = rows.filter(r => r.arm === arm)
    return {
        n: mine.length,
        nonTerminating: mine.filter(dead).length,
        usable: mine.filter(good).length,
        msOfUsable: mine.filter(good).map(r => Number(r.ms)),
        // Ledgers written before `source` existed leave these undefined, and
        // the ladder then uses the unpaired test — the same answer the run
        // originally printed, rather than a pairing invented from row order.
        stimuliOfUsable:
            mine.every(r => typeof r.source === 'string') ?
                mine.filter(good).map(r => String(r.source))
            :   undefined
    }
}

const off = stats('off')
const on = stats(REASONING_ON_LEVEL)

// The same guard the live harnesses carry: a zero-vs-zero comparison "ties",
// and under a forced two-way verdict that tie would come down rung 3 and be
// written into the table as a decision. Nothing was compared, so nothing is.
if (off.usable === 0 && on.usable === 0) {
    console.error(`ABSTAIN — neither arm produced a usable answer in ${path}.`)
    console.error('Nothing was compared, so there is no verdict to recompute.')
    process.exit(2)
}
if (off.n === 0 || on.n === 0) {
    console.error(`ABSTAIN — ${path} has trials for only one arm.`)
    process.exit(2)
}

const {winner, rung, saturated, lines} = decide(off, on, 0.05, labels)
for (const l of lines) console.log(l)
console.log('')
console.log(`VERDICT (rescored from ${path}, group ${group}): ${winner}  [rung ${rung}]`)
if (saturated) {
console.log(
'NOT WRITABLE — the quality axis was saturated, so this run compared'
+ ' nothing. A cell written from it would record a prior as a'
+ ' measurement. Build an axis with headroom and re-measure; the'
+ ' ledger keeps the trials.'
)
} else {
    console.log(
        `Record it as: ${group}: '${winner}',  // A/B n=${off.n}/arm — off `
            + `${off.usable}/${off.n} ${labels.quality},`
            + ` ${REASONING_ON_LEVEL} ${on.usable}/${on.n}`
            + `, rung ${rung}${rung === 3 ? ' (PRIOR, not evidence)' : ''}`
    )
}
