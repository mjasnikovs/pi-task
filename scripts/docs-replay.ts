/**
 * DOCS REPLAY — re-runs a recorded docs extraction through production's own prompt
 * builder and child runner. No `/task-auto`, and by default no retrieval either.
 *
 * WHY THIS EXISTS. The docs worker is a subagent: `docsLookup` is a function of
 * (chunks, query) that spawns one `--no-tools` child. A full live run costs 3-4
 * hours to exercise it and hands back a query set that has never once repeated —
 * 158 recorded pairs over four runs, 158 of them distinct. That makes the live run
 * a DISCOVERY instrument and a poor VERIFICATION one: two arms cannot be compared
 * on stimuli neither arm will see twice.
 *
 * The recorded answer log closes that gap. Since the defect 9 fix each record
 * carries `retrievedText` — the exact bytes the child was shown — and
 * `excerptCheck.contentSha256` over them. So a replay does not have to re-retrieve,
 * and the drift that moved a decided A/B cell a whole rung (container and host
 * returning different chunks for one query) cannot reach it. `integrity` below
 * refuses any record whose bytes no longer hash to what the run checked them
 * against, rather than scoring a child against material it never saw.
 *
 * WHAT IT CANNOT SEE. Whether a fix changes what the CALLING worker asks, since
 * the query is a frozen tool parameter; and anything downstream of the answer,
 * which is where defect 14 lives. Those still need `DOCS-LIVE-RUNBOOK.md`.
 *
 * `--retrieve <project>` is the deliberate exception to "no retrieval". Defects
 * 11 and 12 are INDEX fixes, and the recorded bytes predate them, so a recorded
 * replay can only ever re-answer the old corpus. That mode re-runs `docsRaw`
 * against a real project and extracts over what comes back. It buys the index
 * half and it pays the environment dependence back — so it is never the default,
 * it must run where the deps are pinned, and every ledger row says which mode
 * produced it.
 */
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {runFocusedExtraction} from '../src/workers/focused-extractor.js'
import {docsRaw, packageCorpus} from '../src/workers/docs-core.js'
import {projectCorpus} from '../src/workers/docs-project.js'
import {isAbstention} from '../src/workers/abstention.js'
import {normaliseWhitespace} from '../src/shared/child-output.js'
import {groupChildArgs} from '../src/config/group-args.js'
import type {DocsCorpus} from '../src/workers/docs-lookup.js'
import type {ResolvedPackage} from '../src/workers/docs-resolve.js'
import type {EcosystemId} from '../src/workers/docs-ecosystems.js'
import type {TypeOnlyLogRecord} from '../src/workers/typeonly-log.js'

/** The two halves of a comparison. `treatment` is production, byte for byte. */
export type Arm = 'treatment' | 'control'

/** One recorded answer that is fit to replay. */
export interface ReplayRecord {
    source: string
    module: string
    query: string
    retrievedText: string
    contentSha256: string
    /** What the live run's child did, so a replay is a delta and not a fresh reading. */
    wasUnclear: boolean
    wasExcerptVerified: boolean | undefined
    identity: RecordIdentity
    corpus: DocsCorpus
}

/** A record the corpus cannot accept, and the one reason why. */
export interface SkippedRecord {
    source: string
    module: string
    reason: 'no-retrieved-text' | 'sha-mismatch' | 'unrecoverable-identity'
}

const REGISTRY_TO_ECOSYSTEM: Record<string, EcosystemId> = {
    npm: 'npm',
    'crates.io': 'cargo',
    hackage: 'hackage'
}

/** Which corpus the recorded lookup read, named well enough to retrieve it again. */
export type RecordIdentity =
    | {kind: 'project'; label: string}
    | {kind: 'package'; ecosystem: EcosystemId; name: string; version: string}

