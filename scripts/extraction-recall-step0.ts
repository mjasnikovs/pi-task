/**
 * extraction-recall STEP 0 — measure WHERE a design clause dies on its way into the
 * plan, before building any lever (mx5 run 16).
 *
 * THE SHIPPED FAILURE. DESIGN §9 declares the server "serves `/api` + static
 * `dist/`". That clause reached NEITHER requirements.md nor contracts.md nor any
 * task spec; TASK_0008's refine narrowed the serve surface to "SPA fallback serves
 * dist/index.html", the implementation obeyed the narrowed spec exactly, and the
 * shipped app served index.html for /bundle.js — MIME-rejected module script,
 * permanently blank page. Every verify passed because every verify is anchored to
 * the DERIVED spec: a clause lost at derivation is structurally invisible downstream.
 *
 * TWO MEASUREMENTS, one deterministic and one live:
 *
 *   OFFLINE (default; no GPU): segment the design into clause units and check each
 *   against every RETAINED extraction channel of the recorded run — requirements.md
 *   (carried entries), contracts.md, launch-contract.md, and the composed TASK_*.md
 *   specs. Reports per-section representation and the unrepresented residue, plus
 *   the deterministic recall floor's blind spot (enumerateObligationPassages only
 *   fires on \b(required|must)\b paragraphs — count how much of the design it can
 *   even see). CAVEAT the offline half honestly: the run's 40 KEPT quotes are not
 *   persisted anywhere, so "unrepresented in retained channels" is a lower bound on
 *   extraction loss — a quote may have been extracted and then lost later. The live
 *   half exists precisely to break that ambiguity.
 *
 *   LIVE (REPS=N, PI_BIN set, llama-server up): replay the REAL extraction flow —
 *   REQUIREMENT_EXTRACT_PROMPT + host grounding + obligation-passage retry + cap,
 *   exactly the auto-orchestrator sequence — against the run-16 design, N reps.
 *   Mechanical per-rep record: emitted / grounded / post-retry / capped counts, and
 *   for each PROBE clause whether any quote covering it survives at each stage
 *   (emitted → grounded → capped). That splits the loss into "model never emits it"
 *   vs "cap drops it" vs "grounding drops it" — three different levers.
 *
 * Usage:
 *   bun run scripts/extraction-recall-step0.ts                     # offline
 *   PI_BIN=$(command -v pi) REPS=8 bun run scripts/extraction-recall-step0.ts  # + live
 * Env: MX5_DIR overrides the fixture tree (default ~/hub/mx5).
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {normalise} from '../src/task/contracts.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    capRequirements,
    enumerateObligationPassages,
    extractionRetryHint,
    keepGroundedRequirements,
    parseRequirementLines,
    uncoveredPassages,
    type RequirementEntry
} from '../src/task/requirements.js'
import {prependHint, runChild} from '../src/task/child-runner.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')
const OUT_DIR = path.join(os.homedir(), 'tmp', 'extraction-recall-step0')
const REPS = Number(process.env.REPS ?? '0')

/** PROBE CLAUSES — fixed BEFORE the live run (pre-registration; see the run log in
 *  this commit). #0 is the clause that shipped run 16's fatal defect. The others
 *  are the load-bearing members of the offline residue, hand-labeled. */
const PROBES: Array<{id: string; text: string}> = [
    {id: 'serve-static', text: 'serves `/api` + static `dist/`'},
    {id: 'compose-dev', text: 'docker-compose Postgres + concurrent watch (tailwind, bun build, server)'},
    {id: 'client-css', text: 'bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css'},
    {id: 'spa-fallback', text: 'non-`/api` GETs serve the built `index.html`'}
]

interface Clause {
    section: string
    text: string
}

/** Clause units: list items and table rows, the shapes designs state obligations
 *  in. Paragraph prose is deliberately NOT segmented — matching prose is the
 *  STAGE-3 noise trap; the run-16 loss and every probe is a bullet. */
