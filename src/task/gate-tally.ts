/**
 * The final gate's tally: everything its sections RECORD, and the one pure
 * function that turns the record into a `FinalGateOutcome`.
 *
 * Carried inline, this is twelve mutable locals in `runFinalIntegrationGate` — the
 * ranked failure list, four dynamic counters, three note lists, a warning list,
 * the boot verdict — threaded through ~400 lines by closure, with three sections
 * hand-incrementing the same counters and one branch doing `dynObserved -= 1`.
 * The verdict assembly at the end was pure, but reachable only through a temp
 * dir and real spawns. Here the sections call named methods (an attempt is
 * `attempted(bin)`, the config-gap un-count is `unobserve()`, a probe that looked
 * and saw something bad is `failObserved(...)`) and `verdict()` is the ONE place
 * the PASS / FAIL / UNOBSERVED polarity, note ordering and debt attachment live,
 * testable with no tree at all.
 *
 * The two verdict predicates the gate has always exported — `observabilityGapFailure`
 * and `unobservedVerdict` (the third, non-blocking
 * verdict) — live here because they read exactly the counters the tally owns;
 * `final-gate.ts` re-exports them so every existing importer is unchanged.
 */
import type {AcceptDebt} from './accept-debt.js'
import type {FinalGateOutcome} from './final-gate.js'

/**
 * Full-skip blindness guard. Per-command env-gap skips stay
 * legitimate (a missing browser must not fail a suite); what may never happen
 * again is ALL of them skipping while the gate still reports PASS — a gate that
 * observed nothing dynamic has no basis to vouch for the assembled app. Pure so
 * the semantics are unit-tested; the tally feeds it its own counters plus runner
 * resolvability.
 */
export function observabilityGapFailure(args: {
    /** Dynamic commands the gate discovered and tried to run. */
    attempted: number
    /** Of those, how many it actually OBSERVED (a real pass OR a real fail —
     *  either proves the command ran; only skips observe nothing). */
    observed: number
    /** Of the skips, how many were SPAWN failures (runner never ran, ENOENT).
     *  Tool-level gaps (missing browser, 127 inside the chain, timeout) prove
     *  the runner itself works and keep the classic env-gap contract — the
     *  blindness class fires only when EVERY attempt failed to even spawn. */
    spawnFailures: number
    /** Distinct runner bins across the attempted commands. */
    runnerBins: string[]
    /** Is this runner spawnable (bare or via a known install location)? */
    runnerResolvable: (bin: string) => boolean
}): string | null {
    if (args.attempted === 0 || args.observed > 0) return null
    if (args.spawnFailures < args.attempted) return null
    const unresolvable = args.runnerBins.filter(b => !args.runnerResolvable(b))
    const runnerNote =
        unresolvable.length > 0 ?
            ` — the project's own runner ${unresolvable
                .map(b => `\`${b}\``)
                .join(', ')} is not spawnable here (not on PATH nor any known install location)`
        :   ''
    return (
        `observability gap: ${args.attempted} integration/boot command(s) exist but NONE `
        + `could even spawn in this environment${runnerNote}; `
        + `the gate observed nothing dynamic and cannot vouch for the assembled app`
    )
}

/**
 * The THIRD verdict. observabilityGapFailure above covers "commands were DISCOVERED
 * but every one failed to spawn" — a rank-0 FAIL. It deliberately returns null for
 * `attempted === 0`, and until now that silence fell straight through to
 * `PASS — no integration command found (statics passed)`: the blindness class
 * entering through a different door, where "we never checked" reads exactly like "we
 * checked and it was fine". Measured 2026-07-27: one real project (C++/CMake, no package.json)
 * shipped that verdict TWICE while carrying 2 and 3 open verify-FAIL debts, and
 * godot-engine (package.json whose only script is `verify`) reproduces it live today.
 *
 * So: observed anything dynamic ⇒ PASS; discovered-but-all-spawn-failed ⇒ the
 * existing FAIL; observed NOTHING ⇒ this note, carried on an `ok: true` outcome.
 *
 * WHY NON-BLOCKING (decided, not deferred — the evidence cuts both ways and this is
 * the resolution):
 *  - Blocking's case: both real occurrences also carried open verify-FAIL debt, so
 *    the runs with no dynamic evidence were exactly the runs already known to be
 *    carrying defects.
 *  - Against, and decisive: (1) that debt is ALREADY surfaced unconditionally at the
 *    gate moment, on PASS as on FAIL — the one real project records literally read "PASS — no
 *    integration command found … UNRESOLVED VERIFY-FAIL DEBT still open (2)". The
 *    missing signal was never the debt, it was the word PASS endorsing the run, and
 *    that is what this fixes. (2) `ok: false` routes into the autofix picker, whose
 *    seed is `reason`; "no integration command is discoverable" is not fixable by
 *    editing code, so the highest-probability child response is to FABRICATE a
 *    runnable command to satisfy the gate — the same fabrication class that refuted
 *    the `## verified tooling` harvest (see discoverIntegrationCommands) and that had
 *    a fix child `rm` a sibling's deliverable. (3) That harvest being refuted
 *    means one real project and godot-engine can NEVER discover a command, so blocking would end
 *    every non-npm run in `failed` permanently, with no remedy — the task's own I3
 *    is unsatisfiable, and
 *    its stated consequence is to downgrade to a warning and say so. This is that.
 * The teeth are elsewhere and are real: the verdict word changes, the gate trail says
 * UNOBSERVED, and the caller records a durable final-gate debt that the NEXT run's
 * gate re-surfaces (it can never auto-close — it is not static-class).
 */
