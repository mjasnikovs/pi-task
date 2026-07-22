/**
 * STAGE 1 SCORING — pure functions over what a worker:apis rep left behind, so the live
 * harness spends model time and this file spends none. Everything here is deterministic and
 * unit-tested (apis-trajectory.test.ts); nothing here spawns, fetches, or asks a model.
 *
 * THE QUESTION THIS SERVES. worker:apis terminates without ever calling search or fetch in
 * 11 of 12 live reps, and the CLASS of its last docs answer does not discriminate (every
 * Bonferroni-adjusted p = 1.000 but one). So the stopping point is not visible in the last
 * answer. What is not yet measured is the SHAPE of the whole trajectory and the RELATIONSHIP
 * between that trajectory and the section the worker emitted. This module computes both.
 *
 * TWO CHANNELS, BOTH ALREADY SHIPPED — nothing new is logged:
 *   trial log     phaseResearch's own onChildOutput writes `worker:apis: <tool>: <arg>` for
 *                 every tool call, in order. That gives the ORDERED trajectory across all
 *                 tools, with the docs query clipped to ~60 chars.
 *   answer sink   src/workers/typeonly-log.ts writes one JSON line per docs answer with the
 *                 verbatim query, the prose answer, and (as of this stage) the tool's full
 *                 return text. That gives the CONTENT, unclipped.
 * They are merged by position: the n-th `pi-worker-docs` line of the log is the n-th sink row.
 *
 * WHY GROUNDING IS A SUBSTRING TEST AND NOT A JUDGEMENT. "Was this APIS entry backed by a
 * lookup?" has to be answered mechanically or it is not evidence. The test is: does the
 * entry's symbol appear anywhere in the text the worker was GIVEN (its assembled prompt —
 * which carries the orientation file dump, the project inventory, the FILES map and the
 * refined task) or RETRIEVED (docs answers, files it read)? If it appears nowhere in any of
 * those, the worker produced it from memory. Every ambiguity is resolved toward GROUNDED:
 * the corpus is the union of every channel, the match is a plain case-sensitive substring,
 * and no stop-list is applied, so an English word in an entry name is always "grounded" and
 * can only dilute the ungrounded rate downward. A finding that survives that bias is real.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

// ─── the trajectory ──────────────────────────────────────────────────────────

/** One tool call as the trial log recorded it, in completion order. */
export interface Step {
    /** `pi-worker-docs`, `read`, `grep`, `pi-worker-fetch`, … */
    tool: string
    /** Everything after the tool name: a module + clipped query, a path, a URL. */
    arg: string
}

/**
 * Ordered tool calls for one worker label.
 *
 * Every call appears TWICE in the log — once via logDebug (prefixed `[debug] `) and once via
 * onChildOutput — so the debug copies are dropped. An earlier probe counted both and reported
 * every call count doubled.
 */
export function parseTrajectory(log: string, label = 'worker:apis'): Step[] {
    const out: Step[] = []
    for (const line of log.split('\n')) {
        if (line.startsWith('[debug] ')) continue
        if (!line.startsWith(`${label}: `)) continue
        const rest = line.slice(label.length + 2)
        const colon = rest.indexOf(': ')
        // `worker:apis: writing answer…` has no argument — it is a turn marker, not a tool.
        if (colon < 0) {
            out.push({tool: rest.trim(), arg: ''})
            continue
        }
        out.push({tool: rest.slice(0, colon).trim(), arg: rest.slice(colon + 2).trim()})
    }
    return out
}

/** The module a `pi-worker-docs` step asked about: `.` for project source, else the package. */
export function stepModule(step: Step): string | null {
    if (step.tool !== 'pi-worker-docs') return null
    const m = /^(\S+)\s/.exec(step.arg)
    return m ? m[1] : step.arg.trim()
}

// ─── the emitted APIS section ────────────────────────────────────────────────

/** One line of the APIS section: `<name>  <one-line signature or use>`. */
export interface ApisEntry {
    /** The head field — a symbol or a command, per the prompt's output contract. */
    name: string
    /** The remainder of the line. */
    rest: string
    /** Identifier-shaped tokens in `name`. The grounding unit. */
    symbols: string[]
}

