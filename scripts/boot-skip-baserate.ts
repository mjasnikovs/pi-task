/**
 * STEP 0 for nexttask 1 — the BASE RATE of "a boot command was discovered, it was
 * SKIPPED, and the final gate still returned a bare PASS", measured with the
 * SHIPPED gate before any lever exists.
 *
 * Methodology rule this satisfies: measure the base rate BEFORE changing code
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md). A lever wired without
 * one cannot distinguish "removed the bad shape" from "the shape was never there".
 *
 * Per tree it records exactly the four fields nexttask 1 asks for:
 *
 *     boot command discovered?   the label, or "none"
 *     boot outcome               pass | fail | skip | orphan-port | none
 *     dynObserved (non-boot)     n        (derived — see deriveNonBootObserved)
 *     gate verdict               PASS | UNOBSERVED | FAIL
 *
 * The boot outcome is measured by a DIRECT runBootCheck built with the same deps
 * the gate builds for itself (render + deep-render probes, declared-port
 * preference), not inferred from the verdict: on a FAILing tree the gate's reason
 * carries only failures, so a boot `pass` and a boot `skip` are indistinguishable
 * from the outside — precisely the ambiguity this whole task is about.
 *
 * Nothing runs in a corpus tree; every entry is cloned first. See
 * scripts/boot-skip-corpus.ts for the isolation and for the docker shim that
 * reproduces run 18's docker-less sandbox on a box that HAS docker.
 *
 * Run: bun run scripts/boot-skip-baserate.ts
 */
import {existsSync, rmSync} from 'node:fs'
import * as path from 'node:path'
import {
    discoverBootCommand,
    detectsServedApp,
    runBootCheck,
    preferredDeclaredPort,
    runFinalIntegrationGate,
    type BootDeps
} from '../src/task/final-gate.js'
import {runRenderCheck} from '../src/task/render-check.js'
import {runDeepRenderCheck} from '../src/task/deep-render-check.js'
import {
    DISCOVERY_ONLY,
    FIXTURE_CORPUS,
    REPO_CORPUS,
    deriveNonBootObserved,
    installDockerlessShim,
    makeWorkRoot,
    materialise,
    verdictOf,
    type BootClass,
    type CorpusEntry
} from './boot-skip-corpus.js'

interface Row {
    label: string
    note: string
    bootLabel: string | null
    expectServer: boolean
    boot: BootClass
    nonBootObserved: number
    verdict: 'PASS' | 'UNOBSERVED' | 'FAIL'
    /** The RAW shape: a boot command was discovered, it was skipped, and the gate
     *  still returned a bare PASS. Includes CLI projects. */
    target: boolean
    /** The raw shape on a SERVED app — the subset the lever is allowed to act on
     *  (inv-cli-unaffected fences off `expectServer === false`). */
    targetServed: boolean
    ms: number
}

const rows: Row[] = []

async function measure(entry: CorpusEntry, work: string): Promise<void> {
    if (entry.kind === 'repo' && !existsSync(entry.source)) {
        console.log(`\n${entry.label}: SKIP (missing)`)
        return
    }
    const t0 = Date.now()
    const cwd = materialise(entry, path.join(work, entry.label.replace(/[^\w.@-]+/g, '_')))
    const boot = discoverBootCommand(cwd)
    const bootLabel = boot ? `${boot[0]} ${boot[1].join(' ')}` : null
    const expectServer = detectsServedApp(cwd)
    let bootClass: BootClass = 'none'
    if (boot) {
        const deps: BootDeps = {
            renderProbe: runRenderCheck,
            deepRenderProbe: url => runDeepRenderCheck(url, cwd),
            preferredPort: () => preferredDeclaredPort(cwd)
        }
        const b = await runBootCheck(cwd, boot, 10_000, {expectServer, deps})
        bootClass = b.outcome
    }
    const out = await runFinalIntegrationGate(cwd, entry.timeoutMs ?? 300_000)
    const verdict = verdictOf(out)
    const row: Row = {
        label: entry.label,
        note: entry.note,
        bootLabel,
        expectServer,
        boot: bootClass,
        nonBootObserved: deriveNonBootObserved(out, bootLabel),
        verdict,
        target: bootLabel !== null && bootClass === 'skip' && verdict === 'PASS',
        targetServed:
            bootLabel !== null && bootClass === 'skip' && verdict === 'PASS' && expectServer,
        ms: Date.now() - t0
    }
    rows.push(row)
    console.log(`\n=== ${row.label}   (${(row.ms / 1000).toFixed(0)}s)`)
    console.log(`  ${row.note}`)
    console.log(`  boot discovered      ${row.bootLabel ?? 'none'}`)
    console.log(`  expectServer         ${row.expectServer}`)
    console.log(`  boot outcome         ${row.boot}`)
    console.log(`  dynObserved non-boot ${row.nonBootObserved}`)
    console.log(`  gate verdict         ${row.verdict}`)
    console.log(`  reason               ${out.reason.slice(0, 240).replace(/\n/g, ' | ')}`)
    console.log(
        `  >>> TARGET SHAPE     ${
            row.targetServed ? 'YES (served) — bare PASS over a skipped boot'
            : row.target ? 'raw yes, but expectServer false — outside the lever'
            : 'no'
        }`
    )
    rmSync(cwd, {recursive: true, force: true})
}