/**
 * Recover what the live lookup was reading, from the tool text it returned.
 *
 * The record stores `module` but not the resolved version or registry, and both
 * are in the prompt — so a guess would build a prompt production never sent. Both
 * are recoverable verbatim: the tool return leads with `### <registry>: <name>`
 * and `Per <name>@<version>:`, or with the project corpus's own header. Banners
 * (`[DEPENDENCY]`, `[VERSION]`) can precede either, so both patterns are matched
 * multiline rather than at offset zero.
 */
export function recoverIdentity(toolText: string): RecordIdentity | null {
    const project = /^Per (.+?) \(project source\):$/m.exec(toolText)
    if (project) return {kind: 'project', label: project[1]}

    const registry = /^### ([^:\n]+): (\S+)$/m.exec(toolText)
    const per = /^Per (.+?)@([^:\n]+):$/m.exec(toolText)
    if (!registry || !per) return null
    const ecosystem = REGISTRY_TO_ECOSYSTEM[registry[1]]
    if (!ecosystem) return null
    return {kind: 'package', ecosystem, name: per[1], version: per[2]}
}

/**
 * Rebuild the corpus the live lookup used.
 *
 * `root`, `entry` and `readme` are filled with blanks: `packageCorpus` reads only
 * name, version and ecosystem, and inventing paths here would put fiction one
 * refactor away from the prompt.
 */
export function corpusFor(id: RecordIdentity): DocsCorpus {
    if (id.kind === 'project') return projectCorpus(id.label)
    const pkg: ResolvedPackage = {
        ecosystem: id.ecosystem,
        name: id.name,
        version: id.version,
        root: '',
        entry: null,
        readme: null
    }
    return packageCorpus(pkg)
}

export function recoverCorpus(toolText: string): DocsCorpus | null {
    const id = recoverIdentity(toolText)
    return id === null ? null : corpusFor(id)
}

/** Do the stored bytes still hash to what the live run verified the excerpt against? */
export function integrity(rec: Pick<TypeOnlyLogRecord, 'retrievedText' | 'excerptCheck'>): boolean {
    if (!rec.retrievedText || !rec.excerptCheck) return false
    const h = createHash('sha256').update(normaliseWhitespace(rec.retrievedText)).digest('hex')
    return h === rec.excerptCheck.contentSha256
}

export function parseRecords(
    text: string,
    source: string
): {records: ReplayRecord[]; skipped: SkippedRecord[]} {
    const records: ReplayRecord[] = []
    const skipped: SkippedRecord[] = []
    for (const line of text
        .trim()
        .split('\n')
        .filter(l => l.trim().length > 0)) {
        const r = JSON.parse(line) as TypeOnlyLogRecord
        if (!r.retrievedText || r.retrievedText.length === 0) {
            skipped.push({source, module: r.module, reason: 'no-retrieved-text'})
            continue
        }
        if (!integrity(r)) {
            skipped.push({source, module: r.module, reason: 'sha-mismatch'})
            continue
        }
        const identity = recoverIdentity(r.toolText ?? '')
        if (!identity) {
            skipped.push({source, module: r.module, reason: 'unrecoverable-identity'})
            continue
        }
        records.push({
            source,
            module: r.module,
            query: r.query,
            retrievedText: r.retrievedText,
            contentSha256: r.excerptCheck?.contentSha256 ?? '',
            wasUnclear: r.unclear,
            wasExcerptVerified: r.excerptVerified,
            identity,
            corpus: corpusFor(identity)
        })
    }
    return {records, skipped}
}

export function loadCorpusFiles(paths: readonly string[]): {
    records: ReplayRecord[]
    skipped: SkippedRecord[]
} {
    const records: ReplayRecord[] = []
    const skipped: SkippedRecord[] = []
    for (const p of paths) {
        const found = parseRecords(fs.readFileSync(p, 'utf8'), path.basename(p))
        records.push(...found.records)
        skipped.push(...found.skipped)
    }
    return {records, skipped}
}

/**
 * Rule 4's mixed-question clause, as it renders for any corpus tag. The lever
 * under test in defect 15: answer the parts the content covers rather than
 * discarding them with the part it does not.
 */