/** `FILES\n…\n\nAPIS\n…\n\nCONTEXT\n…` → the body of one section. */
export function extractSection(research: string, section: string): string {
    const re = new RegExp(`(?:^|\\n)${section}\\n([\\s\\S]*?)(?=\\n[A-Z][A-Z]+\\n|$)`)
    const m = re.exec(research)
    return m ? m[1].trim() : ''
}

const NAME_SPLIT = /\s{2,}|\s+[-–—]\s+|:\s+/

/**
 * Split an APIS section into entries.
 *
 * The prompt asks for `<name>  <one-line signature or use>` with no bullets, but a weak model
 * emits `- name — desc` and `* name: desc` too, so the head is taken up to the first
 * double-space, dash-separator or colon-separator, whichever comes first. A line with no
 * separator at all is treated as all-name, which is the conservative reading: it maximises the
 * symbols subjected to the grounding test rather than silently dropping them.
 */
export function parseApisEntries(section: string): ApisEntry[] {
    const out: ApisEntry[] = []
    for (const raw of section.split('\n')) {
        const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
        if (line.length === 0) continue
        const m = NAME_SPLIT.exec(line)
        const name = (m ? line.slice(0, m.index) : line).trim()
        const rest = m ? line.slice(m.index + m[0].length).trim() : ''
        if (name.length === 0) continue
        out.push({name, rest, symbols: extractSymbols(name)})
    }
    return out
}

/**
 * Identifier-shaped tokens of length >= 3. No stop-list, deliberately: a prose word in an
 * entry name matches the prompt text and therefore always scores GROUNDED, so leaving prose in
 * can only push the ungrounded rate down. Filtering it out would push the rate up, which is
 * the direction that manufactures a finding.
 */
export function extractSymbols(name: string): string[] {
    return [...new Set(name.match(/[$]?[A-Za-z_][A-Za-z0-9_$]{2,}/g) ?? [])]
}

// ─── grounding ───────────────────────────────────────────────────────────────

/** Where a symbol was found. `none` is the finding; the rest are all "the worker had it". */
export type Channel = 'prompt' | 'docs-project' | 'docs-package' | 'read' | 'none'

/** The four texts a rep's worker could have taken a symbol from, kept apart so `none` is decidable. */
export interface GroundingCorpus {
    /** The assembled worker:apis prompt: orientation dump, inventory, FILES map, refined task. */
    prompt: string
    /** Every `module: "."` docs answer, as the tool returned it. */
    docsProject: string
    /** Every package docs answer, as the tool returned it. */
    docsPackage: string
    /** Contents of every file the worker read or grepped, from the preserved trial tree. */
    reads: string
}

/**
 * Which channels carry `symbol`, most-retrieved-first. Empty ⇒ the symbol appears in nothing
 * the worker was given or fetched, so it came from the model.
 *
 * Case-sensitive on purpose: `hc` and `HC` are different symbols, and a case-insensitive match
 * would ground `sql` on the word "SQL" in prose.
 */
export function channelsFor(symbol: string, c: GroundingCorpus): Channel[] {
    const hits: Channel[] = []
    if (c.docsPackage.includes(symbol)) hits.push('docs-package')
    if (c.docsProject.includes(symbol)) hits.push('docs-project')
    if (c.reads.includes(symbol)) hits.push('read')
    if (c.prompt.includes(symbol)) hits.push('prompt')
    return hits
}

export interface EntryGrounding {
    entry: ApisEntry
    /** Symbols found in no channel at all. */
    ungrounded: string[]
    /** Union of channels over the entry's grounded symbols. */
    channels: Channel[]
}

export function groundEntries(entries: ApisEntry[], c: GroundingCorpus): EntryGrounding[] {
    return entries.map(entry => {
        const ungrounded: string[] = []
        const channels = new Set<Channel>()
        for (const s of entry.symbols) {
            const hits = channelsFor(s, c)
            if (hits.length === 0) ungrounded.push(s)
            else for (const h of hits) channels.add(h)
        }
        return {entry, ungrounded, channels: [...channels]}
    })
}

/**
 * Read every file the worker touched, from the preserved trial tree, and concatenate.
 *
 * The research phase is read-only, so the tree at scoring time is byte-identical to the tree
 * the worker saw. Paths appear absolute in some log lines and repo-relative in others; both
 * are resolved against the trial dir. Anything unreadable is skipped — a directory `ls` or a
 * path outside the tree contributes nothing rather than throwing.
 */
