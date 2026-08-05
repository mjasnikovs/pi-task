/**
 * A/B-1 for nexttask 8 — deterministic, over every recorded task file.
 *
 *   baseline    refine CONSTRAINTS as recorded
 *   treatment   + refutation-driven token drop
 *
 * PRE-REGISTERED METRIC, and one deviation from the task doc, stated up front.
 * The doc names "the composed spec's CONSTRAINTS block" as the metric. A
 * composed spec is model output; it cannot be re-derived deterministically from
 * a recorded task file, so measuring it here would silently make A/B-1 a live
 * experiment. The metric is therefore taken one step upstream, at the exact
 * artifact this pass controls and compose consumes:
 *
 *   per task, the set of tokens that (a) the file's own research CONTEXT
 *   refutes and (b) still appear as a requirement in the CONSTRAINTS text
 *   handed to compose.
 *
 * That is the mechanical cause of the lead — compose cannot forbid `Bun.password`
 * "because the refined task explicitly requires `argon2`" if the refined task no
 * longer requires `argon2`. The spec-level and delivery-level claims stay where
 * the doc puts them, in A/B-2.
 *
 *   PASS      run 19's TASK_0001 carries {argon2, bun-sql} in the baseline and
 *             {} in the treatment, AND all five invariants hold corpus-wide.
 *   FAIL      either survives, or any invariant breaks.
 *   ABSTAIN   the recorded task files are unavailable.
 *
 * INVARIANTS
 *   inv-owned-untouched          a line carrying the owned-requirement stamp is
 *                                never modified or dropped. Corpus refined
 *                                prompts carry no owned lines, so this is also
 *                                exercised by a forced fixture below — the guard
 *                                that keeps this pass out of nexttask 2's
 *                                failure mode has to be tested where it bites.
 *   inv-no-line-invention        treatment is a strict character subsequence of
 *                                baseline. The pass only deletes.
 *   inv-precision                every drop corpus-wide is on the hand-verified
 *                                allowlist below. One drop outside it is a FAIL
 *                                of the task, not a tuning note.
 *   inv-trail                    every drop produced a trail line quoting both
 *                                source lines.
 *   inv-noop-when-no-refutation  files with no detected pair are byte-identical.
 *
 * Run: bun run scripts/refuted-constraint-ab.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {extractSection} from '../src/task/task-parsers.js'
import {
    applyRefutations,
    detectRefutations,
    extractCapsSection
} from '../src/task/refuted-constraint.js'

const ROOTS = [
    path.join(os.homedir(), 'hub'),
    path.join(os.homedir(), 'tmp'),
    path.join(os.homedir(), '.cache')
]

/**
 * The hand-verified drop set from STEP 0 — every drop the closed negation set
 * produces over 12,810 corpus task files, read by hand and confirmed a real
 * refutation. `<token>` on `<task file basename>`.
 */
const VERIFIED_DROPS = new Set(['argon2@TASK_0001.md', 'bun-sql@TASK_0001.md'])

/** The lead. Both tokens must clear the treatment arm. */
const LEAD_ID = 'TASK_0001.md'
const LEAD_TOKENS = ['argon2', 'bun-sql']

type TaskDoc = {origin: string; id: string; body: string}

function git(repo: string, args: string[]): string {
    try {
        return execFileSync('git', ['-C', repo, ...args], {
            encoding: 'utf8',
            maxBuffer: 256 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        })
    } catch {
        return ''
    }
}

function findTaskDirs(root: string, depth = 4): string[] {
    const out: string[] = []
    const walk = (dir: string, d: number) => {
        if (d < 0) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue
            if (e.name === 'node_modules' || e.name === '.git') continue
            if (e.name === '.pi-tasks') {
                out.push(path.join(dir, e.name))
                continue
            }
            walk(path.join(dir, e.name), d - 1)
        }
    }
    walk(root, depth)
    return out
}

function hash(s: string): string {
    let h = 0
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
    return String(h)
}

