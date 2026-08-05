/**
 * owned-freeze-reassign — the DETERMINISTIC resolution for the owned/freeze
 * unsatisfiable pair (nexttask 2): an AUTHORITATIVE owned requirement whose only
 * implementing file the same spec FREEZES. No model, no prose edit. The
 * requirement text is never altered — only which task's ledger entry carries it,
 * so "resolution by deletion" is structurally impossible.
 *
 * WHY NOT A REWRITE. Measured on mx5 run 18 (scripts/live-owned-freeze-conflict
 * -ab.ts, 20 trials/arm): forcing the pair through the critique seam drives
 * pair-present 8/20 → 0/20, but 11 of the 20 resolutions DELETE the
 * AUTHORITATIVE clause instead of moving it, and the delivered VERIFY still
 * greps `package.json` in both arms (6/20). Removal of the pair is not
 * satisfaction of the requirement.
 *
 * ── THE MECHANISM: DETACH, then CLAIM ───────────────────────────────────────
 *
 * Two steps, each run where the information it needs actually exists:
 *
 *   DETACH  at the conflicting task's own critique (right after the braces
 *           stamp the bullet, which is the first moment the pair exists): the
 *           entry is marked `pending: [frozen paths]` in the ledger and its
 *           stamped bullet is dropped from this spec. It is now owned by
 *           nobody; `ownedForTitle` skips it; the quote is still there, byte for
 *           byte.
 *   CLAIM   at every LATER task's compose, before the belt block is built: if
 *           that task's REFINED PROMPT shows a write intent on one of the
 *           pending paths, the entry becomes that task's own — belt into its
 *           compose, braces onto its spec.
 *
 * ── WHY NOT "PICK THE TARGET AT DETACH TIME", WHICH IS WHAT nexttask2.md ASKS ─
 *
 * nexttask2.md's branch 1 is "if exactly one OTHER task in the plan names path
 * `P` — its title or its spec's file list contains `P` — move the requirement
 * there". Measured over all 60 recorded composed specs on disk
 * (scripts/owned-freeze-reassign-baserate.ts), on the one conflict the corpus
 * contains (mx5 run 19 TASK_0015, path `src/server/index.ts`):
 *
 *     title-only    3 candidates   TASK_0014 TASK_0016 TASK_0017
 *     FILES-only    7 candidates   TASK_0016 … TASK_0025
 *     either        8 candidates   → "exactly one" NEVER holds
 *
 * and, decisively, that measurement is against RECORDED SPECS, which production
 * does not have: at the conflicting task's compose the later tasks are still
 * bare plan titles. None of run 19's 26 plan titles contains the string
 * `src/server/index.ts` — TASK_0017's reads "Client API layer — typed
 * hono/client hc<AppType> in api.ts, small fetch/mutation hooks, SPA fallback
 * route on server". A path-lexical target rule at detach time is therefore
 * BLIND IN PRODUCTION (0 candidates), the same way the run-18 critique probe was.
 *
 * The claimant knows what the planner did not. By its own compose, TASK_0017 has
 * a refined prompt that says "add an SPA fallback route to the existing server
 * `src/server/index.ts`". Over run 19's 26 refined prompts, `writeIntent` on that
 * path fires on exactly two: TASK_0014 (which created the file, already run) and
 * TASK_0017. Nothing else in the plan claims it — six other specs mention the
 * path, all of them to fence themselves off it.
 *
 * ── WHY NOT nexttask2.md's BRANCH 2 (CARRY EVERYTHING CROSS-CUTTING) ────────
 *
 * The cross-cutting channel is for prohibitions and product-wide rules
 * (`isCrossCuttingRequirement`; `accountCoverage` only routes those there). The
 * corpus conflict is a task-specific deliverable clause — carrying it would push
 * "the server serves static `dist/`" into the 11 tasks that had not yet run,
 * none of which owns the server file. That is spec inflation dressed as a fix.
 * An entry nobody claims stays `pending` and is surfaced at the end of the run
 * (`unclaimedPendingRequirements`), which is a debt the run can see rather than
 * an obligation that quietly evaporated.
 */
