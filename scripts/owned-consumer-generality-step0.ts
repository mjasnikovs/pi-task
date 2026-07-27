/**
 * owned-consumer-generality-step0 — TASK 5's STEP 0. Is "an owned requirement is
 * violated by CONSUMER tasks, not by its OWNER" a recurring shape, or one mx5
 * anecdote?
 *
 * THE mx5 ANECDOTE (run 17): requirements-owned.md gave all three Hono-RPC
 * obligations to TASK_0021, including "If a call isn't fully typed end-to-end via
 * `hc`, fix the route chaining/export, don't paper over it with a manual type or
 * `any`." TASK_0021 complied perfectly; 0027/0031/0033/0034 — which never saw the
 * clause — hand-wrote casts that invented an API surface, and 7 client call sites
 * shipped dead.
 *
 * WHAT THIS RIG MEASURES, per project, with NO model time when the project already
 * has a requirements-owned.md:
 *   M1  prohibition rate: share of OWNED requirements that are prohibition-shaped.
 *       Registered classifier = the codebase's own PROHIBITION_RE (requirements.ts,
 *       the rule that already decides a requirement is un-ownable). The narrow
 *       four-phrase variant TASK 5's text names (never / don't / must not / do not)
 *       is reported alongside, never used to pass.
 *   M2  consumer touch: for each owned requirement, the code symbols its quote
 *       names (backticked tokens, path-like tokens, camel/snake identifiers), then
 *       how many tasks OTHER than the owner mention one of those symbols in their
 *       composed spec. Owner-only ⇒ nothing to propagate to and the lever is dead.
 *
 * A project WITHOUT requirements-owned.md (every run before v0.20.0) needs the
 * mapping regenerated: --doc <designDoc> --live re-runs the real plan-time pipeline
 * (REQUIREMENT_EXTRACT_PROMPT → keepGroundedRequirements → capRequirements →
 * COVERAGE_MAP_PROMPT → parseCoverageMap → accountCoverage) against the project's
 * REAL shipped task list, so the owners land on tasks whose composed specs exist
 * and M2 stays measurable.
 *
 * Usage:
 *   bun run scripts/owned-consumer-generality-step0.ts ~/hub/mx5
 *   PI_BIN=$(command -v pi) bun run scripts/owned-consumer-generality-step0.ts \
 *       /tmp/iar1-clone --doc README.md --live
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    COVERAGE_MAP_PROMPT,
    REQUIREMENT_EXTRACT_PROMPT,
    accountCoverage,
    capRequirements,
    enumerateObligationPassages,
    extractionRetryHint,
    keepGroundedRequirements,
    parseCoverageMap,
    parseOwnedRequirements,
    parseRequirementLines,
    uncoveredPassages,
    type OwnedRequirement,
    type RequirementEntry
} from '../src/task/requirements.js'
import {runChild} from '../src/task/child-runner.js'

/** The codebase's own un-ownable-requirement rule, copied verbatim from
 *  requirements.ts (not exported there). This is the REGISTERED classifier. */
export const PROHIBITION_RE =
    /\b(?:must not|must never|shall not|should not|may not|cannot|can'?t|won'?t|do(?:es)? not|don'?t|doesn'?t|no|not|never|none|without|avoids?|prohibit(?:ed|s|ing)?|forbid(?:den|s)?|disallow(?:ed|s|ing)?|excludes?|excluded|neither|nor)\b/i

