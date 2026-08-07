/**
 * STEP 0 for nexttask 16B — what would the final gate actually EXECUTE off a launch
 * contract, and is any of it OUTWARD-FACING?
 *
 * The hazard: `runnableDeclaredScripts` filters on ONE regex —
 * `/^(?:dev|start|serve|preview|watch)(?:[:_-].*)?$/i` — and everything else the
 * design declared is spawned by final-gate.ts with a 180s timeout. In run 20 that
 * meant `bun run seed` against a live Postgres. The same line would run a declared
 * `deploy`, `publish`, `release`, `db:reset` or `docker:push`.
 *
 * Nothing was ever observed to go wrong. This script is the count that decides
 * whether 16B ships a refusal rule or is closed with a number.
 *
 * READ-ONLY. Nothing here spawns a child, writes a file, or touches a work tree —
 * it reads manifests and design docs and asks the REAL predicates
 * (`enumerateScriptCandidates`, `keepGroundedScripts`, `runnableDeclaredScripts`,
 * `discoverIntegrationCommands`, `readLaunchManifest`) what they would have said.
 *
 * CLASSIFICATION IS BY RESOLVED BODY, NEVER BY NAME (nexttask 3: the shrink guard
 * compared NAMES and missed a body rewrite). A script called `deploy` that only runs
 * `tsc` is local; a script called `build` that runs `docker push` is not. Bodies are
 * resolved through the tree's own manifest — npm `scripts`, else Makefile recipes —
 * and `bun run X` / `make X` chain members are expanded one hop, so a wrapper cannot
 * hide the verb.
 *
 * DEDUPLICATION IS THE POINT, not a detail (the nexttask-15D lesson: 33 trees, 32 of
 * them one A/B's delivery copies of a single spec). Raw file counts are reported, but
 * every rate is quoted over DISTINCT contracts and DISTINCT project shapes.
 *
 *     bun run scripts/launch-script-exec-baserate.ts
 */
import {createHash} from 'node:crypto'
import {readFileSync, readdirSync, statSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    enumerateScriptCandidates,
    keepGroundedScripts,
    runnableDeclaredScripts
} from '../src/task/launch-contract.js'
import {readLaunchManifest} from '../src/task/launch-manifest.js'
import {discoverIntegrationCommands} from '../src/task/final-gate.js'
import {splitChainMembers, makefileRecipe} from '../src/task/command-shrink.js'

const HOME = os.homedir()
/** Every root a run has ever written a work tree into on this box. */
const ROOTS = ['hub', 'tmp', '.cache', '.pi', path.join('.local', 'share')].map(r => path.join(HOME, r))
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor'])

// ── corpus discovery ──────────────────────────────────────────────────────────

function walk(dir: string, depth: number, onFile: (p: string) => void): void {
    if (depth < 0) return
    let entries: string[]
    try {
        entries = readdirSync(dir)
    } catch {
        return
    }
    for (const e of entries) {
        if (SKIP_DIRS.has(e)) continue
        const p = path.join(dir, e)
        let st
        try {
            st = statSync(p)
        } catch {
            continue
        }
        if (st.isDirectory()) walk(p, depth - 1, onFile)
        else onFile(p)
    }
}

const sha = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12)

/** Every recorded launch contract on the box, with the tree that owns it. */
function findContracts(): Array<{tree: string; file: string}> {
    const out: Array<{tree: string; file: string}> = []
    for (const root of ROOTS) {
        walk(root, 7, p => {
            if (path.basename(p) !== 'launch-contract.md') return
            if (path.basename(path.dirname(p)) !== '.pi-tasks') return
            out.push({tree: path.dirname(path.dirname(p)), file: p})
        })
    }
    return out
}

/**
 * Documents a run could have extracted a contract FROM: every design doc under a
 * `DESIGN/` directory, plus the markdown at each tree's root (the shape a run is
 * handed as a spec). These are a hypothetical corpus — the model still filters and
 * the host still grounds — so what they produce is an UPPER BOUND on what could ever
 * be declared, which is exactly what a hazard count wants.
 */
function findSpecDocs(): string[] {
    const out: string[] = []
    for (const root of ROOTS) {
        walk(root, 7, p => {
            if (!p.endsWith('.md')) return
            const parts = p.split(path.sep)
            const inDesign = parts.includes('DESIGN')
            const atTreeRoot = ROOTS.some(r => path.dirname(path.dirname(p)) === r)
            if (inDesign || atTreeRoot) out.push(p)
        })
    }
    return out
}