const work = makeWorkRoot('baserate')
installDockerlessShim(work)
console.log(`work dir: ${work}`)
console.log('docker/docker-compose shimmed to exit 127 (reproducing run 18\'s sandbox)\n')

// Optional argv filters (substring match on the label) — for iterating on one tree
// without paying for the whole corpus. The reported base rate is only the full-run one.
const filters = process.argv.slice(2)
const selected = [...REPO_CORPUS, ...FIXTURE_CORPUS].filter(
    e => filters.length === 0 || filters.some(f => e.label.includes(f))
)

try {
    for (const entry of selected) await measure(entry, work)

    // Discovery-only arm: no gate run (nothing is discoverable, so nothing would
    // execute), but the boot-DISCOVERY answer is the FP-relevant fact.
    console.log('\n=== discovery-only (read-only, no gate run)')
    for (const {label, dir, note} of DISCOVERY_ONLY) {
        if (!existsSync(dir)) {
            console.log(`  ${label}: SKIP (missing)`)
            continue
        }
        const b = discoverBootCommand(dir)
        console.log(
            `  ${label}: boot ${b ? `\`${b[0]} ${b[1].join(' ')}\`` : 'none'} `
                + `(expectServer ${detectsServedApp(dir)}) — ${note}`
        )
    }

    const discoveredAndSkipped = rows.filter(r => r.bootLabel !== null && r.boot === 'skip')
    const raw = rows.filter(r => r.target)
    const hits = rows.filter(r => r.targetServed)
    const realHits = hits.filter(r => !r.label.startsWith('fixture:'))
    const realNonMx5Hits = realHits.filter(r => !r.label.startsWith('mx5'))

    console.log('\n\n=== BASE RATE ===')
    console.log(`  trees measured                                   ${rows.length}`)
    console.log(`  boot discovered AND skipped                      ${discoveredAndSkipped.length}`)
    console.log(`  ... of those, gate still returned a bare PASS    ${raw.length}`)
    console.log(`  ... of those, on a SERVED app (the lever's set)  ${hits.length}`)
    console.log(
        `  BASE RATE (served target shape / trees measured) ${hits.length}/${rows.length}`
            + ` = ${((hits.length / Math.max(1, rows.length)) * 100).toFixed(1)}%`
    )
    console.log(`  real (non-fixture) trees exhibiting it           ${realHits.length}`)
    console.log(`  real NON-MX5 trees exhibiting it                 ${realNonMx5Hits.length}`)
    for (const h of hits) console.log(`    - ${h.label}`)
    if (realNonMx5Hits.length === 0) {
        console.log(
            '\n  GENERALITY: zero non-mx5 real trees exhibit the shape in this corpus.'
                + '\n  The lever is mx5-shaped here and its generality is UNPROVEN — a finding'
                + '\n  to record, not a blocker (nexttask 1, STEP 0).'
        )
    }
    console.log('\n  per-tree table (label | boot | outcome | nonBootObs | verdict):')
    for (const r of rows) {
        console.log(
            `    ${r.label.padEnd(44)} ${(r.bootLabel ?? 'none').padEnd(16)} `
                + `${r.boot.padEnd(12)} ${String(r.nonBootObserved).padEnd(3)} ${r.verdict}`
        )
    }
} finally {
    rmSync(work, {recursive: true, force: true})
}
