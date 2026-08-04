/**
 * Zero-FP suite for the owned-requirement/category-freeze detector (nexttask 7)
 * — run BEFORE wiring, and any time the patterns change.
 *
 * The discipline is `frozen-conflict`'s ("FP-swept over the 26 real mx5 run-12
 * specs") and `dangling-artifact-fp-suite.ts`'s: a detector whose finding is
 * FORCED into the critique rewrite spends model time on every fire, so a false
 * positive is not a nuisance, it is a spec the model is ordered to damage.
 *
 *   arm 1  every recorded composed spec on this box — mx5 run 18 (24), the
 *          independent gofer-pixel run (21), IAR1 (10), runner (2), aiz-client
 *          (1). Expected finding set: exactly ONE, mx5 TASK_0023's server
 *          clause, which STEP 0 (scripts/owned-vs-freeze-baserate.ts) shows was
 *          not met at HEAD. Anything else is a false positive to fix here.
 *   arm 2  the four hand-built negatives nexttask 7 names, each a spec that
 *          carries BOTH sides of the shape and is nonetheless satisfiable.
 *   arm 3  positive controls — the same specs with the satisfiability removed.
 *          Without them, arm 1 + arm 2 also pass with a detector that never
 *          fires at all.
 *
 * Ground truth is recorded spec text plus hand-built fixtures. No model.
 *
 * Run: bun run scripts/owned-freeze-conflict-fp-suite.ts
 *   PASS 0 · FAIL 1 · ABSTAIN 2 (spec corpus unavailable)
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import {findOwnedFreezeConflicts, trackedSourceOracle} from '../src/task/owned-freeze-conflict.js'
import {parseOwnedRequirements, ownedForTitle} from '../src/task/requirements.js'

const HUB = path.join(os.homedir(), 'hub')
const POOLS = ['mx5', 'gofer-pixel', 'IAR1', 'runner', 'aiz-client']

/** The one pair the corpus is known to contain (STEP 0, hand-checked). */
const EXPECTED = ['mx5/TASK_0023 src/server/index.ts']

let failures = 0

function section(doc: string, name: string): string {
    const re = new RegExp(String.raw`^##\s+${name}\s*$`, 'im')
    const m = re.exec(doc)
    if (!m) return ''
    const rest = doc.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

function sourceOracle(dir: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd: dir, encoding: 'utf8'})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

// ── arm 1: the real corpus ────────────────────────────────────────────────────
const found: string[] = []
let scanned = 0
for (const pool of POOLS) {
    const dir = path.join(HUB, pool)
    const tasks = path.join(dir, '.pi-tasks')
    if (!existsSync(tasks)) continue
    const ledgerFile = path.join(tasks, 'requirements-owned.md')
    const ledger =
        existsSync(ledgerFile) ? parseOwnedRequirements(readFileSync(ledgerFile, 'utf8')) : []
    const isSource = sourceOracle(dir)
    for (const file of readdirSync(tasks).filter(f => /^TASK_\d+\.md$/.test(f)).sort()) {
        const doc = readFileSync(path.join(tasks, file), 'utf8')
        const spec = section(doc, 'spec')
        if (spec.length === 0) continue
        scanned++
        const owned = ownedForTitle(ledger, section(doc, 'raw prompt'))
        for (const c of findOwnedFreezeConflicts(spec, {owned, isSource})) {
            for (const p of c.paths) found.push(`${pool}/${file.replace(/\.md$/, '')} ${p}`)
        }
    }
}

if (scanned === 0) {
    console.log('ABSTAIN: no recorded composed specs on this box')
    process.exit(2)
}

const sortedFound = [...found].sort()
const arm1ok = JSON.stringify(sortedFound) === JSON.stringify([...EXPECTED].sort())
console.log(`arm 1 — ${scanned} real specs: ${found.length} finding(s) — ${arm1ok ? 'OK' : 'MISMATCH'}`)
for (const f of sortedFound) console.log(`  - ${f}`)
if (!arm1ok) {
    console.log(`  expected: ${JSON.stringify(EXPECTED)}`)
    failures++
}