import {
    findOwnedFreezeConflicts,
    type OwnedFreezeConflict,
    type OwnedFreezeOptions
} from './owned-freeze-conflict.js'
import {ownedForTitle, type OwnedRequirement} from './requirements.js'
import {PROHIBITION_RE} from './prohibition-probe.js'

export type ReassignAction =
    | {kind: 'detach'; quote: string; from: string; paths: string[]}
    | {kind: 'claim'; quote: string; by: string; paths: string[]}
    | {kind: 'unresolved'; quote: string; from: string; paths: string[]; reason: string}

export interface DetachResult {
    /** The ledger after the pass — same quotes, one of them now unowned. */
    ledger: OwnedRequirement[]
    /** The spec with the detached requirement's stamped bullet removed.
     *  Byte-identical to the input when nothing detached. */
    spec: string
    actions: ReassignAction[]
}

/**
 * Does this text CLAIM a write on `p` — a create/modify verb reaching a mention
 * of the path, not fenced by a negation?
 *
 * The negation half is not decoration. Every sibling task's refined prompt names
 * the files it must not touch ("Do not create or modify any other files outside
 * this slice (e.g., no changes to `src/server/index.ts`, …)" — mx5 run 19
 * TASK_0008). Without the fence check that spec claims the server file; with it,
 * run 19's 26 refined prompts yield exactly the two tasks that do write it.
 */
export function writeIntent(text: string, p: string): boolean {
    const re = new RegExp(
        String.raw`\b(?:creat|add|implement|modif|updat|extend|wir|writ|mount|chang)\w*\b`
            + String.raw`[^.\n]{0,140}?`
            + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi'
    )
    for (const m of text.matchAll(re)) {
        // The negation usually sits BEFORE the verb, so the window reaches back
        // past it — matching only the verb→path span misses TASK_0008 entirely.
        const from = Math.max(0, (m.index ?? 0) - 90)
        const window = text.slice(from, (m.index ?? 0) + m[0].length)
        if (NEGATED_RE.test(window) || PROHIBITION_RE.test(window)) continue
        return true
    }
    return false
}

/** Negations that turn a write verb into a fence. Deliberately broader than
 *  `PROHIBITION_RE`, which requires "do not"+verb adjacency and so never sees
 *  "no changes to `X`" or "any files other than `Y`". */