export function unobservedVerdict(args: {
    /** Dynamic commands the gate discovered and tried to run (0 ⇒ nothing existed). */
    discovered: number
    /** Of those, how many actually RAN (a real pass or a real fail). */
    observed: number
}): string | null {
    if (args.observed > 0) return null
    // Kept short ON PURPOSE: the run-level trail line slices the reason at 300 chars,
    // and the whole point of this verdict is that the durable record carries it.
    const why =
        args.discovered === 0 ?
            'no integration, lockfile or boot command was discoverable here, so the gate ran '
            + 'nothing at all'
        :   `all ${args.discovered} discovered command(s) skipped as environment gaps, so the `
            + 'gate ran nothing observable'
    return (
        `UNOBSERVED — NOT a pass: ${why}; statics passed, but this run produced NO evidence `
        + 'that the assembled product builds, boots or works.'
    )
}

/** What `verdict()` attaches to every outcome, PASS or FAIL: the run's open
 *  ACCEPT debts, derived once before any section runs (deriveOpenDebts). */
export interface GateDebts {
    openDebts: AcceptDebt[]
    /** Human-facing note listing the open debts; absent/undefined when none. */
    debtNote?: string
}

interface TalliedFailure {
    rank: number
    text: string
    observed?: boolean
}

export class GateTally {
    // Aggregated failures across ALL sections (see runFinalIntegrationGate's
    // doc). rank 0 = boot/render ("does not serve/render" is the most load-bearing
    // signal); rank 1 = everything else, kept in execution order by stable sort.
    private readonly failures: TalliedFailure[] = []
    /** Labels of the dynamic commands that ran AND passed — the PASS reason names them. */
    private readonly passed: string[] = []
    // Full-skip blindness counters: every dynamic spawn counts an
    // attempt; a real pass OR a real fail counts an observation; skips observe
    // nothing. If everything discovered ends up skipped, observabilityGapFailure
    // turns the silence into a rank-0 failure instead of a static-only PASS.
    private attempts = 0
    private observations = 0
    private spawnFailures = 0
    private readonly bins = new Set<string>()
    private readonly warnings: string[] = []
    /** UNOBSERVED notes for launch scripts reclassified as CONFIG GAPS.
     *  They ride in `unobserved`, not `warnings`, so the caller's existing
     *  `recordDebt(cwd, id, fin.unobserved, 'final-gate')` writes the debt —
     *  never a PASS. */
    private readonly configGapNotes: string[] = []
    /** The inert-launch-contract note (16A): "declared scripts, but no manifest to
     *  diff against" — a note, never a failure, never a silent pass. */
    private readonly contractNotes: string[] = []
    /** The boot section's own UNOBSERVED verdict (bootSkipVerdict / rejected launch
     *  script). Lives outside the dynamic counters ON PURPOSE: the
     *  test/build commands that did run cannot cancel it. */
    private bootNote: string | null = null

    /** A failure at `rank` (default 1). Rank 0 is boot/render, the most load-bearing. */
    fail(text: string, rank = 1): void {
        this.failures.push({rank, text})
    }

    /**
     * A failure a PROBE returned after observing (see
     * FinalGateOutcome.observedFailures). Used by exactly one caller: the boot
     * section, whose `fail` outcome can only arise from a probe that looked. Every
     * other `fail()` keeps its class, so nothing else changes.
     */
    failObserved(text: string, rank = 1): void {
        this.failures.push({rank, text, observed: true})
    }

    /** A dynamic command that ran and passed; the PASS reason lists these. */
    ran(label: string): void {
        this.passed.push(label)
    }

    /** A dynamic spawn was attempted through runner `bin` (counted whether or not
     *  it then skips). */
    attempted(bin: string): void {
        this.attempts += 1
        this.bins.add(bin)
    }

    /** The attempt was OBSERVED — a real pass or a real fail; only skips observe nothing. */
    observed(): void {
        this.observations += 1
    }

    /**
     * Un-count one observation. The config-gap branch: a launch
     * script failed, the four static conditions plus the placeholder re-run said
     * the failure was a missing env variable the shipped template declares, and
     * so NOTHING about that script was observed — the real run could not reach
     * it and the probe run is a diagnostic, never an observation. It un-counts,
     * exactly like a skip would have.
     */
    unobserve(): void {
        this.observations -= 1
    }