// ── body resolution ───────────────────────────────────────────────────────────

function scriptBody(tree: string, name: string): string | null {
    const m = readLaunchManifest(tree)
    if (m.kind === 'npm') {
        try {
            const j = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8')) as {
                scripts?: Record<string, string>
            }
            return j.scripts?.[name] ?? null
        } catch {
            return null
        }
    }
    if (m.kind === 'make') {
        try {
            return makefileRecipe(readFileSync(path.join(tree, m.file), 'utf8'), name)
        } catch {
            return null
        }
    }
    return null
}

/** `bun run X`, `npm run X`, `yarn X`, `make X` → X's own body, one hop deep. */
const RUN_HOP_RE = /^(?:(?:bun|npm|pnpm|yarn|deno)\s+(?:run\s+|run-script\s+)?|make\s+)([a-z0-9][a-z0-9:_-]*)\s*$/i

function resolvedBody(tree: string, name: string, depth = 0): string | null {
    const body = scriptBody(tree, name)
    if (body === null || depth >= 2) return body
    const parts: string[] = []
    for (const member of splitChainMembers(body)) {
        const hop = RUN_HOP_RE.exec(member.replace(/^[A-Z_][A-Z0-9_]*=\S*\s+/g, ''))
        const inner = hop ? resolvedBody(tree, hop[1], depth + 1) : null
        parts.push(inner === null ? member : `${member} ;; ${inner}`)
    }
    return parts.join(' && ')
}

// ── classification, by BODY ───────────────────────────────────────────────────

/** Verbs that leave this machine, or publish something the world can see. */
const OUTWARD_RE: RegExp[] = [
    /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
    /\bsemantic-release\b/i,
    /\bcargo\s+publish\b/i,
    /\btwine\s+upload\b/i,
    /\b(?:mvn|gradlew?)\s+\S*\b(?:publish|deploy)\b/i,
    /\bdocker\s+(?:image\s+)?push\b/i,
    /\bdocker\s+buildx\s+build\b[^;]*--push\b/i,
    /\bgit\s+push\b/i,
    /\bgh\s+release\b/i,
    /\bgh-pages\b/i,
    /\b(?:netlify|vercel|firebase|fly|flyctl|wrangler|surge|amplify|serverless|sls)\b[^;]*\b(?:deploy|publish|--prod)\b/i,
    /\baws\s+(?:s3|cloudfront|ecs|lambda|elasticbeanstalk|amplify)\b/i,
    /\bgcloud\b[^;]*\bdeploy\b/i,
    /\bgsutil\b/i,
    /\bkubectl\s+(?:apply|rollout|set|delete)\b/i,
    /\bhelm\s+(?:install|upgrade)\b/i,
    /\bterraform\s+apply\b/i,
    /\bansible-playbook\b/i,
    /\bsentry-cli\b[^;]*\breleases?\b/i,
    /\b(?:rsync|scp)\b[^;]*\s\S+@?\S+:\S/i,
    /\bcurl\b[^;]*(?:-X\s*(?:POST|PUT|PATCH|DELETE)|--data|\s-d\s)/i
]

/** Verbs that change durable state on this box (a database, the tree, a volume). */
const STATE_RE: RegExp[] = [
    /\bprisma\s+(?:migrate|db\s+push)\b/i,
    /\bknex\s+migrate\b/i,
    /\bsequelize\b[^;]*\bdb:(?:migrate|seed)\b/i,
    /\bdrizzle-kit\s+(?:push|migrate)\b/i,
    /\balembic\s+(?:upgrade|downgrade)\b/i,
    /\brails\s+db:/i,
    /\bmanage\.py\s+(?:migrate|loaddata|flush)\b/i,
    /\b(?:psql|mysql|sqlite3|mongosh?|redis-cli)\b/i,
    /\bdocker(?:\s+compose|-compose)\b[^;]*\bdown\b[^;]*(?:-v|--volumes)\b/i,
    /\brm\s+-[a-z]*r[a-z]*f?\b/i,
    /(?:^|[\s/])(?:migrate|migration|seed|reset|truncate|drop|teardown)[\w.-]*\.(?:ts|tsx|js|mjs|cjs|py|rb|sh|sql)\b/i
]