const NEGATED_RE =
    /\b(?:do(?:es)?\s+not|don'?t|must\s+not|may\s+not|never|no|not|other\s+than|outside(?:\s+of)?|except|besides|avoid|without|nor|unchanged|untouched)\b/i

/** The machine stamp `appendOwnedConstraints` writes. Only stamped lines are
 *  ever removed — a quote compose folded in itself is model prose, and this pass
 *  does not edit prose. */
const STAMP_RE = /owned\s+requirement\s+from\s+the\s+source\s+design/i

function stampedLineFor(spec: string, quote: string): string | null {
    for (const raw of spec.split('\n')) {
        if (STAMP_RE.test(raw) && raw.includes(quote)) return raw
    }
    return null
}

function dropLine(spec: string, line: string): string {
    const lines = spec.split('\n')
    const i = lines.indexOf(line)
    if (i < 0) return spec
    lines.splice(i, 1)
    return lines.join('\n')
}

/**
 * DETACH every owned requirement this spec makes unsatisfiable: mark it
 * `pending` on the frozen paths and drop its stamped bullet. Pure bookkeeping —
 * no quote leaves the ledger, no prose is touched.
 */
export function detachUnsatisfiableRequirements(args: {
    spec: string
    /** The executing task's plan title — the ledger's join key. */
    title: string
    ledger: OwnedRequirement[]
    isSource?: OwnedFreezeOptions['isSource']
}): DetachResult {
    const mine = ownedForTitle(args.ledger, args.title)
    const conflicts: OwnedFreezeConflict[] = findOwnedFreezeConflicts(args.spec, {
        owned: mine,
        isSource: args.isSource
    })
    const out: DetachResult = {
        ledger: args.ledger.map(o => ({...o})),
        spec: args.spec,
        actions: []
    }
    for (const c of conflicts) {
        const entry = out.ledger.find(
            o =>
                !(o.pending && o.pending.length > 0)
                && c.requirement.includes(o.quote)
                && normalise(o.title) === normalise(args.title)
        )
        if (!entry) {
            // The conflicting line is not one of THIS task's ledger quotes (a
            // stamp from an earlier plan round, or a quote the ledger no longer
            // holds). Nothing to detach; the spec is left exactly as it is.
            out.actions.push({
                kind: 'unresolved',
                quote: c.requirement,
                from: args.title,
                paths: c.paths,
                reason: 'no ledger entry owns this line'
            })
            continue
        }
        const line = stampedLineFor(out.spec, entry.quote)
        if (line === null) {
            out.actions.push({
                kind: 'unresolved',
                quote: entry.quote,
                from: args.title,
                paths: c.paths,
                reason: 'the quote is model prose, not a machine-stamped bullet'
            })
            continue
        }
        entry.pending = [...c.paths]
        out.spec = dropLine(out.spec, line)
        out.actions.push({kind: 'detach', quote: entry.quote, from: args.title, paths: c.paths})
    }
    return out
}

export interface ClaimResult {
    ledger: OwnedRequirement[]
    actions: ReassignAction[]
}

/**
 * CLAIM the detached requirements this task will actually implement: those whose
 * pending paths its refined prompt writes. Run at the START of compose, so the
 * claimed obligation rides the same belt block every owned requirement does.
 *
 * First claimant wins (`inv-single-owner`): the entry stops being pending the
 * moment it is claimed, so a later task cannot take it as well.
 */
export function claimPendingRequirements(args: {
    /** The claiming task's refined prompt — the text that says what it will write. */
    intent: string
    /** The claiming task's plan title (the ledger's join key). */
    title: string
    ledger: OwnedRequirement[]
}): ClaimResult {
    const out: ClaimResult = {ledger: args.ledger.map(o => ({...o})), actions: []}
    if (args.title.trim().length === 0) return out
    for (const entry of out.ledger) {
        const paths = entry.pending ?? []
        if (paths.length === 0) continue
        const claimed = paths.filter(p => writeIntent(args.intent, p))
        if (claimed.length === 0) continue
        delete entry.pending
        entry.title = args.title
        out.actions.push({kind: 'claim', quote: entry.quote, by: args.title, paths: claimed})
    }
    return out
}

/** Entries still detached — obligations no task claimed. Surfaced at the end of
 *  a run so an unsatisfiable requirement becomes a visible debt instead of a
 *  silent drop. */
export function unclaimedPendingRequirements(ledger: OwnedRequirement[]): OwnedRequirement[] {
    return ledger.filter(o => (o.pending ?? []).length > 0)
}

const normalise = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

/** One line per action, for the run's debug log. */
export function formatReassignActions(actions: ReassignAction[]): string {
    return actions
        .map(a =>
            a.kind === 'detach' ?
                `owned-freeze DETACH: "${a.quote.slice(0, 80)}" — frozen ${a.paths.join(', ')} in this task;`
                + ' released to the task that writes it'
            : a.kind === 'claim' ?
                `owned-freeze CLAIM: "${a.quote.slice(0, 80)}" — this task writes ${a.paths.join(', ')}`
            :   `owned-freeze UNRESOLVED: "${a.quote.slice(0, 80)}" — ${a.reason}`
        )
        .join('\n')
}