/** The four phrases TASK 5's text names. Reported for honesty, never used to pass. */
export const STRICT4_RE = /\b(?:never|don'?t|must not|do not)\b/i

export function isProhibition(quote: string): boolean {
    return PROHIBITION_RE.test(quote)
}

/** Tokens too generic to prove a consumer touches the OWNER's thing. */
const SYMBOL_STOPWORDS = new Set([
    'true',
    'false',
    'null',
    'this',
    'that',
    'with',
    'from',
    'they',
    'them',
    'have',
    'each',
    'when',
    'then',
    'else',
    'must',
    'only',
    'also',
    'more',
    'than',
    'into',
    'over',
    'user',
    'users',
    'data',
    'name',
    'names',
    'type',
    'types',
    'code',
    'file',
    'files',
    'test',
    'tests',
    'page',
    'pages',
    'text',
    'json',
    'http',
    'https'
])

/**
 * The code symbols a requirement quote names. Deliberately conservative — a
 * consumer "touches the owner's symbol" only on evidence a prose word cannot
 * manufacture:
 *   • tokens inside backticks (the design's own code spans),
 *   • path-like tokens (a `/` or a known source extension),
 *   • camelCase / snake_case / dotted identifiers anywhere in the quote.
 * Everything is lowercased for matching; <4 chars and stopwords are dropped.
 */
export function extractSymbols(quote: string): string[] {
    const out = new Set<string>()
    const add = (raw: string): void => {
        const t = raw.replace(/^[^A-Za-z0-9_$/.]+|[^A-Za-z0-9_$/.]+$/g, '')
        if (t.length < 4) return
        if (!/[A-Za-z]/.test(t)) return
        const low = t.toLowerCase()
        if (SYMBOL_STOPWORDS.has(low)) return
        out.add(low)
    }
    for (const m of quote.matchAll(/`([^`]+)`/g)) {
        for (const tok of m[1].split(/[\s,;()[\]{}<>"']+/)) add(tok)
    }
    for (const tok of quote.split(/[\s,;()[\]{}<>"'`]+/)) {
        const t = tok.replace(/^[^A-Za-z0-9_$/.]+|[^A-Za-z0-9_$/.]+$/g, '')
        if (t.length < 4) continue
        const pathLike = t.includes('/') || /\.[a-z]{2,4}$/i.test(t)
        const identLike = /_/.test(t) || /^[a-z]+[A-Z]/.test(t) || /\.[A-Za-z]/.test(t)
        if (pathLike || identLike) add(t)
    }
    return [...out]
}

export interface AutoTaskEntry {
    /** `TASK_0021` when the checklist line carries an id, '' for unstarted lines. */
    id: string
    title: string
}

/** The `## tasks` checklist of a TASK_AUTO_*.md file. */
export function parseAutoTaskList(md: string): AutoTaskEntry[] {
    const m = /^##\s+tasks\s*$/m.exec(md)
    if (!m) return []
    const rest = md.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    const body = next ? rest.slice(0, next.index) : rest
    const out: AutoTaskEntry[] = []
    for (const line of body.split('\n')) {
        const item = /^[ \t]*-[ \t]*\[[ xX]\][ \t]*(.+?)[ \t]*$/.exec(line)
        if (!item) continue
        const withId = /^(TASK_\d+)[ \t]+(.+)$/.exec(item[1])
        if (withId) out.push({id: withId[1], title: withId[2].trim()})
        else out.push({id: '', title: item[1].trim()})
    }
    return out
}

/** `## spec` of a composed task file (falls back to the whole file). */
export function specSection(md: string): string {
    const m = /^##\s+spec\s*$/m.exec(md)
    if (!m) return md
    const rest = md.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

export interface TaskSpec {
    id: string
    title: string
    spec: string
}

/** id → PLAN title, from every TASK_AUTO checklist. The per-task file's own
 *  frontmatter `title` is the REFINED prompt, not the plan title the owned
 *  mapping is keyed by, so owner matching must come from here. */
export function planTitlesById(projectDir: string): Map<string, string> {
    const dir = path.join(projectDir, '.pi-tasks')
    const out = new Map<string, string>()
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir).sort()) {
        if (!/^TASK_AUTO_\d+\.md$/.test(f)) continue
        for (const e of parseAutoTaskList(fs.readFileSync(path.join(dir, f), 'utf8'))) {
            if (e.id.length > 0 && !out.has(e.id)) out.set(e.id, e.title)
        }
    }
    return out
}

export function readTaskSpecs(projectDir: string): TaskSpec[] {
    const dir = path.join(projectDir, '.pi-tasks')
    if (!fs.existsSync(dir)) return []
    const planTitles = planTitlesById(projectDir)
    const out: TaskSpec[] = []
    for (const f of fs.readdirSync(dir).sort()) {
        if (!/^TASK_\d+\.md$/.test(f)) continue
        const md = fs.readFileSync(path.join(dir, f), 'utf8')
        const id = f.replace(/\.md$/, '')
        const title = planTitles.get(id) ?? /^title:[ \t]*(.+)$/m.exec(md)?.[1]?.trim() ?? ''
        out.push({id, title, spec: specSection(md)})
    }
    return out
}

const normaliseTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim()

/** The task whose title matches an owned entry's title (prefix-tolerant: task
 *  titles are truncated/suffixed with spec refs in places). */
export function ownerOf(owned: OwnedRequirement, tasks: TaskSpec[]): TaskSpec | null {
    const want = normaliseTitle(owned.title)
    const head = want.split('|')[0].trim()
    let best: TaskSpec | null = null
    for (const t of tasks) {
        const have = normaliseTitle(t.title)
        if (have.length === 0) continue
        const haveHead = have.split('|')[0].trim()
        if (have === want || haveHead === head) return t
        if (best === null && (head.startsWith(haveHead) || haveHead.startsWith(head))) best = t
    }
    return best
}

export interface TouchRow {
    quote: string
    prohibition: boolean
    strict4: boolean
    ownerId: string
    symbols: string[]
    consumers: string[]
}

export function measureTouch(owned: OwnedRequirement[], tasks: TaskSpec[]): TouchRow[] {
    return owned.map(o => {
        const owner = ownerOf(o, tasks)
        const symbols = extractSymbols(o.quote)
        const consumers = tasks
            .filter(t => t.id !== owner?.id)
            .filter(t => {
                const hay = t.spec.toLowerCase()
                return symbols.some(s => hay.includes(s))
            })
            .map(t => t.id)
        return {
            quote: o.quote,
            prohibition: isProhibition(o.quote),
            strict4: STRICT4_RE.test(o.quote),
            ownerId: owner?.id ?? '(unmatched)',
            symbols,
            consumers
        }
    })
}

// ─── Live regeneration (only for projects with no requirements-owned.md) ─────

const TRIAL_TIMEOUT_MS = 20 * 60_000

async function child(cwd: string, prompt: string): Promise<string> {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    try {
        const r = await runChild(cwd, '', prompt, abort.signal)
        return r.text
    } finally {
        clearTimeout(timer)
    }
}

async function regenerateOwned(
    projectDir: string,
    doc: string,
    titles: string[]
): Promise<OwnedRequirement[]> {
    const passages = enumerateObligationPassages(doc)
    let raw = await child(projectDir, REQUIREMENT_EXTRACT_PROMPT(doc, passages))
    let kept = keepGroundedRequirements(parseRequirementLines(raw), doc)
    const missed = uncoveredPassages(passages, kept)
    if (missed.length > 0) {
        // The planner's own forced re-extraction (deterministic recall floor).
        raw = await child(
            projectDir,
            REQUIREMENT_EXTRACT_PROMPT(doc, passages) + '\n\n' + extractionRetryHint(missed)
        )
        const retry = keepGroundedRequirements(parseRequirementLines(raw), doc)
        if (retry.length > kept.length) kept = retry
    }
    const requirements: RequirementEntry[] = capRequirements(kept, passages, doc)
    const prohGrounded = requirements.filter(r => isProhibition(r.quote)).length
    console.log(
        `  extraction: ${requirements.length} grounded requirement(s),`
            + ` ${prohGrounded} prohibition-shaped (${pct(prohGrounded, requirements.length)})`
    )
    const mapRaw = await child(projectDir, COVERAGE_MAP_PROMPT(requirements, titles))
    const acc = accountCoverage(
        requirements,
        parseCoverageMap(mapRaw, requirements.length, titles.length)
    )
    console.log(
        `  coverage-map: ${acc.mapped.length} task-mapped, ${acc.crossCutting.length}`
            + ` cross-cutting, ${acc.unmapped.length} unmapped`
    )
    // The LEAK this task is about: a prohibition the map assigns to ONE task is
    // owner-only, while a prohibition it leaves NONE already rides the working
    // cross-cutting channel (accountCoverage's isCrossCuttingRequirement branch).
    console.log(
        `  prohibition-shaped split: ${acc.mapped.filter(m => isProhibition(m.req.quote)).length}`
            + ` owned / ${acc.crossCutting.filter(r => isProhibition(r.quote)).length} cross-cutting`
            + ` / ${acc.unmapped.filter(r => isProhibition(r.quote)).length} unmapped`
    )
    return acc.mapped.map(m => ({
        quote: m.req.quote,
        anchor: m.req.anchor,
        title: titles[m.task - 1]
    }))
}