type ScriptClass = 'outward-facing' | 'state-mutating' | 'local-only' | 'no-body'

function classify(body: string | null): ScriptClass {
    if (body === null) return 'no-body'
    for (const re of OUTWARD_RE) if (re.test(body)) return 'outward-facing'
    for (const re of STATE_RE) if (re.test(body)) return 'state-mutating'
    return 'local-only'
}

/** The gate's own `covered` set: the `bun run X` integration commands it discovers. */
function coveredScripts(tree: string): string[] {
    try {
        return discoverIntegrationCommands(tree).cmds.flatMap(([bin, args]) =>
            (bin === 'bun' || bin === 'npm') && args[0] === 'run' && args[1] ? [args[1]] : []
        )
    } catch {
        return []
    }
}

function declaredFrom(file: string): string[] {
    const raw = readFileSync(file, 'utf8')
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const n = line.trim()
        if (n.length === 0 || !/^[a-z0-9][a-z0-9:_-]{0,39}$/i.test(n)) continue
        if (seen.has(n.toLowerCase())) continue
        seen.add(n.toLowerCase())
        out.push(n)
    }
    return out
}

// ── report ────────────────────────────────────────────────────────────────────

interface Row {
    label: string
    tree: string
    declared: string[]
    /** non-boot, non-covered — what runnableDeclaredScripts hands to the executor. */
    runnable: string[]
    /** …of those, the ones the manifest actually exposes, so the gate spawns them. */
    executed: Array<{name: string; cls: ScriptClass; body: string}>
}

function rowFor(label: string, tree: string, declared: string[]): Row {
    const covered = coveredScripts(tree)
    const runnable = runnableDeclaredScripts(declared, covered)
    const manifest = readLaunchManifest(tree)
    const present = new Set(manifest.names.map(n => n.toLowerCase()))
    const executed = runnable
        .filter(n => present.has(n.toLowerCase()))
        .map(n => {
            const body = resolvedBody(tree, n)
            return {name: n, cls: classify(body), body: body ?? '(unresolved)'}
        })
    return {label, tree, declared, runnable, executed}
}

function tally(rows: Row[]): Record<ScriptClass, number> {
    const t: Record<ScriptClass, number> = {
        'outward-facing': 0,
        'state-mutating': 0,
        'local-only': 0,
        'no-body': 0
    }
    for (const r of rows) for (const e of r.executed) t[e.cls] += 1
    return t
}

/**
 * A ZERO COUNT IS ONLY EVIDENCE IF THE DETECTOR WORKS. Every one of these bodies is
 * a shape a real project ships; if any of them stops classifying, the "0
 * outward-facing" verdict below is a broken classifier, not a fact about the corpus,
 * and the script says so instead of reporting a triumphant zero.
 */
const CONTROLS: Array<[string, ScriptClass]> = [
    ['npm publish --access public', 'outward-facing'],
    ['bun run build && docker push registry.example.com/app:latest', 'outward-facing'],
    ['gh release create v1.0.0 dist/*.tgz', 'outward-facing'],
    ['wrangler deploy --env production', 'outward-facing'],
    ['aws s3 sync dist/ s3://my-bucket --delete', 'outward-facing'],
    ['kubectl apply -f k8s/', 'outward-facing'],
    ['git push --follow-tags origin main', 'outward-facing'],
    ['prisma migrate deploy', 'state-mutating'],
    ['bun run src/server/seed.ts', 'state-mutating'],
    ['psql $DATABASE_URL -f schema.sql', 'state-mutating'],
    ['tsc -p tsconfig.build.json', 'local-only'],
    ['eslint --fix . && prettier --write .', 'local-only'],
    ['vitest run --coverage', 'local-only'],
    // The nexttask-3 lesson, both directions: the NAME never decides.
    ['echo "deploy: nothing to do" && tsc --noEmit', 'local-only'],
    ['bun build ./src --outdir dist && npm publish', 'outward-facing']
]

function selfCheck(): boolean {
    let ok = true
    for (const [body, want] of CONTROLS) {
        const got = classify(body)
        if (got === want) continue
        ok = false
        console.log(`  CLASSIFIER CONTROL FAILED: want ${want}, got ${got} — ${body}`)
    }
    console.log(`  classifier self-check: ${ok ? 'ok' : 'BROKEN'} (${CONTROLS.length} controls)`)
    return ok
}

