/**
 * STEP 0 for nexttask 3 — the BASE RATE of HTML asset references that live in a
 * source string literal and get written into a build output, measured per tree
 * BEFORE the lever is judged.
 *
 * Methodology rule this satisfies: measure the base rate first
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md). A pattern wired
 * without one cannot distinguish "removed the bad shape" from "the shape was
 * never there" — and, just as importantly here, it cannot tell a NEW true
 * positive from a new false positive.
 *
 * Per tree it reports every generated-HTML asset reference and how it resolves:
 *
 *     produced   the production build emits it (or it is already on disk)
 *     dev-only   ONLY a watch/dev script produces it  ← dangling by construction
 *     missing    nothing produces it anywhere
 *
 * Pre-registered expectations (nexttask 3):
 *
 *     mx5 @ a9c6145   2 refs — /main.js produced, /app.css dev-only  ⇒ 1 dangling
 *     mx5 @ 407e542   0 (no build.ts)
 *     aiz-client      record
 *     aiz-server, gofer, pi-task   0
 *
 * If the pattern fires on a tree with a legitimate hand-written index.html, the
 * RESOLUTION RULE is wrong — fix it, do not allowlist.
 *
 * Nothing is mutated: the mx5 states are `git archive` exports (see
 * scripts/html-asset-closure-corpus.ts), the rest are scanned in place read-only.
 *
 * Run: bun run scripts/html-asset-closure-baserate.ts
 */
import {existsSync} from 'node:fs'
import * as path from 'node:path'
import {
    classifyGeneratedHtmlRef,
    collectGeneratedHtmlRefs,
    type GeneratedHtmlRefClass
} from '../src/task/artifact-closure.js'
import {buildCorpus} from './html-asset-closure-corpus.js'

interface Row {
    label: string
    expectation: string
    available: boolean
    refs: Array<{path: string; referencer: string; construct: string; cls: GeneratedHtmlRefClass}>
}

const rows: Row[] = []

for (const tree of buildCorpus()) {
    if (tree.dir === null) {
        rows.push({label: tree.label, expectation: tree.expectation, available: false, refs: []})
        console.log(`\n${tree.label}: UNAVAILABLE`)
        continue
    }
    const t0 = Date.now()
    const {refs, full, production} = collectGeneratedHtmlRefs(tree.dir)
    const exists = (rel: string): boolean => existsSync(path.join(tree.dir as string, rel))
    const classified = refs.map(r => ({
        path: r.path,
        referencer: r.referencer,
        construct: r.construct,
        cls: classifyGeneratedHtmlRef(r, full, production, exists)
    }))
    rows.push({
        label: tree.label,
        expectation: tree.expectation,
        available: true,
        refs: classified
    })
    console.log(`\n${tree.label} (${Date.now() - t0}ms) — expect: ${tree.expectation}`)
    console.log(`  build outdirs: ${[...production.outdirs].sort().join(', ') || '(none)'}`)
    if (classified.length === 0) console.log('  0 generated-HTML asset refs')
    for (const r of classified) {
        console.log(`  [${r.cls.padEnd(8)}] ${r.path}  ← ${r.referencer} (${r.construct})`)
    }
}

const total = rows.reduce((n, r) => n + r.refs.length, 0)
const byClass = (c: GeneratedHtmlRefClass): number =>
    rows.reduce((n, r) => n + r.refs.filter(x => x.cls === c).length, 0)

console.log('\n=== BASE RATE (generated-HTML asset references) ===')
console.log(`  trees scanned:  ${rows.filter(r => r.available).length}/${rows.length}`)
console.log(`  refs total:     ${total}`)
console.log(`  produced:       ${byClass('produced')}`)
console.log(`  dev-only:       ${byClass('dev-only')}   <- dangling for a production build`)
console.log(`  missing:        ${byClass('missing')}    <- dangling`)
console.log('\nper tree:')
for (const r of rows) {
    const d = r.refs.filter(x => x.cls !== 'produced').length
    console.log(
        `  ${r.label.padEnd(42)} ${r.available ? `${r.refs.length} ref(s), ${d} dangling` : 'UNAVAILABLE'}`
    )
}
