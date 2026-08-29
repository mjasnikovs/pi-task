/**
 * owned-freeze-reassign — the DETERMINISTIC resolution for the owned/freeze
 * unsatisfiable pair: an AUTHORITATIVE owned requirement whose only implementing
 * file the same spec FREEZES. No model, no prose edit. The requirement text is
 * never altered — only which task's ledger entry carries it, so "resolution by
 * deletion" is structurally impossible. That is the whole point: a model asked to
 * remove a contradiction can satisfy the request by deleting the requirement, and
 * removal of the pair is not satisfaction of the requirement.
 *
 * ── THE MECHANISM: DETACH, then CLAIM ───────────────────────────────────────
 *
 * Two steps, each run where the information it needs actually exists:
 *
 *   DETACH  at the conflicting task's own critique (`critiquePhase`, right after
 *           `appendOwnedConstraints` stamps the bullet, which is the first moment
 *           the pair exists): the entry is marked `pending: [frozen paths]` in the
 *           ledger and its stamped bullet is dropped from this spec. It is now
 *           owned by nobody; `ownedForTitle` skips it; the quote is still there,
 *           byte for byte.
 *   CLAIM   at every LATER task's compose, before the belt block is built: if that
 *           task's REFINED PROMPT shows a write intent on one of the pending
 *           paths, the entry becomes that task's own — belt into its compose,
 *           braces onto its spec. First claimant wins.
 *
 * ── WHY NOT "PICK THE TARGET AT DETACH TIME" ─────────────────────────────────
 *
 * The obvious rule is "if exactly one OTHER task in the plan names path `P`, move
 * the requirement there". It needs COMPOSED SPECS, and at the conflicting task's
 * compose the later tasks are still bare plan titles. A plan title describes a
 * slice of behaviour, not a file list, so a path-lexical target rule at detach
 * time finds nothing to point at.
 *
 * The claimant knows what the planner did not. By its own compose the later task
 * has a REFINED prompt, which does say which files it will write — and
 * `writeIntent` reads exactly that, while its negation fence keeps every sibling
 * that merely mentions the path in order to fence itself off it.
 *
 * ── WHY NOT CARRY IT AS CROSS-CUTTING ────────────────────────────────────────
 *
 * The cross-cutting channel is for prohibitions and product-wide rules
 * (`isCrossCuttingRequirement`; `accountCoverage` only routes those there). A
 * task-specific deliverable clause carried that way lands in every task that has
 * not run yet, none of which owns the file — spec inflation dressed as a fix. An
 * entry nobody claims stays `pending` and `unclaimedPendingRequirements` surfaces
 * it at the end of the run (run-final-gate.ts), so it becomes a debt the run can
 * see rather than an obligation that quietly evaporated.
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
 * The negation half is not decoration. A refined prompt routinely names the files
 * its task must NOT touch, in the same sentence as a write verb — "Do not create
 * or modify any other files outside this slice (e.g. no changes to `X`)". Without
 * the fence check, every such sibling claims `X`.
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
        // past it — matching only the verb→path span misses a fenced spec entirely.
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
 * First claimant wins: `delete entry.pending` runs before the entry is retitled,
 * so a later task finds nothing pending to take. The test named
 * `inv-single-owner` pins that.
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