export function readTouchedFiles(trialDir: string, steps: Step[], capBytes = 4_000_000): string {
    const seen = new Set<string>()
    const parts: string[] = []
    let total = 0
    for (const s of steps) {
        if (s.tool !== 'read' && s.tool !== 'grep') continue
        const p = path.isAbsolute(s.arg) ? s.arg : path.join(trialDir, s.arg)
        if (seen.has(p)) continue
        seen.add(p)
        if (!p.startsWith(trialDir)) continue
        try {
            if (!fs.statSync(p).isFile()) continue
            const text = fs.readFileSync(p, 'utf8')
            if (total + text.length > capBytes) continue
            total += text.length
            parts.push(text)
        } catch {
            // A grep target that is a directory, or a path the worker invented. Not an error.
        }
    }
    return parts.join('\n')
}

// ─── trajectory shape ────────────────────────────────────────────────────────

/** Content words of a docs query, for the repeat test. */
export function queryTokens(q: string): Set<string> {
    return new Set(
        q
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(t => t.length > 2)
    )
}

export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 1
    let inter = 0
    for (const t of a) if (b.has(t)) inter++
    return inter / (a.size + b.size - inter)
}

/**
 * Is docs call `i` a near-repeat of an earlier call in the same rep? Same module and query
 * token overlap >= `threshold`. 0.6 is strict enough that "auth.ts route definitions" and
 * "auth.ts exact route definitions with zValidator" count as repeats — which they are, in the
 * sense that matters: the second one is a re-ask, not a new subject.
 */
export function repeatFlags(
    calls: Array<{module: string; query: string}>,
    threshold = 0.6
): boolean[] {
    const toks = calls.map(c => queryTokens(c.query))
    return calls.map((c, i) => {
        for (let j = 0; j < i; j++) {
            if (calls[j].module !== c.module) continue
            if (jaccard(toks[i], toks[j]) >= threshold) return true
        }
        return false
    })
}

/**
 * Symbols an answer introduced that no earlier answer in the same rep carried. The novelty
 * curve over a trajectory decides between "stopped once nothing new was coming back" and
 * "stopped while still learning things" — the difference between saturation and a budget.
 */
export function noveltyCurve(answerTexts: string[]): number[] {
    const seen = new Set<string>()
    return answerTexts.map(t => {
        let fresh = 0
        for (const s of new Set(t.match(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g) ?? [])) {
            if (!seen.has(s)) {
                seen.add(s)
                fresh++
            }
        }
        return fresh
    })
}

// ─── what KIND of question is being asked ────────────────────────────────────

/**
 * The APIS prompt's output contract is literally `<name>  <one-line signature or use>`. So
 * "what does this parameter MEAN" is not a field of the thing the worker is producing, while
 * "what is this symbol's signature" is. If the worker's questions are overwhelmingly the
 * second kind, its research is an enumeration of the output format rather than an inquiry, and
 * the variable that governs when it stops is the FORMAT, not any property of the answers.
 *
 * Both predicates are keyword sets over the query text, fixed BEFORE the full run was scored
 * (they were written against the two-rep smoke run and are not re-tuned afterwards — a
 * predicate chosen after seeing the data it is applied to measures the choosing, not the
 * data). They are not exclusive: a query can ask for both, and that case is reported.
 */
export const SIGNATURE_CUES =
    /signature|\btypes?\b|typing|declaration|interface|props\b|exports?\b|parameters?\b|params\b|return type|api surface|definition/i

export const BEHAVIOUR_CUES =
    /how does|how do|what happens|behaviou?r|semantics|\bmeans?\b|meaning|defaults? to|resolve[ds]?\b|relative to|under the hood|\bwhy\b|side effects?|guide|example/i

export type QueryKind = 'signature-only' | 'behaviour' | 'neither'

export function classifyQuery(query: string): QueryKind {
    if (BEHAVIOUR_CUES.test(query)) return 'behaviour'
    if (SIGNATURE_CUES.test(query)) return 'signature-only'
    return 'neither'
}

export const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

export const sd = (xs: number[]): number => {
    if (xs.length < 2) return 0
    const m = mean(xs)
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}