const MIXED_CLAUSE =
    /^ {3}A question with several parts: answer the parts <[a-z]+-content> covers, and name\n {3}the parts it does not\. Use rule 4's sentence alone only when it covers no part\.\n/m

/**
 * Build the control arm by DELETING the lever from production's own output, so the
 * two arms differ by exactly the clause and nothing else. A hand-written control
 * prompt is how six wrong scorers got shipped over three sessions.
 *
 * Throws rather than returning the prompt unchanged: if the clause is reworded in
 * `abstention.ts`, a silent no-op here would run both arms on production and
 * report a real-looking tie.
 */
export function stripMixedClause(prompt: string): string {
    if (!MIXED_CLAUSE.test(prompt)) {
        throw new Error(
            'docs-replay: rule 4 mixed-question clause not found. Production wording changed; update MIXED_CLAUSE.'
        )
    }
    return prompt.replace(MIXED_CLAUSE, '')
}

export function buildArmPrompt(rec: ReplayRecord, arm: Arm, content = rec.retrievedText): string {
    const prompt = rec.corpus.buildPrompt(rec.query, content)
    return arm === 'treatment' ? prompt : stripMixedClause(prompt)
}

/** The recorded bytes, which is what a replay means unless `--retrieve` says otherwise. */
export function recordedMaterial(rec: ReplayRecord): Material {
    return {content: rec.retrievedText, from: 'recorded', chunks: 0}
}

/**
 * What the child is shown, and where it came from.
 *
 * `recorded` is the default and the only immune one: the bytes are the run's own,
 * hash-checked. `live` exists for the one question a recorded replay cannot ask —
 * whether an INDEX fix reaches the answer — and pays for it by re-entering the
 * environment dependence the recording removed. So it is never the default and the
 * ledger always says which one a row is.
 */
export type Material = {content: string; from: 'recorded' | 'live'; chunks: number}

/**
 * Re-retrieve a record's content through this tree's own `docsRaw`.
 *
 * `npmVersionLookup` is stubbed off because it only decorates the tool text's
 * version banner, never the chunks — and the chunks are the whole prompt content
 * here, so the network buys nothing and can only make the instrument flaky.
 */
export async function retrieveLive(rec: ReplayRecord, cwd: string): Promise<Material> {
    if (rec.identity.kind !== 'package') {
        throw new Error(
            `docs-replay: --retrieve cannot re-retrieve the project corpus (${rec.module})`
        )
    }
    const raw = await docsRaw({
        pkg: rec.identity.name,
        query: rec.query,
        cwd,
        ecosystem: rec.identity.ecosystem,
        npmVersionLookup: () => Promise.resolve(null)
    })
    if (raw.kind !== 'ok') {
        throw new Error(`docs-replay: retrieval for ${rec.module} returned ${raw.kind}`)
    }
    return {
        content: raw.chunks.map(c => c.content).join('\n\n'),
        from: 'live',
        chunks: raw.chunks.length
    }
}

/** One trial. Written to the ledger before anything is tallied. */
export interface ReplayRow {
    source: string
    module: string
    query: string
    arm: Arm
    trial: number
    ok: boolean
    answer: string
    unclear: boolean
    excerptVerified: boolean | undefined
    wasUnclear: boolean
    from: Material['from']
    chunks: number
    bytes: number
    failure?: string
}

export async function replayOne(
    rec: ReplayRecord,
    arm: Arm,
    trial: number,
    cwd: string,
    material: Material
): Promise<ReplayRow> {
    const result = await runFocusedExtraction({
        prompt: buildArmPrompt(rec, arm, material.content),
        verifyAgainst: material.content,
        cwd,
        groupArgs: groupChildArgs('extraction'),
        abortedMessage: rec.corpus.abortedMessage
    })
    const base = {
        source: rec.source,
        module: rec.module,
        query: rec.query,
        arm,
        trial,
        wasUnclear: rec.wasUnclear,
        from: material.from,
        chunks: material.chunks,
        bytes: material.content.length
    }
    if (!result.ok) {
        return {
            ...base,
            ok: false,
            answer: '',
            unclear: false,
            excerptVerified: undefined,
            failure: result.failure
        }
    }
    return {
        ...base,
        ok: true,
        answer: result.answer,
        unclear: isAbstention(result.answer),
        excerptVerified: result.excerptVerified
    }
}