function collect(): TaskDoc[] {
    const docs: TaskDoc[] = []
    const seen = new Set<string>()
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        for (const dir of findTaskDirs(root)) {
            for (const f of fs.readdirSync(dir).filter(n => /^TASK_\d+\.md$/.test(n))) {
                const full = path.join(dir, f)
                if (seen.has(`disk:${full}`)) continue
                seen.add(`disk:${full}`)
                docs.push({
                    origin: full.replace(os.homedir(), '~'),
                    id: f,
                    body: fs.readFileSync(full, 'utf8')
                })
            }
            const repo = path.dirname(dir)
            for (const sha of git(repo, ['log', '--all', '--format=%H', '--', '.pi-tasks/'])
                .split('\n')
                .filter(Boolean)) {
                for (const f of git(repo, ['ls-tree', '--name-only', `${sha}:.pi-tasks`])
                    .split('\n')
                    .filter(n => /^TASK_\d+\.md$/.test(n))) {
                    const body = git(repo, ['show', `${sha}:.pi-tasks/${f}`])
                    if (!body) continue
                    const key = `${path.basename(repo)}:${f}:${hash(body)}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    docs.push({
                        origin: `${path.basename(repo)}@${sha.slice(0, 7)}:${f}`,
                        id: f,
                        body
                    })
                }
            }
        }
    }
    return docs
}

/** Character subsequence — the mechanical form of "only deletes". */
function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0
    for (const ch of haystack) if (i < needle.length && needle[i] === ch) i++
    return i === needle.length
}

/**
 * The metric: tokens this file's own research refutes that are STILL required by
 * the CONSTRAINTS text compose will receive.
 */
function surviving(refined: string, research: string): string[] {
    return [...new Set(detectRefutations(refined, research).map(r => r.token))].sort()
}

const OWNED_STAMP =
    'owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)'

/**
 * inv-owned-untouched where it actually bites: an owned CONSTRAINTS line naming
 * a token the research refutes. Corpus refined prompts carry no owned lines, so
 * without this the invariant would pass vacuously.
 */
function ownedFixture(): {ok: boolean; detail: string} {
    const refined = [
        'GOAL',
        'Scaffold the project.',
        '',
        'CONSTRAINTS',
        `  - "Password hashing uses \`argon2\`" [4. Auth] — ${OWNED_STAMP}`,
        '- Add only new entries the task requires (e.g., `hono`, `argon2`, `sharp`).',
        ''
    ].join('\n')
    const research = [
        'CONTEXT',
        "- Password hashing uses `Bun.password` (built-in argon2id) — no external `argon2` dependency needed despite the task's mention of it.",
        ''
    ].join('\n')
    const {refined: out, trail} = applyRefutations(refined, research)
    const ownedLine = refined.split('\n').find(l => l.includes(OWNED_STAMP))!
    const ownedSurvives = out.includes(ownedLine)
    const invented = out.split('\n').find(l => l.includes(OWNED_STAMP) && l !== ownedLine)
    const nonOwnedDropped =
        !out.includes('`argon2`, `sharp`') && !/`argon2`/.test(out.split('\n')[5] ?? '')
    return {
        ok: ownedSurvives && invented === undefined && nonOwnedDropped && trail.length === 1,
        detail: `ownedSurvives=${ownedSurvives} nonOwnedDropped=${nonOwnedDropped} drops=${trail.length}`
    }
}

function main(): void {
    const docs = collect()
    if (docs.length === 0) {
        console.log('ABSTAIN — no recorded task files found')
        process.exit(2)
    }

    let considered = 0
    let baselineWithSurvivor = 0
    let treatmentWithSurvivor = 0
    let noopViolations = 0
    let subsequenceViolations = 0
    let trailViolations = 0
    let ownedViolations = 0
    const unverifiedDrops: string[] = []
    const leadRows: string[] = []

    for (const doc of docs) {
        const refined = extractSection(doc.body, 'refined prompt')
        const research = extractSection(doc.body, 'research')
        if (!refined || !research) continue
        if (extractCapsSection(refined, 'CONSTRAINTS') === null) continue
        if (extractCapsSection(research, 'CONTEXT') === null) continue
        considered++

        const base = surviving(refined, research)
        const {refined: treated, trail, refutations} = applyRefutations(refined, research)
        const after = surviving(treated, research)

        if (base.length > 0) baselineWithSurvivor++
        if (after.length > 0) treatmentWithSurvivor++

        // inv-noop-when-no-refutation
        if (refutations.length === 0 && treated !== refined) noopViolations++
        // inv-no-line-invention
        if (!isSubsequence(treated, refined)) subsequenceViolations++
        // inv-trail
        if (trail.length !== refutations.length || trail.some(t => !t.includes('| research: "')))
            trailViolations++
        // inv-owned-untouched (corpus side)
        for (const line of refined.split('\n')) {
            if (line.includes(OWNED_STAMP) && !treated.includes(line)) ownedViolations++
        }
        // inv-precision
        for (const r of refutations) {
            if (!VERIFIED_DROPS.has(`${r.token}@${doc.id}`))
                unverifiedDrops.push(`${doc.origin} ${r.token}`)
        }

        if (doc.id === LEAD_ID && base.length > 0) {
            leadRows.push(
                `  ${doc.origin}   baseline=[${base.join(', ')}]  treatment=[${after.join(', ')}]`
            )
        }
    }

    const owned = ownedFixture()

    console.log(
        `corpus              ${docs.length} recorded task files, ${considered} with CONSTRAINTS+CONTEXT`
    )
    console.log(
        `\nMETRIC — tasks whose CONSTRAINTS still require a token their own research refutes`
    )
    console.log(`  baseline    ${baselineWithSurvivor} / ${considered}`)
    console.log(`  treatment   ${treatmentWithSurvivor} / ${considered}`)
    console.log(`\nLEAD (run 19 TASK_0001):`)
    for (const row of leadRows) console.log(row)

    console.log(`\nINVARIANTS`)
    console.log(
        `  inv-owned-untouched          corpus violations ${ownedViolations}; forced fixture ${owned.ok ? 'HOLDS' : 'BREAKS'} (${owned.detail})`
    )
    console.log(`  inv-no-line-invention        violations ${subsequenceViolations}`)
    console.log(`  inv-precision                unverified drops ${unverifiedDrops.length}`)
    for (const d of unverifiedDrops.slice(0, 20)) console.log(`      ${d}`)
    console.log(`  inv-trail                    violations ${trailViolations}`)
    console.log(`  inv-noop-when-no-refutation  violations ${noopViolations}`)

    const leadCleared =
        leadRows.length > 0
        && leadRows.every(
            r =>
                LEAD_TOKENS.every(t => r.includes(`baseline=[`) && r.includes(t))
                && r.includes('treatment=[]')
        )
    const invariantsHold =
        ownedViolations === 0
        && owned.ok
        && subsequenceViolations === 0
        && unverifiedDrops.length === 0
        && trailViolations === 0
        && noopViolations === 0

    console.log(`\nlead cleared        ${leadCleared}`)
    console.log(`invariants hold     ${invariantsHold}`)
    if (leadCleared && invariantsHold && treatmentWithSurvivor === 0) {
        console.log(`\nPASS`)
        process.exit(0)
    }
    console.log(`\nFAIL`)
    process.exit(1)
}

main()
