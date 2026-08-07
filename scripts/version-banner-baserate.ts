/**
 * STEP 0/1 for nexttask 17 — the BASE RATE of the docs version banner, measured
 * with the SHIPPED wording, before any lever exists.
 *
 * Methodology rule this satisfies: measure before changing code
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md). Without this table a
 * banner change cannot tell "the false sentences are gone" from "there were
 * never that many".
 *
 * Every number below is ONE project. mx5 run 20 is the whole npm-shaped corpus;
 * IAR1 is CMake, has no manifest, and made zero docs lookups. Cache hits write no
 * entry, so every count is a lower bound.
 *
 * Read-only: the evidence tree is touched with `git show` only.
 *
 * Run: bun run scripts/version-banner-baserate.ts
 */
import {
    corpusLine,
    declaredMap,
    docsLookups,
    treeAt,
    type DocsLookup
} from './version-banner-corpus.js'
import {typesPackageName} from '../src/workers/docs-resolve.js'

/** The names a declaration for `asked` could honestly live under. */
export function declarationChain(asked: string, resolved?: string): string[] {
    const out = [asked]
    const types = typesPackageName(asked)
    if (types && !out.includes(types)) out.push(types)
    if (resolved && !out.includes(resolved)) out.push(resolved)
    return out
}

/** A declared value that is not an installable pinned range: a dist-tag, a
 *  wildcard, or a non-registry protocol. Mirrors docs-core's `isUsableRange`. */
export function isUnpinned(range: string): boolean {
    const r = range.trim()
    if (r.length === 0 || r === '*' || r === 'x' || r === 'latest') return true
    return /^(?:workspace|link|file|git|github|http|https|portal|patch|npm):/i.test(r)
}

interface Row extends DocsLookup {
    /** package.json's declaration for each chain name at lookup time. */
    chain: Array<{pkg: string; range?: string}>
}

function classify(rows: DocsLookup[]): Row[] {
    return rows.map(r => {
        const declared = declaredMap(treeAt(r.at))
        return {
            ...r,
            chain: declarationChain(r.asked, r.named || undefined).map(pkg => ({
                pkg,
                range: declared[pkg]
            }))
        }
    })
}

function main(): void {
    const all = docsLookups()
    const rows = classify(all)

    const notDeclared = rows.filter(r => r.kind === 'not-declared')
    const nameMismatch = notDeclared.filter(r => r.named !== r.asked)
    const askedUnpinned = notDeclared.filter(r => {
        const own = r.chain[0].range
        return own !== undefined && isUnpinned(own)
    })
    const chainUnpinned = notDeclared.filter(r =>
        r.chain.some(c => c.range !== undefined && isUnpinned(c.range))
    )
    const correct = notDeclared.filter(
        r => r.named === r.asked && r.chain.every(c => c.range === undefined)
    )
    const declaredRangeFired = rows.filter(r => r.pin?.source === 'declared-range')

    // The `react` observation: the recorded version is the RESOLVED package's, so
    // it can disagree with what the project declares for the package asked about.
    const versionDisagrees = rows.filter(r => {
        const own = r.chain[0].range
        if (own === undefined || isUnpinned(own) || !r.version) return false
        try {
            return !Bun.semver.satisfies(r.version, own)
        } catch {
            return false
        }
    })

    console.log(corpusLine(all))
    console.log('\n=== BASE RATE')
    const line = (label: string, n: number): void =>
        console.log(`  ${label.padEnd(46)} ${String(n).padStart(4)}`)
    line('total_docs_lookups', rows.length)
    line('banner_none', rows.filter(r => r.kind === 'none').length)
    line('banner_declared_range', rows.filter(r => r.kind === 'declared-range').length)
    line('banner_not_declared', notDeclared.length)
    line('17A class — banner names a package not asked about', nameMismatch.length)
    line('17B class — asked name declared, but unpinned', askedUnpinned.length)
    line('17B class — chain has an unpinned declaration', chainUnpinned.length)
    line('not_declared_correct — leave these alone', correct.length)
    line('details.version outside the declared range', versionDisagrees.length)

    console.log('\n=== IS THE `declared-range` BRANCH REACHABLE?')
    console.log(
        `  lookups with pin.source === 'declared-range': ${declaredRangeFired.length}`
        + (declaredRangeFired.length === 0 ?
            '\n  ZERO across the corpus. The good branch of buildVersionBanner has never'
            + '\n  fired once in 120 lookups: its wording is a claim nobody has checked.'
        :   '')
    )

    console.log('\n=== THE 17A CLASS, BY (asked -> named)')
    const pairs = new Map<string, number>()
    for (const r of nameMismatch) {
        const k = `${r.asked} -> ${r.named}`
        pairs.set(k, (pairs.get(k) ?? 0) + 1)
    }
    for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
        const ex = nameMismatch.find(r => `${r.asked} -> ${r.named}` === k)!
        const decl = ex.chain
            .map(c => `${c.pkg}=${c.range ?? '(absent)'}`)
            .join(' ')
        console.log(`  x${String(n).padStart(3)}  ${k.padEnd(28)} declared at lookup time: ${decl}`)
    }

    console.log('\n=== details.version vs THE DECLARED RANGE OF THE PACKAGE ASKED ABOUT')
    for (const r of versionDisagrees) {
        console.log(
            `  ${r.asked} declared ${r.chain[0].range} — answer grounded in v${r.version}`
            + `  (banner: ${r.kind})`
        )
    }
    if (versionDisagrees.every(r => r.kind === 'none')) {
        console.log(
            '  every one of these carries NO banner (the package was already installed, so\n'
            + '  there is no pin and no sentence). This is the resolved package\'s version\n'
            + '  leaking into the header, not a banner defect — 17A/17B do not touch it.'
        )
    }

    console.log('\n=== THE 13 THAT ARE CORRECT AND MUST NOT MOVE')
    for (const r of correct) {
        console.log(
            `  ${new Date(r.at).toISOString()}  ${r.asked}@${r.version} `
            + `(nothing on ${r.chain.map(c => c.pkg).join('/')} declared then)`
        )
    }

    // Calibration against the hand count in nexttask17.md. A script that cannot
    // reproduce it is measuring something else.
    const expected: Array<[string, number, number]> = [
        ['total_docs_lookups', rows.length, 120],
        ['banner_none', rows.filter(r => r.kind === 'none').length, 72],
        ['banner_declared_range', rows.filter(r => r.kind === 'declared-range').length, 0],
        ['banner_not_declared', notDeclared.length, 48],
        ['17A class', nameMismatch.length, 35],
        ['not_declared_correct', correct.length, 13]
    ]
    const bad = expected.filter(([, got, want]) => got !== want)
    console.log('\n=== CALIBRATION vs the hand count')
    for (const [label, got, want] of expected) {
        console.log(`  ${label.padEnd(24)} got ${String(got).padStart(4)}  want ${want}`)
    }
    console.log(bad.length === 0 ? '  MATCHES' : `  MISMATCH in ${bad.length} counter(s)`)
    process.exitCode = bad.length === 0 ? 0 : 1
}

if (import.meta.main) main()