export interface ArmTally {
    arm: Arm
    trials: number
    failed: number
    /** Split by what the LIVE run did, because that is the delta being measured. */
    wasUnclearTotal: number
    wasUnclearStillUnclear: number
    wasAnsweredTotal: number
    wasAnsweredNowUnclear: number
    /**
     * Counted over ANSWERED trials only. Rule 4 tells an abstaining child to cite
     * "the closest related text", which verifies for free, so a pooled rate rewards
     * the arm that abstains more — the exact direction under test.
     */
    excerptVerified: number
    excerptChecked: number
}

export function tally(rows: readonly ReplayRow[]): ArmTally[] {
    const arms: Arm[] = ['treatment', 'control']
    return arms
        .map(arm => {
            const mine = rows.filter(r => r.arm === arm)
            const ok = mine.filter(r => r.ok)
            const wasUnclear = ok.filter(r => r.wasUnclear)
            const wasAnswered = ok.filter(r => !r.wasUnclear)
            const answered = ok.filter(r => !r.unclear)
            return {
                arm,
                trials: mine.length,
                failed: mine.length - ok.length,
                wasUnclearTotal: wasUnclear.length,
                wasUnclearStillUnclear: wasUnclear.filter(r => r.unclear).length,
                wasAnsweredTotal: wasAnswered.length,
                wasAnsweredNowUnclear: wasAnswered.filter(r => r.unclear).length,
                excerptVerified: answered.filter(r => r.excerptVerified === true).length,
                excerptChecked: answered.filter(r => r.excerptVerified !== undefined).length
            }
        })
        .filter(t => t.trials > 0)
}

