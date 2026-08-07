/**
 * A/B for nexttask 17A/17B — the docs version banner, replayed over every docs
 * lookup run 20 made.
 *
 * Offline, deterministic, no model anywhere. Both arms are the SHIPPED
 * `buildVersionBanner`: the baseline arm's copy comes out of git at the commit
 * before this lever, the treatment arm's is the working tree. Each entry is
 * replayed with the pin, package name and version the run actually recorded, and
 * with mx5's `package.json` AS IT WAS at that entry's timestamp — a banner is a
 * claim about the dependency tree at lookup time, and grading it against today's
 * tree would score the 13 correct banners as defects.
 *
 * WHY AN OFFLINE PROOF SHIPS THIS. The lever only ever makes the banner's claim
 * strictly SMALLER: it deletes a false sentence and replaces it with a true one
 * or with a narrower one. It cannot invent a fact for the impl model to act on,
 * so it needs no live delivery arm (nexttask16.md grants 16A the same exemption
 * and denies it to 16B/16C).
 *
 * ONE PROJECT: mx5 run 20, 120 docs lookups, npm-shaped. IAR1 is CMake and made
 * zero. Cache hits write no entry, so 120 is a lower bound.
 *
 * Run: bun run scripts/version-banner-ab.ts     (exit 0 = PASS)
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {corpusLine, docsLookups, treeAt, type DocsLookup} from './version-banner-corpus.js'
import {
    buildVersionBanner as treatmentBanner,
    declarationChain,
    findDeclaration,
    type AutoInstallPin
} from '../src/workers/docs-core.js'

const REPO = path.resolve(import.meta.dir, '..')

type BannerFn = (
    pin: AutoInstallPin | undefined,
    resolved: string,
    version: string,
    cwd: string
) => string

/**
 * The commit BEFORE this lever, located by when `findDeclaration` — the symbol
 * 17A adds — first entered docs-core.ts. Naming `HEAD` instead would be an A/B
 * that silently stops measuring the moment the fix is committed: HEAD becomes
 * the fix, both arms become the treatment, and a dead instrument reads like a
 * null result (memory/ab-baseline-ref-must-not-move.md). Falls back to HEAD only
 * while the lever is still uncommitted.
 */
export function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '--format=%H', '-S', 'export function findDeclaration', '--', 'src/workers/docs-core.ts'],
        {cwd: REPO, encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    return sha ? `${sha}^` : 'HEAD'
}

/** `buildVersionBanner` as SHIPPED at `ref`, imported from a `git archive` export. */
async function baselineArm(ref: string): Promise<BannerFn> {
    const dir = path.join(os.tmpdir(), `pi-task-version-banner-baseline-${ref.replace(/\W/g, '_')}`)
    if (!fs.existsSync(path.join(dir, 'src/workers/docs-core.ts'))) {
        fs.mkdirSync(dir, {recursive: true})
        const tar = spawnSync('git', ['archive', ref, 'src'], {
            cwd: REPO,
            encoding: 'buffer',
            maxBuffer: 256 * 1024 * 1024
        })
        if (tar.status !== 0) throw new Error(`git archive ${ref} src failed`)
        const tarPath = path.join(dir, 'baseline.tar')
        fs.writeFileSync(tarPath, tar.stdout)
        if (spawnSync('tar', ['-xf', tarPath, '-C', dir]).status !== 0) {
            throw new Error('tar extract failed')
        }
    }
    const mod = (await import(path.join(dir, 'src/workers/docs-core.js'))) as {
        buildVersionBanner: BannerFn
    }
    return mod.buildVersionBanner
}

interface Replay {
    row: DocsLookup
    baseline: string
    treatment: string
    /** The declaration the treatment found on the chain, at lookup time. */
    declared?: {pkg: string; value: string; usable: boolean}
}