function pct(n: number, d: number): string {
    return d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`
}

function report(project: string, rows: TouchRow[], taskCount: number): void {
    const proh = rows.filter(r => r.prohibition)
    const s4 = rows.filter(r => r.strict4)
    const withConsumers = rows.filter(r => r.consumers.length > 0)
    const prohWithConsumers = proh.filter(r => r.consumers.length > 0)
    const meanConsumers =
        rows.length === 0 ? 0 : rows.reduce((a, r) => a + r.consumers.length, 0) / rows.length
    console.log(`\n═══ ${project} — ${rows.length} owned requirement(s), ${taskCount} task(s)`)
    console.log(
        `M1 prohibition-shaped (PROHIBITION_RE): ${proh.length}/${rows.length}`
            + ` = ${pct(proh.length, rows.length)}`
    )
    console.log(
        `   strict-4 (never/don't/must not/do not): ${s4.length}/${rows.length}`
            + ` = ${pct(s4.length, rows.length)}`
    )
    console.log(
        `M2 owned reqs with >=1 non-owner task touching a named symbol:`
            + ` ${withConsumers.length}/${rows.length} = ${pct(withConsumers.length, rows.length)}`
    )
    console.log(`   mean consumer tasks per owned requirement: ${meanConsumers.toFixed(1)}`)
    console.log(
        `   prohibition-shaped AND has consumers: ${prohWithConsumers.length}/${proh.length}`
            + ` = ${pct(prohWithConsumers.length, proh.length)}`
    )
    for (const r of rows) {
        console.log(
            `  ${r.prohibition ? 'PROH' : '    '} owner=${r.ownerId}`
                + ` consumers=${r.consumers.length}${r.consumers.length > 0 ? ` [${r.consumers.slice(0, 6).join(',')}]` : ''}`
                + ` sym=[${r.symbols.slice(0, 5).join(' ')}] "${r.quote.slice(0, 70)}"`
        )
    }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2)
    const projectDir = args[0]
    if (!projectDir) {
        console.error('usage: owned-consumer-generality-step0.ts <projectDir> [--doc p] [--live]')
        process.exit(1)
    }
    const docArg = args.includes('--doc') ? args[args.indexOf('--doc') + 1] : ''
    const live = args.includes('--live')
    const tasks = readTaskSpecs(projectDir)
    const ownedFile = path.join(projectDir, '.pi-tasks', 'requirements-owned.md')

    let owned: OwnedRequirement[]
    if (fs.existsSync(ownedFile)) {
        owned = parseOwnedRequirements(fs.readFileSync(ownedFile, 'utf8'))
        console.log(`${projectDir}: using recorded requirements-owned.md (${owned.length} entries)`)
    } else {
        if (!live || !docArg) {
            console.error(
                `${projectDir}: no requirements-owned.md — pass --doc <designDoc> --live to`
                    + ' regenerate the mapping over this project\'s real task list.'
            )
            process.exit(1)
        }
        if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
            console.error('REFUSING TO RUN: PI_BIN is unset (fork-bomb guard).')
            process.exit(1)
        }
        const doc = fs.readFileSync(path.resolve(projectDir, docArg), 'utf8')
        const titles = fs
            .readdirSync(path.join(projectDir, '.pi-tasks'))
            .filter(f => /^TASK_AUTO_\d+\.md$/.test(f))
            .sort()
            .flatMap(f =>
                parseAutoTaskList(fs.readFileSync(path.join(projectDir, '.pi-tasks', f), 'utf8'))
            )
            .filter(e => e.id.length > 0)
            .map(e => e.title)
        console.log(`${projectDir}: regenerating over ${titles.length} recorded title(s)`)
        owned = await regenerateOwned(projectDir, doc, titles)
        fs.writeFileSync(
            ownedFile,
            owned
                .map(
                    o =>
                        `OWNED: "${o.quote}"${o.anchor ? ` [anchor: ${o.anchor}]` : ''}`
                        + ` [title: ${o.title.replace(/\n/g, ' ')}]`
                )
                .join('\n') + '\n',
            'utf8'
        )
        console.log(`  wrote ${ownedFile}`)
    }
    report(projectDir, measureTouch(owned, tasks), tasks.length)
}

if (process.argv[1] && process.argv[1].endsWith('owned-consumer-generality-step0.ts')) {
    void main()
}