const pct = (n: number, d: number): string =>
    d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(0).padStart(4)}%`

export function formatSummary(
    tallies: readonly ArmTally[],
    skipped: readonly SkippedRecord[]
): string {
    const lines = [
        'arm        trials fail  recorded-abstain->abstain  recorded-answer->abstain  excerpt ok (answered)'
    ]
    for (const t of tallies) {
        lines.push(
            [
                t.arm.padEnd(10),
                String(t.trials).padStart(6),
                String(t.failed).padStart(4),
                `  ${String(t.wasUnclearStillUnclear).padStart(4)}/${String(t.wasUnclearTotal).padEnd(4)} ${pct(t.wasUnclearStillUnclear, t.wasUnclearTotal)}`,
                `    ${String(t.wasAnsweredNowUnclear).padStart(4)}/${String(t.wasAnsweredTotal).padEnd(4)} ${pct(t.wasAnsweredNowUnclear, t.wasAnsweredTotal)}`,
                `   ${String(t.excerptVerified).padStart(4)}/${String(t.excerptChecked).padEnd(4)} ${pct(t.excerptVerified, t.excerptChecked)}`
            ].join('')
        )
    }
    if (skipped.length > 0) {
        const by = new Map<string, number>()
        for (const s of skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1)
        lines.push(`\nskipped ${skipped.length}: ${[...by].map(([k, v]) => `${k}=${v}`).join(' ')}`)
    }
    return lines.join('\n')
}

interface Options {
    files: string[]
    arms: Arm[]
    trials: number
    only: 'all' | 'abstained' | 'answered'
    module: string | null
    limit: number | null
    dryRun: boolean
    out: string | null
    cwd: string
    /** A project root to re-retrieve against, or null for the recorded bytes. */
    retrieve: string | null
}

export function parseArgs(argv: readonly string[]): Options {
    const opts: Options = {
        files: [],
        arms: ['treatment', 'control'],
        trials: 1,
        only: 'all',
        module: null,
        limit: null,
        dryRun: false,
        out: null,
        cwd: process.cwd(),
        retrieve: null
    }
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--trials') opts.trials = Number(argv[++i])
        else if (a === '--arm') opts.arms = [argv[++i] as Arm]
        else if (a === '--only') opts.only = argv[++i] as Options['only']
        else if (a === '--module') opts.module = argv[++i]
        else if (a === '--retrieve') opts.retrieve = argv[++i]
        else if (a === '--limit') opts.limit = Number(argv[++i])
        else if (a === '--out') opts.out = argv[++i]
        else if (a === '--cwd') opts.cwd = argv[++i]
        else if (a === '--dry-run') opts.dryRun = true
        else if (a.startsWith('--')) throw new Error(`docs-replay: unknown flag ${a}`)
        else opts.files.push(a)
    }
    if (opts.files.length === 0) throw new Error('docs-replay: give at least one recorded .jsonl')
    return opts
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2))
    const {records, skipped} = loadCorpusFiles(opts.files)
    const matching = records.filter(
        r =>
            (opts.only === 'all' || (opts.only === 'abstained' ? r.wasUnclear : !r.wasUnclear))
            && (opts.module === null || r.module === opts.module)
    )
    const pool = opts.limit === null ? matching : matching.slice(0, opts.limit)

    // Fails before the first child rather than after the last: `getPiInvocation`
    // re-invokes `process.argv[1]` when it exists, which for a script under
    // scripts/ is this harness, and a harness that spawns itself once per record
    // is a fork bomb, not a run.
    if (!opts.dryRun && !process.env.PI_BIN) {
        throw new Error(
            'docs-replay: set PI_BIN to a real pi binary, or the child re-invokes this script'
        )
    }

    console.log(`${pool.length} replayable of ${records.length} loaded, ${skipped.length} skipped`)
    if (opts.dryRun) {
        // Proves the prompts rebuild without spending a model on it. `--retrieve`
        // is exercised too: retrieval is the half a dry run can afford, and a
        // corpus that no longer resolves must fail here, not after ten children.
        for (const rec of pool) {
            const material =
                opts.retrieve ? await retrieveLive(rec, opts.retrieve) : recordedMaterial(rec)
            if (opts.retrieve) {
                console.log(
                    `${rec.module.padEnd(12)} ${String(material.chunks).padStart(3)} chunks ${String(material.content.length).padStart(6)} B  ${rec.query.slice(0, 60)}`
                )
            }
            for (const arm of opts.arms) buildArmPrompt(rec, arm, material.content)
        }
        console.log(formatSummary([], skipped))
        console.log(`dry run: ${pool.length * opts.arms.length} prompts built, none sent`)
        return
    }

    const rows: ReplayRow[] = []
    const sink = opts.out ? fs.createWriteStream(opts.out, {flags: 'a'}) : null
    let done = 0
    const total = pool.length * opts.arms.length * opts.trials
    // Serial on purpose: one local model serves every child, so concurrent trials
    // contend and neither arm's duration means anything.
    for (let trial = 1; trial <= opts.trials; trial++) {
        for (const rec of pool) {
            // Retrieved once per record, so both arms are scored on the same
            // bytes even when retrieval is not deterministic.
            const material =
                opts.retrieve ? await retrieveLive(rec, opts.retrieve) : recordedMaterial(rec)
            for (const arm of opts.arms) {
                const row = await replayOne(rec, arm, trial, opts.cwd, material)
                rows.push(row)
                sink?.write(`${JSON.stringify(row)}\n`)
                done++
                process.stderr.write(`\r${done}/${total} ${rec.module.padEnd(18).slice(0, 18)}`)
            }
        }
    }
    process.stderr.write('\n')
    sink?.end()
    console.log(formatSummary(tally(rows), skipped))
}

if (import.meta.main) {
    main().catch((e: unknown) => {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
    })
}