    /** The attempt through `bin` never even spawned (ENOENT-class), as opposed to a
     *  tool-level env gap inside the chain. */
    spawnFailure(bin: string): void {
        this.spawnFailures += 1
        this.bins.add(bin)
    }

    /** A WARNING appended to a PASS reason (excuse-note-covered skip, render note). */
    warn(line: string): void {
        this.warnings.push(line)
    }

    configGap(note: string): void {
        this.configGapNotes.push(note)
    }

    contractNote(note: string): void {
        this.contractNotes.push(note)
    }

    /** The boot section's UNOBSERVED verdict, or null when the boot was observed. */
    bootUnobserved(note: string | null): void {
        this.bootNote = note
    }

    /** True while nothing dynamic has been attempted and nothing has failed —
     *  the state the zero-discovery return checks (see runFinalIntegrationGate). */
    silent(): boolean {
        return this.attempts === 0 && this.failures.length === 0
    }

    /** The blindness guard over this tally's own counters (see
     *  observabilityGapFailure); the caller fails it at rank 0. */
    blindness(runnerResolvable: (bin: string) => boolean): string | null {
        return observabilityGapFailure({
            attempted: this.attempts,
            observed: this.observations,
            spawnFailures: this.spawnFailures,
            runnerBins: [...this.bins],
            runnerResolvable
        })
    }

    /**
     * The verdict. Pure over the tally's state; the same debts ride on every shape.
     *
     * FAIL when anything failed: stable-sorted so boot/render (rank 0) leads and
     * everything else keeps execution order. One failure keeps the exact
     * single-failure wording; several become a numbered list so the trail, the
     * ACCEPT picker, and the autofix seed all carry the complete ranked picture.
     * The observed subset rides along by exact text identity (19A) — the demote
     * decision downstream reads THIS, instead of re-deriving observability from
     * the failure string.
     *
     * Otherwise `ok: true`, with the UNOBSERVED note when the gate could not
     * observe something it meant to. Two independent notes, either or both of which
     * may apply: the boot never ran, and/or NOTHING dynamic ran at all
     * (unobservedVerdict — commands WERE discovered, none spawn-failed so the
     * blindness guard correctly stayed silent, and yet nothing ran. Reported as
     * `statics passed (integration commands not runnable here)` that is the
     * identical "we never checked" silence wearing different words). The boot note leads because it
     * names a concrete command and the trail line is sliced at 300 chars; then the
     * config-gap notes, then the inert-contract note. Unchanged when anything at all
     * was observed, so a project with runnable commands is byte-for-byte unaffected.
     *
     * ZERO ATTEMPTS IS UNOBSERVED, NEVER A PASS: when nothing dynamic was even
     * attempted, the note IS the reason — there is no `statics passed (…)` suffix,
     * because "we never checked" must not read like "we checked and it was fine".
     * one real project shipped that verdict TWICE while carrying open verify-FAIL debt.
     *
     * The debt note rides in its OWN field: `reason` stays the mechanical failure
     * because it seeds the autofix child's prompt (see FinalGateOutcome.reason —
     * a fix child executed a recorded claim as an instruction).
     */
    verdict(debts: GateDebts): FinalGateOutcome {
        const withDebts = (o: FinalGateOutcome): FinalGateOutcome => ({
            ...o,
            ...(debts.debtNote ? {debtNote: debts.debtNote} : {}),
            openDebts: debts.openDebts
        })
        if (this.failures.length > 0) {
            const ranked = [...this.failures].sort((a, b) => a.rank - b.rank)
            const texts = ranked.map(f => f.text)
            const observed = ranked.filter(f => f.observed === true).map(f => f.text)
            return withDebts({
                ok: false,
                reason:
                    texts.length === 1 ?
                        texts[0]
                    :   `${texts.length} failures (ranked, most load-bearing first):\n${texts
                            .map((t, i) => `${i + 1}. ${t}`)
                            .join('\n')}`,
                failures: texts,
                ...(observed.length > 0 ? {observedFailures: observed} : {})
            })
        }
        const unobserved = [
            this.bootNote,
            unobservedVerdict({discovered: this.attempts, observed: this.observations}),
            ...this.configGapNotes,
            ...this.contractNotes
        ]
            .filter(n => n !== null)
            .join(' ')
        if (this.attempts === 0) {
            return withDebts({ok: true, unobserved, reason: unobserved})
        }
        const warningNote =
            this.warnings.length > 0 ? ` — WARNING: ${this.warnings.join('; WARNING: ')}` : ''
        return withDebts({
            ok: true,
            ...(unobserved ? {unobserved} : {}),
            reason:
                (unobserved ? `${unobserved} — ` : '')
                + (this.passed.length > 0 ?
                    `statics + ${this.passed.map(c => `\`${c}\``).join(', ')} passed`
                :   'statics passed (integration commands not runnable here)')
                + warningNote
        })
    }
}