// ── arm 2: hand-built negatives ───────────────────────────────────────────────
/**
 * Each negative carries BOTH sides — an owned requirement and a freeze — and is
 * satisfiable anyway. `alwaysSource` stands in for the git oracle so the
 * fixtures do not need a repo on disk.
 */
const alwaysSource = (): boolean => true

interface Fixture {
    name: string
    spec: string
}

const NEGATIVES: Fixture[] = [
    {
        name: 'scoped freeze — the resolution shape must never re-fire',
        spec: `GOAL
  Register the component test config.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - You MAY edit \`src/server/index.ts\` ONLY as far as the owned requirement requires; do not modify any other source file outside \`package.json\` and \`src/server/index.ts\`.
ACCEPTANCE
  - The server serves the built client bundle from \`dist/\`.`
    },
    {
        name: 'owned path is OUTSIDE the freeze category (exempted by name)',
        spec: `GOAL
  Build the canvas component.
CONSTRAINTS
  - "\`Canvas.tsx\` — HTML5 Canvas element with mouse event handlers" [13. Plan] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do NOT modify any existing file outside \`src/components/Canvas.tsx\` — all files under \`src/engine/\` remain untouched.
ACCEPTANCE
  - \`src/components/Canvas.tsx\` exists and exports a default React component.`
    },
    {
        name: 'category freeze with NO owned requirement at all',
        spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - Do not modify \`build.ts\`, \`tsconfig.json\`, or any source files outside of \`package.json\`.
  - The server watch command must match the contract exactly: \`bun run --watch src/server/index.ts\`.
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
    },
    {
        name: 'owned requirement is itself prohibition-shaped',
        spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - "Never edit \`src/server/index.ts\` by hand — it is generated." [3. Repo layout] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`build.ts\` or any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev\` script.`
    },
    {
        name: 'creation ban, not a modification category freeze',
        spec: `GOAL
  Seed the admin account.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not create any files other than \`src/server/seed.ts\` and do not modify \`tsconfig.json\` or \`eslint.config.js\`.
ACCEPTANCE
  - \`src/server/seed.ts\` creates the admin.`
    },
    {
        name: 'owned requirement names its file only as a command argument',
        spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - "**Client CSS:** \`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css\`" [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`build.ts\` or any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev:css\` script.`
    }
]

console.log(`\narm 2 — ${NEGATIVES.length} negatives, expect ZERO findings each`)
for (const f of NEGATIVES) {
    const hits = findOwnedFreezeConflicts(f.spec, {isSource: alwaysSource})
    const ok = hits.length === 0
    console.log(`  ${ok ? 'OK  ' : 'FIRE'} ${f.name}`)
    if (!ok) {
        for (const h of hits) console.log(`       -> ${h.paths.join(', ')} | ${h.constraint.slice(0, 90)}`)
        failures++
    }
}

// ── arm 3: positive controls ──────────────────────────────────────────────────
const POSITIVES: Fixture[] = [
    {
        name: 'run 18 TASK_0023, reduced to the pair',
        spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`docker-compose.dev.yml\`, \`build.ts\`, or any source files outside of \`package.json\`.
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
    },
    {
        name: 'passive ACCEPTANCE freeze alone (no CONSTRAINTS freeze)',
        spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
    },
    {
        name: 'unstamped owned quote, recovered from the run ledger',
        spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - The server must satisfy "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`."
  - Do not modify any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev\` script.`
    }
]

const LEDGER = parseOwnedRequirements(
    'OWNED: "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`." '
        + '[anchor: 9. Build & run] [title: Wire dev build pipeline]'
)

console.log(`\narm 3 — ${POSITIVES.length} positive controls, expect a finding on each`)
for (const f of POSITIVES) {
    const hits = findOwnedFreezeConflicts(f.spec, {owned: LEDGER, isSource: alwaysSource})
    const ok = hits.length === 1 && hits[0].paths.includes('src/server/index.ts')
    console.log(`  ${ok ? 'OK  ' : 'MISS'} ${f.name} (${hits.length} finding(s))`)
    if (!ok) failures++
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
