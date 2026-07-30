/**
 * STEP 0 for nexttask 2 part B — how often does a real tree BUILD a server app and
 * never bind, and what did the gate's boot command do there?
 *
 * Measured BEFORE the checker is wired into the final gate, because a base rate
 * taken after wiring measures the lever, not the population. Per tree it records
 *
 *     (builds-an-app? , has-a-bind? , boot command discovered , boot outcome)
 *
 * and the headline number is the count of trees with `builds-an-app && !has-a-bind`.
 * The pre-registered reading, from the task: **if any tree other than mx5 fires, the
 * detector is too broad — fix the detector, do not excuse the hit.**
 *
 * Both boot-command columns are printed: `pre-2A` is the shipped-before rule (first
 * of `start`/`dev`, unconditionally — reimplemented here in three lines so this
 * script needs no git surgery) and `now` is the working tree's, which rejects
 * non-launch scripts. Seeing both is the point: run 18's boot command was discovered
 * and then skipped, which is how a project with no listener at all reached a green
 * gate.
 *
 * BOOT OUTCOMES ARE MEASURED, in a throwaway CoW clone, with `docker`/`docker-compose`
 * shimmed to exit 127 so an orchestration script reproduces run 18's sandbox instead
 * of starting real containers on this box (same disclosure as
 * scripts/boot-skip-corpus.ts). The corpus is never written to. Trees with no boot
 * command are not cloned at all.
 *
 * Corpus: pi-task, both run-18 mx5 revisions, and every sibling checkout under ~/hub
 * that carries a package.json — so it widens with the box.
 *
 * Run: bun run scripts/serve-entry-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readdirSync, readFileSync, rmSync} from 'node:fs'
import * as path from 'node:path'
import {
    detectsServedApp,
    discoverBootCommand,
    preferredDeclaredPort,
    runBootCheck
} from '../src/task/final-gate.js'
import type {HealthCommand} from '../src/task/repo-health-check.js'
import {scanServeEntry, findMissingServeEntry, serveEntryGateFailureText} from '../src/task/serve-entry.js'
import {HUB, REPO, installDockerlessShim, makeWorkRoot} from './boot-skip-corpus.js'

/** The rule as shipped before part A: first of `start`/`dev`, whatever its body. */
function preLeverBootCommand(dir: string): HealthCommand | null {
    try {
        const j = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }
        const s = j.scripts ?? {}
        for (const name of ['start', 'dev']) if (s[name]) return ['bun', ['run', name]]
    } catch {
        // no manifest → nothing to boot
    }
    return null
}

const label = (c: HealthCommand | null): string => (c ? `${c[0]} ${c[1].join(' ')}` : 'none')

interface Row {
    label: string
    dir: string
    /** A specific revision to check the clone out at (mx5's two run-18 commits). */
    commit?: string
    buildsApp: boolean
    hasBind: boolean
    bindWhat: string
    expectation: string
    launcher: string | null
    appFiles: string[]
    preBoot: string
    nowBoot: string
    bootOutcome: string
    finding: string | null
}

const work = makeWorkRoot('serve-entry-baserate')
installDockerlessShim(work)

function clone(src: string, dest: string, commit?: string): string {
    rmSync(dest, {recursive: true, force: true})
    const cp = spawnSync('cp', ['-a', '--reflink=auto', src, dest], {encoding: 'utf8'})
    if (cp.status !== 0) throw new Error(`cp failed for ${src}: ${cp.stderr}`)
    if (commit) {
        const co = spawnSync(
            'git',
            ['-c', 'advice.detachedHead=false', 'checkout', '--force', commit],
            {cwd: dest, encoding: 'utf8'}
        )
        if (co.status !== 0) throw new Error(`checkout ${commit} failed: ${co.stderr}`)
    }
    return dest
}