function replay(rows: DocsLookup[], baseline: BannerFn): Replay[] {
    return rows.map(row => {
        const cwd = treeAt(row.at)
        // The terminal of the resolution chain is what the shipped banner named;
        // for a lookup that produced no banner there is nothing to name.
        const resolved = row.named || row.asked
        const treatmentPin: AutoInstallPin | undefined =
            row.pin ? {...row.pin, asked: row.asked} : undefined
        return {
            row,
            baseline: baseline(row.pin, resolved, row.version, cwd),
            treatment: treatmentBanner(treatmentPin, resolved, row.version, cwd),
            declared:
                findDeclaration(declarationChain(row.asked, resolved), cwd) ?? undefined
        }
    })
}

interface Invariant {
    name: string
    /** The entries it applies to. An invariant with an empty population FAILS. */
    population: (r: Replay) => boolean
    holds: (r: Replay) => boolean
}

const INVARIANTS: Invariant[] = [
    {
        // Not a lever claim — a claim about the INSTRUMENT. If the baseline arm
        // does not reproduce the sentence the run actually wrote, the replay is
        // not replaying run 20 and nothing below it means anything.
        name: 'replay fidelity — baseline reproduces the recorded banner byte-for-byte',
        population: r => r.row.kind !== 'none',
        holds: r => r.baseline === r.row.bannerText
    },
    {
        name: '17A — a banner that named a package nobody asked about now names the asked one',
        population: r => r.row.kind !== 'none' && r.row.named !== r.row.asked,
        holds: r =>
            r.treatment.startsWith(`[VERSION`)
            && r.treatment.split('"')[1] === r.row.asked
            && !r.treatment.includes(`"${r.row.named}"`)
    },
    {
        name: '17A — the correct banners are BYTE-IDENTICAL',
        population: r =>
            r.row.kind === 'not-declared' && r.row.named === r.row.asked && r.declared === undefined,
        holds: r => r.treatment === r.row.bannerText
    },
    {
        name: 'no entry gains a banner it did not have',
        population: r => r.row.kind === 'none',
        holds: r => r.treatment === ''
    }
]

async function main(): Promise<void> {
    const rows = docsLookups()
    const ref = baselineRef()
    console.log(corpusLine(rows))
    console.log(`baseline: src/ @ ${ref}   treatment: working tree\n`)

    const baseline = await baselineArm(ref)
    const reps = replay(rows, baseline)

    let failed = 0
    for (const inv of INVARIANTS) {
        const pop = reps.filter(inv.population)
        const bad = pop.filter(r => !inv.holds(r))
        const ok = pop.length > 0 && bad.length === 0
        if (!ok) failed++
        console.log(
            `  ${ok ? 'PASS' : 'FAIL'}  ${inv.name}\n`
            + `        n=${pop.length}${bad.length ? `  violations=${bad.length}` : ''}`
            + `${pop.length === 0 ? '  (EMPTY POPULATION — an invariant with nothing to check is not a check)' : ''}`
        )
        for (const b of bad.slice(0, 3)) {
            console.log(`        ${b.row.asked} -> ${b.row.named} @ ${new Date(b.row.at).toISOString()}`)
            console.log(`          baseline : ${b.baseline.trim().slice(0, 150)}`)
            console.log(`          treatment: ${b.treatment.trim().slice(0, 150)}`)
        }
    }

    const changed = reps.filter(r => r.baseline !== r.treatment)
    console.log(`\n  banners changed: ${changed.length}/${reps.length}`)
    const shapes = new Map<string, number>()
    for (const c of changed) shapes.set(c.treatment, (shapes.get(c.treatment) ?? 0) + 1)
    for (const [text, n] of [...shapes].sort((a, b) => b[1] - a[1])) {
        console.log(`\n  x${n}  ${text.trim()}`)
    }

    console.log(failed === 0 ? '\nA/B: PASS' : `\nA/B: FAIL (${failed} invariant(s))`)
    process.exitCode = failed === 0 ? 0 : 1
}

if (import.meta.main) await main()