/** Every script in a manifest, so the hazard's whole population can be counted. */
function manifestScripts(tree: string): Record<string, string> {
    try {
        const j = JSON.parse(readFileSync(path.join(tree, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }
        return j.scripts ?? {}
    } catch {
        return {}
    }
}

function main(): void {
    console.log('# nexttask 16B STEP 3 — what the gate would EXECUTE off a launch contract')
    console.log(`roots: ${ROOTS.join('  ')}`)
    console.log('')
    const detectorOk = selfCheck()

    // ── A. the contracts runs actually recorded ──────────────────────────────
    const contracts = findContracts()
    const byContent = new Map<string, Array<{tree: string; file: string}>>()
    for (const c of contracts) {
        const key = sha(declaredFrom(c.file).join(','))
        const list = byContent.get(key) ?? []
        list.push(c)
        byContent.set(key, list)
    }
    // A "project shape" is the contract PLUS the manifest it is diffed against:
    // 600 copies of one tree are one shape, not 600.
    const byShape = new Map<string, {tree: string; file: string; copies: number}>()
    for (const c of contracts) {
        const m = readLaunchManifest(c.tree)
        const key = sha(`${declaredFrom(c.file).join(',')}|${m.kind}|${m.names.slice().sort().join(',')}`)
        const seen = byShape.get(key)
        if (seen) seen.copies += 1
        else byShape.set(key, {...c, copies: 1})
    }
    console.log('')
    console.log('## A. RECORDED contracts')
    console.log(`  launch-contract.md files            ${contracts.length}`)
    console.log(`  DISTINCT declared-script lists      ${byContent.size}`)
    console.log(`  DISTINCT project shapes (contract + manifest)  ${byShape.size}`)
    for (const [, list] of byContent) {
        console.log(`    [${list.length}x] ${declaredFrom(list[0].file).join(', ')}`)
    }

    const recorded: Row[] = []
    for (const [, s] of byShape) {
        recorded.push(rowFor(`${path.relative(HOME, s.tree)} (x${s.copies})`, s.tree, declaredFrom(s.file)))
    }
    for (const r of recorded) {
        console.log('')
        console.log(`  ${r.label}`)
        console.log(`    declared      ${r.declared.join(', ')}`)
        console.log(`    would_execute ${r.runnable.join(', ') || '(none)'}   [non-boot, non-covered]`)
        for (const e of r.executed) {
            console.log(`      ${e.cls.padEnd(15)} ${e.name}  ←  ${e.body.slice(0, 110)}`)
        }
        const absent = r.runnable.filter(n => !r.executed.some(e => e.name === n))
        if (absent.length > 0) {
            console.log(`      (not in the manifest, so never spawned: ${absent.join(', ')})`)
        }
    }

    // ── B. what any spec doc on this box COULD declare ───────────────────────
    const docs = findSpecDocs()
    const seenDoc = new Set<string>()
    const hypothetical: Row[] = []
    let docsWithCandidates = 0
    for (const d of docs) {
        let text: string
        try {
            text = readFileSync(d, 'utf8')
        } catch {
            continue
        }
        const key = sha(text)
        if (seenDoc.has(key)) continue
        seenDoc.add(key)
        const declared = keepGroundedScripts(enumerateScriptCandidates(text), text)
        if (declared.length === 0) continue
        docsWithCandidates += 1
        // The tree the doc lives in is the manifest a run against it would diff.
        const tree = d.includes(`${path.sep}DESIGN${path.sep}`) ? path.dirname(path.dirname(d)) : path.dirname(d)
        hypothetical.push(rowFor(path.relative(HOME, d), tree, declared))
    }
    console.log('')
    console.log('## B. HYPOTHETICAL contracts — every distinct spec/design doc on this box')
    console.log(`  .md files scanned                   ${docs.length}`)
    console.log(`  DISTINCT by content                 ${seenDoc.size}`)
    console.log(`  yielding >= 1 grounded candidate    ${docsWithCandidates}`)
    const withExec = hypothetical.filter(r => r.executed.length > 0)
    console.log(`  …of those, with something the gate would SPAWN   ${withExec.length}`)
    for (const r of withExec) {
        console.log('')
        console.log(`  ${r.label}`)
        for (const e of r.executed) {
            console.log(`      ${e.cls.padEnd(15)} ${e.name}  ←  ${e.body.slice(0, 110)}`)
        }
    }

    // ── B2. the whole population the hazard could ever draw from ─────────────
    // Not "what a contract declared" but "what any manifest on this box exposes":
    // if no project here ships an outward-facing script at all, then the zero in
    // section C is a fact about the corpus, not about the extractor.
    const manifestSeen = new Set<string>()
    const pop = {
        project: {manifests: 0, scripts: 0, outward: 0, state: 0, local: 0, examples: [] as string[]},
        vendored: {manifests: 0, scripts: 0, outward: 0, state: 0, local: 0, examples: [] as string[]}
    }
    /** A published package someone else wrote (a dependency, or a trashed copy of
     *  one) — not a project any run could ever have authored a contract for. Kept
     *  and reported separately because it is the only place on this box where a
     *  publish/deploy verb actually occurs: proof the detector fires on real bodies. */
    const isVendored = (p: string): boolean => /(?:^|\/)(?:node_modules[^/]*|Trash)(?:\/|$)/.test(p)
    for (const root of ROOTS) {
        walk(root, 5, p => {
            if (path.basename(p) !== 'package.json') return
            const tree = path.dirname(p)
            const scripts = manifestScripts(tree)
            if (Object.keys(scripts).length === 0) return
            const key = sha(JSON.stringify(scripts))
            if (manifestSeen.has(key)) return
            manifestSeen.add(key)
            const bin = isVendored(p) ? pop.vendored : pop.project
            bin.manifests += 1
            for (const [name, body] of Object.entries(scripts)) {
                bin.scripts += 1
                const cls = classify(resolvedBody(tree, name) ?? body)
                if (cls === 'outward-facing') bin.outward += 1
                else if (cls === 'state-mutating') bin.state += 1
                else bin.local += 1
                if (cls === 'outward-facing' && bin.examples.length < 10) {
                    bin.examples.push(`${path.relative(HOME, tree)}  ${name} ← ${body.slice(0, 88)}`)
                }
            }
        })
    }
    console.log('')
    console.log('## B2. POPULATION — every DISTINCT manifest on this box, every script in it')
    for (const [label, b] of [
        ['PROJECT  ', pop.project],
        ['VENDORED ', pop.vendored]
    ] as const) {
        console.log(
            `  ${label} manifests ${String(b.manifests).padStart(4)}   scripts ${String(b.scripts).padStart(5)}`
                + `   local ${b.local}  state-mutating ${b.state}  outward-facing ${b.outward}`
        )
        for (const e of b.examples) console.log(`      ${e}`)
    }

    // ── C. the count that decides 16B ────────────────────────────────────────
    const all = [...recorded, ...hypothetical]
    const t = tally(all)
    const declaredTotal = all.reduce((n, r) => n + r.declared.length, 0)
    const wouldExecute = all.reduce((n, r) => n + r.runnable.length, 0)
    console.log('')
    console.log('## C. THE COUNT (recorded + hypothetical, deduplicated)')
    console.log(`  declared_total                      ${declaredTotal}`)
    console.log(`  would_execute (non-boot, uncovered) ${wouldExecute}`)
    console.log(`  spawned (…and present in manifest)  ${all.reduce((n, r) => n + r.executed.length, 0)}`)
    console.log(`  by class:  local-only               ${t['local-only']}`)
    console.log(`             state-mutating           ${t['state-mutating']}`)
    console.log(`             outward-facing           ${t['outward-facing']}`)
    console.log(`             (unresolvable body)      ${t['no-body']}`)
    console.log('')
    console.log(
        !detectorOk ?
            'BRANCH: NONE — the classifier self-check is BROKEN, so no count here means anything.'
        : t['outward-facing'] === 0 ?
            'BRANCH: outward-facing == 0 → 16B is CLOSED at STEP 3. Write the count and the reason\n'
                + '        into VALIDATION-DEBT.md; do not write the refusal rule.'
        :   `BRANCH: ${t['outward-facing']} outward-facing → STEP 4 (write the refusal rule + its A/B).`
    )
    process.exitCode = detectorOk ? 0 : 1
}

main()