async function measure(name: string, dir: string, commit?: string): Promise<Row> {
    // A pinned revision has to be materialised before ANY question is asked of it.
    const readDir =
        commit ? clone(dir, path.join(work, `${name.replace(/\W+/g, '_')}.read`), commit) : dir
    const scan = scanServeEntry(readDir)
    const finding = findMissingServeEntry(readDir)
    const pre = preLeverBootCommand(readDir)
    const now = discoverBootCommand(readDir)
    let bootOutcome: string
    if (pre) {
        const bootDir = clone(readDir, path.join(work, `${name.replace(/\W+/g, '_')}.boot`))
        try {
            const r = await runBootCheck(bootDir, pre, 8_000, {
                expectServer: detectsServedApp(bootDir),
                deps: {preferredPort: () => preferredDeclaredPort(bootDir)}
            })
            bootOutcome = r.outcome
        } finally {
            rmSync(bootDir, {recursive: true, force: true})
        }
    } else {
        bootOutcome = 'none discovered'
    }
    const row: Row = {
        label: name,
        dir,
        commit,
        buildsApp: scan.apps.length > 0,
        hasBind: scan.bind !== null,
        bindWhat: scan.bind ? `${scan.bind.what} in ${scan.bind.file}` : '—',
        expectation: scan.expectation ? `${scan.expectation.what} (${scan.expectation.source})` : '—',
        launcher: scan.launcher,
        appFiles: [...new Set(scan.apps.map(a => a.file))],
        preBoot: label(pre),
        nowBoot: label(now),
        bootOutcome,
        finding: finding ? serveEntryGateFailureText(finding) : null
    }
    if (commit) rmSync(readDir, {recursive: true, force: true})
    return row
}

const rows: Row[] = []
try {
    const targets: Array<{name: string; dir: string; commit?: string}> = [
        {name: 'pi-task (self)', dir: REPO}
    ]
    if (existsSync(path.join(HUB, 'mx5'))) {
        targets.push(
            {name: 'mx5@a9c6145 (run 18 HEAD)', dir: path.join(HUB, 'mx5'), commit: 'a9c6145'},
            {name: 'mx5@4880e79 (run 18 pre-autofix)', dir: path.join(HUB, 'mx5'), commit: '4880e79'}
        )
    }
    if (existsSync(HUB)) {
        for (const name of readdirSync(HUB).sort()) {
            const dir = path.join(HUB, name)
            if (name === 'mx5') continue // covered by the two pinned revisions above
            if (existsSync(path.join(dir, 'package.json'))) targets.push({name, dir})
        }
    }

    for (const t of targets) {
        console.log(`\n=== ${t.name}`)
        const row = await measure(t.name, t.dir, t.commit)
        rows.push(row)
        console.log(`  builds-an-app: ${row.buildsApp}${row.appFiles.length > 0 ? ` (${row.appFiles.slice(0, 4).join(', ')}${row.appFiles.length > 4 ? ', …' : ''})` : ''}`)
        console.log(`  has-a-bind:    ${row.hasBind}  ${row.bindWhat}`)
        console.log(`  expects serve: ${row.expectation}`)
        console.log(`  launcher:      ${row.launcher ?? '—'}`)
        console.log(`  boot pre-2A:   ${row.preBoot} → ${row.bootOutcome}`)
        console.log(`  boot now:      ${row.nowBoot}`)
        if (row.finding) console.log(`  FINDING: ${row.finding}`)
    }

    console.log('\n\nbuilds-app | bind | boot pre-2A → outcome | boot now | tree')
    for (const r of rows) {
        console.log(
            `  ${(r.buildsApp ? 'Y' : 'N').padEnd(10)} ${(r.hasBind ? 'Y' : 'N').padEnd(4)} `
                + `${`${r.preBoot} → ${r.bootOutcome}`.padEnd(22)} ${r.nowBoot.padEnd(13)} ${r.label}`
        )
    }

    const fired = rows.filter(r => r.buildsApp && !r.hasBind && r.finding !== null)
    const buildsNoBind = rows.filter(r => r.buildsApp && !r.hasBind)
    console.log(`\nBASE RATE: builds-an-app && !has-a-bind — ${buildsNoBind.length}/${rows.length} tree(s)`)
    for (const r of buildsNoBind) console.log(`  - ${r.label}${r.launcher ? `  (stood down: ${r.launcher})` : ''}`)
    console.log(`FINDINGS (all three conditions): ${fired.length}/${rows.length}`)
    for (const r of fired) console.log(`  - ${r.label}`)
    const offTarget = fired.filter(r => !r.label.startsWith('mx5'))
    if (offTarget.length > 0) {
        console.log(
            `\nDETECTOR TOO BROAD — ${offTarget.length} non-mx5 tree(s) fired: `
                + offTarget.map(r => r.label).join(', ')
                + '\nFix the detector; do not excuse the hit.'
        )
    }
    process.exitCode = offTarget.length === 0 ? 0 : 1
} finally {
    rmSync(work, {recursive: true, force: true})
}