export function segmentClauses(doc: string): Clause[] {
    const out: Clause[] = []
    let section = '(intro)'
    let inFence = false
    for (const raw of doc.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trimEnd()
        if (/^```/.test(line.trim())) {
            inFence = !inFence
            continue
        }
        if (inFence) continue
        const h = /^#{1,6}\s+(.+)$/.exec(line)
        if (h) {
            section = h[1].trim()
            continue
        }
        const li = /^\s*[-*]\s+(.+)$/.exec(line)
        if (li && li[1].trim().length >= 20) {
            out.push({section, text: li[1].trim()})
            continue
        }
        const row = /^\s*\|(.+)\|\s*$/.exec(line)
        if (row && !/^[\s|:-]+$/.test(row[1]) && row[1].trim().length >= 20) {
            out.push({section, text: row[1].trim()})
        }
    }
    return out
}

/** Symmetric normalised containment — a retained quote may be a fragment of the
 *  clause (extraction quotes sub-spans) or a superset (a whole-bullet quote). */
function covers(quote: string, clause: string): boolean {
    const q = normalise(quote)
    const c = normalise(clause)
    if (q.length < 12 || c.length < 12) return q.length > 0 && (c.includes(q) || q.includes(c))
    return c.includes(q) || q.includes(c)
}

function retainedQuotes(): Array<{quote: string; channel: string}> {
    const dir = path.join(MX5, '.pi-tasks')
    const out: Array<{quote: string; channel: string}> = []
    for (const f of ['requirements.md', 'contracts.md', 'launch-contract.md']) {
        const p = path.join(dir, f)
        if (!fs.existsSync(p)) continue
        for (const m of fs.readFileSync(p, 'utf8').matchAll(/"([^"\n]{6,300})"/g)) {
            out.push({quote: m[1], channel: f})
        }
    }
    return out
}

function taskSpecText(): string {
    const dir = path.join(MX5, '.pi-tasks')
    return fs
        .readdirSync(dir)
        .filter(f => /^TASK_\d+\.md$/.test(f))
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
        .join('\n')
}

function offline(design: string): void {
    const clauses = segmentClauses(design)
    const quotes = retainedQuotes()
    const specs = normalise(taskSpecText())
    const passages = enumerateObligationPassages(design)
    const rows = clauses.map(cl => {
        const viaQuote = quotes.find(q => covers(q.quote, cl.text))
        const viaSpec = specs.includes(normalise(cl.text))
        const inFloor = passages.some(p => normalise(p).includes(normalise(cl.text)))
        return {...cl, viaQuote: viaQuote?.channel ?? null, viaSpec, inFloor}
    })
    const residue = rows.filter(r => !r.viaQuote && !r.viaSpec)
    console.log(`design clauses (bullets + table rows): ${rows.length}`)
    console.log(
        `represented: via retained quote ${rows.filter(r => r.viaQuote).length}, `
            + `verbatim in a task spec ${rows.filter(r => r.viaSpec).length}, `
            + `UNREPRESENTED ${residue.length}`
    )
    console.log(
        `deterministic recall floor: ${passages.length} obligation-marked passage(s); `
            + `${rows.filter(r => r.inFloor).length}/${rows.length} clauses inside the floor's sight`
    )
    console.log('\nUNREPRESENTED residue (lower bound on extraction loss — see header):')
    for (const r of residue) console.log(`  [${r.section}] ${r.text.slice(0, 120)}`)
    for (const p of PROBES) {
        const covered = quotes.some(q => covers(q.quote, p.text)) || specs.includes(normalise(p.text))
        console.log(`PROBE ${p.id}: retained-channel coverage = ${covered}`)
    }
}

interface LiveRep {
    rep: number
    ms: number
    emitted: number
    grounded: number
    retried: boolean
    afterRetry: number
    kept: number
    capDropped: number
    probes: Record<string, {emitted: boolean; grounded: boolean; kept: boolean}>
}

async function live(design: string): Promise<void> {
    if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
        console.error('REFUSING TO RUN LIVE: PI_BIN is unset (fork-bomb guard).')
        process.exit(1)
    }
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable.')
        process.exit(1)
    }
    await fsp.mkdir(OUT_DIR, {recursive: true})
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'extract-recall-'))
    const passages = enumerateObligationPassages(design)
    const probeState = (entries: Array<{quote: string}>): ((p: {text: string}) => boolean) => {
        return p => entries.some(e => covers(e.quote, p.text))
    }
    const rows: LiveRep[] = []
    for (let rep = 1; rep <= REPS; rep++) {
        const started = Date.now()
        const once = async (hint: string | null): Promise<{raw: RequirementEntry[]; grounded: RequirementEntry[]}> => {
            const r = await runChild(
                cwd,
                '',
                prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(design, passages)),
                new AbortController().signal
            )
            if (r.exitCode !== 0) throw new Error(`child exit ${r.exitCode}: ${r.stderr.slice(-300)}`)
            const raw = parseRequirementLines(r.text)
            return {raw, grounded: keepGroundedRequirements(raw, design)}
        }
        const first = await once(null)
        let entries = first.grounded
        const uncovered = uncoveredPassages(passages, entries)
        const retried = uncovered.length > 0
        let rawAll = first.raw
        if (retried) {
            const retry = await once(extractionRetryHint(uncovered))
            rawAll = [...rawAll, ...retry.raw]
            entries = keepGroundedRequirements([...entries, ...retry.raw], design)
        }
        const kept = capRequirements(entries, passages, design)
        const inRaw = probeState(rawAll)
        const inGrounded = probeState(entries)
        const inKept = probeState(kept)
        const row: LiveRep = {
            rep,
            ms: Date.now() - started,
            emitted: first.raw.length,
            grounded: first.grounded.length,
            retried,
            afterRetry: entries.length,
            kept: kept.length,
            capDropped: entries.length - kept.length,
            probes: Object.fromEntries(
                PROBES.map(p => [
                    p.id,
                    {emitted: inRaw(p), grounded: inGrounded(p), kept: inKept(p)}
                ])
            )
        }
        rows.push(row)
        await fsp.appendFile(path.join(OUT_DIR, 'reps.jsonl'), JSON.stringify(row) + '\n')
        // Full quote lists per stage, retained so any candidate cap rule can be
        // re-scored OFFLINE against these reps without new model time (the
        // typeonly-baserate lesson: a counter whose raw answers were discarded
        // cannot be re-scored when the question changes).
        await fsp.appendFile(
            path.join(OUT_DIR, 'quotes.jsonl'),
            JSON.stringify({rep, grounded: entries, kept}) + '\n'
        )
        console.log(
            `rep ${rep}: emitted ${row.emitted} grounded ${row.grounded} retried=${row.retried} `
                + `kept ${row.kept} (capDropped ${row.capDropped}) `
                + PROBES.map(p => `${p.id}=${row.probes[p.id].kept ? 'KEPT' : row.probes[p.id].grounded ? 'cap/LOST' : row.probes[p.id].emitted ? 'ground/LOST' : 'NEVER-EMITTED'}`).join(' ')
                + ` ${(row.ms / 1000).toFixed(0)}s`
        )
    }
    const keptRate = (id: string) => rows.filter(r => r.probes[id].kept).length
    const emitRate = (id: string) => rows.filter(r => r.probes[id].emitted).length
    console.log(`\nLIVE SUMMARY over ${rows.length} reps (raw: ${OUT_DIR}/reps.jsonl):`)
    for (const p of PROBES) {
        console.log(
            `  ${p.id}: emitted ${emitRate(p.id)}/${rows.length}, kept ${keptRate(p.id)}/${rows.length}`
        )
    }
}

const design = fs.readFileSync(path.join(MX5, 'DESIGN', 'PROJECT.md'), 'utf8')
offline(design)
if (REPS > 0) await live(design)
