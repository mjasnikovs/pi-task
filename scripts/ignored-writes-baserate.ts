/**
 * STEP 0 for nexttask 4 — what a write-capable gate child actually writes to
 * GITIGNORED paths, measured BEFORE any rule is wired.
 *
 * VERDICT (2026-08-05): the rule is usable, and the doc's stated fear — "the
 * corpus is dominated by node_modules/, dist/ and lockfile churn" — is NOT what
 * the corpus shows. Over 11 repos and 68 recorded child logs under ~/hub:
 *
 *   TRAIL   29 write events by gate children, 9 of them to ignored paths:
 *             mx5 final-gate-debug.log   .env ×2   THE LEAD (edit tool)
 *             mx5 verify-debug.log       .env ×6   `cp .env.example .env`, the
 *                                                  SAME class at the verify site
 *             mx5 verify-debug.log       node_modules ×1  (`bun install pg`) —
 *                                                  exempt by mechanism
 *           Zero `dist/` writes. Gate children do not hand-write build output;
 *           the COMMANDS they run do, and command output never enters this
 *           channel because attribution is a before/after snapshot of the
 *           child's own window.
 *
 *   STATE   43 ignored entries across the 11 repos; 21 exempt by mechanism
 *           (48.8%), 22 'actionable'. Only 4 of those 22 fall inside a recorded
 *           run window and only one — mx5's `.env` — belongs to a gate child.
 *           The rest are pre-existing developer files (`.claude/`, `.models/`,
 *           `session.json`, packed `.tgz`) that no snapshot diff would attribute
 *           to a run at all.
 *
 * Two mechanism findings that changed the shipped rule:
 *
 *   1. `:(exclude).pi-tasks` does NOT suppress `.pi-tasks/` under
 *      `--ignored=matching`: git reports a wholly-ignored directory before
 *      pathspec descent, so in the repos that gitignore `.pi-tasks` (aiz-client,
 *      IAR1) the run's OWN task dir would be reported as an ignored write on
 *      every run. Hence the explicit task-dir class in classifyIgnoredPath.
 *   2. A whitelist-style `.gitignore` (`/*` then `!/src`, `!/cmake`, … — IAR1's
 *      shape) makes EVERY new root-level file ignored. The name-list exemption
 *      cannot help there; what saves the rule is that the finding must be a
 *      write ATTRIBUTED to the child, and then survive the dependency probe.
 *
 * Two parser corrections were needed before the trail numbers meant anything,
 * both hand-read out of the IAR1 log: `->` in C++ (`g_engine->Stop()`) parsed as
 * a shell redirection, and commands that `cd /tmp` first write outside the repo
 * entirely. Uncorrected they inflated the ignored count from 9 to 53.
 *
 * The lead (mx5 run 19): the final-gate autofix greened `bun run seed` by writing
 * `DATABASE_URL` / `ADMIN_PHONE` / `ADMIN_PASSWORD` into `/workspace/.env`, which
 * `.gitignore:14` ignores. Every write guard consumes
 * `git status --porcelain -- . :(exclude).pi-tasks` (gate-deps.ts:328/645/956),
 * and porcelain does not report ignored paths, so the edit was structurally
 * invisible: absent from the diff capture, from the deletion guard, from the
 * probe scan, from the stranded-fix commit. The gate certified a PASS that a
 * fresh clone cannot reproduce.
 *
 * The doc's question is whether a rule over the ignored channel is USABLE, i.e.
 * whether the ignored writes in the corpus are dominated by `dist/` and
 * `node_modules/` churn. Two independent channels, both read-only:
 *
 *   TRAIL   every recorded child run (`~/hub/<repo>/.pi-tasks/*-debug.log`),
 *           parsed for write events — `edit:` / `write:` tool lines, and
 *           `bash:` lines whose command is write-shaped (redirection, tee,
 *           cp/mv/touch/mkdir, `sed -i`, a package install). Each target path is
 *           resolved against the repo root and classified with the repo's own
 *           `git check-ignore -v`, so the classification is git's, not a
 *           heuristic's.
 *
 *   STATE   `git status --porcelain --ignored=matching` per corpus repo — the
 *           exact command the lever proposes. This is the channel the rule would
 *           actually see, and the one that answers the ratio question. `matching`
 *           collapses a wholly-ignored directory into ONE entry (`dist/`,
 *           `node_modules/`), which is why the noise is bounded.
 *
 * The channels answer different halves and neither is sufficient alone: TRAIL
 * proves which writes a gate child made (but only sees writes it announced),
 * STATE proves what the rule would fire on (but cannot attribute a file to a
 * child). Entries are cross-checked by mtime against the recorded run window.
 *
 * Read-only: no repo is written to, no file contents are ever printed (see
 * `inv-no-secret-echo` — `.env` is the canonical case and this script must not
 * leak it either).
 *
 *     bun run scripts/ignored-writes-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const HUB = path.join(os.homedir(), 'hub')

// ── mechanical categories (the lever's exemption must be a mechanism, not a list
//    of names it hopes covers the corpus) ────────────────────────────────────────

/** Directory basenames that are build output or dependency trees by convention. */
const BUILD_DIRS = new Set([
    'node_modules',
    'dist',
    'build',
    'target',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '.svelte-kit',
    '.turbo',
    '.cache',
    '.parcel-cache',
    '.vite',
    '__pycache__',
    '.pytest_cache',
    '.venv',
    'venv',
    '.gradle',
    'obj',
    'bin'
])

/** Build outdirs parsed out of the repo's own package.json scripts (`--outdir=X`,
 *  `--out-dir X`, `-o X`), so the exemption follows the project's real tooling
 *  rather than a fixed name list. */
function parsedOutdirs(repo: string): string[] {
    const pkg = path.join(repo, 'package.json')
    if (!fs.existsSync(pkg)) return []
    let scripts: Record<string, string>
    try {
        scripts = (JSON.parse(fs.readFileSync(pkg, 'utf8')) as {scripts?: Record<string, string>})
            .scripts ?? {}
    } catch {
        return []
    }
    const out = new Set<string>()
    for (const body of Object.values(scripts)) {
        for (const m of body.matchAll(/--outdir[= ]([^\s'"]+)/g)) out.add(m[1]!)
        for (const m of body.matchAll(/--out-dir[= ]([^\s'"]+)/g)) out.add(m[1]!)
    }
    return [...out].map(p => p.replace(/^\.\//, '').replace(/\/+$/, '')).filter(p => p.length > 0)
}

export type Category = 'build-output' | 'dep-dir' | 'task-dir' | 'vcs-meta' | 'other'

/** Classify a repo-relative path mechanically. `other` is the only category the
 *  lever may act on. */
export function categorize(rel: string, outdirs: string[]): Category {
    const clean = rel.replace(/^\.\//, '').replace(/\/+$/, '')
    const segs = clean.split('/').filter(s => s.length > 0)
    if (segs[0] === '.pi-tasks' || segs.includes('.pi-tasks')) return 'task-dir'
    if (segs[0] === '.git' || segs.includes('.git')) return 'vcs-meta'
    if (segs.includes('node_modules')) return 'dep-dir'
    for (const o of outdirs) {
        const os_ = o.split('/').filter(s => s.length > 0)
        if (os_.every((s, i) => segs[i] === s)) return 'build-output'
    }
    if (segs.some(s => BUILD_DIRS.has(s))) return 'build-output'
    return 'other'
}

// ── git helpers ──────────────────────────────────────────────────────────────

function git(repo: string, args: string[]): {code: number; out: string} {
    const r = spawnSync('git', args, {cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    return {code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '')}
}

/** `git check-ignore -v` verdict for one path: the ignoring rule, or null. */
function ignoreRule(repo: string, rel: string): string | null {
    const r = spawnSync('git', ['check-ignore', '-v', '--no-index', '--', rel], {
        cwd: repo,
        encoding: 'utf8'
    })
    if ((r.status ?? 1) !== 0) return null
    const line = (r.stdout ?? '').split('\n')[0] ?? ''
    const parts = line.split('\t')
    return parts[0] ?? null
}

function isTracked(repo: string, rel: string): boolean {
    return git(repo, ['ls-files', '--error-unmatch', '--', rel]).code === 0
}

// ── TRAIL channel ────────────────────────────────────────────────────────────

export interface WriteEvent {
    repo: string
    log: string
    line: number
    tsMs: number
    /** How the write was announced. */
    via: 'edit' | 'write' | 'bash'
    /** Repo-relative target path. */
    rel: string
    /** Verbatim command/path fragment (never file CONTENTS). */
    evidence: string
}

/** Child kinds whose writes are gate writes (not a task's committed work). */
export function logKind(base: string): 'gate' | 'task' | 'plan' {
    if (base.startsWith('TASK_')) return 'task'
    if (base === 'plan-debug.log') return 'plan'
    return 'gate' // final-gate-debug.log, verify-debug.log, enforce-debug.log
}

const TOOL_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (edit|write|bash): ([\s\S]*)$/

/** A token that can be a real filesystem path: no shell metacharacters, no
 *  unexpanded variable, no C++ / prose debris (`g_engine->Stop(`, `data[c]`,
 *  `#include`). Anything else is parser noise, not a write. */
function looksLikePath(t: string): boolean {
    if (!/^[\w./@+~-]+$/.test(t)) return false
    if (t === '.' || t === '..') return false
    // A bare lowercase-or-mixed word with no dot and no slash is far more likely a
    // C++/prose token than a file (`Stop`, `frames`, `200`).
    if (!t.includes('/') && !t.includes('.')) return false
    return true
}

/** Write targets a bash command implies. Deliberately over-inclusive on shape and
 *  under-inclusive on certainty: every hit is re-classified by git afterwards, so
 *  a false shape costs a line in the table, never a verdict.
 *
 *  Two hand-read corrections, both from the IAR1 trail: `->` in C++ read as a
 *  redirection (`g_engine->Stop()`), and a command that `cd`s out of the workspace
 *  first (`cd /tmp && cat > bad_plugin.cpp`) writes OUTSIDE the repo, so its
 *  relative targets are not repo paths at all. */
export function bashWriteTargets(cmd: string): string[] {
    const out: string[] = []
    // A `cd` to anywhere other than the workspace re-bases every later relative
    // path; only absolute /workspace targets survive from such a command.
    const leavesWorkspace = /(?:^|[\s;&|])cd\s+(?!\/workspace\b)(\/|~)\S*/.test(cmd)
    const push = (t: string | undefined): void => {
        if (!t) return
        const clean = t.replace(/^['"]|['"]$/g, '')
        if (clean.length === 0 || clean.startsWith('-')) return
        if (clean.includes('$') || clean.includes('`')) return // unexpanded — target unknown
        if (!looksLikePath(clean)) return
        if (/^\/(dev|proc|sys|etc|var|usr|tmp|root|opt|home)\b/.test(clean)) return
        if (leavesWorkspace && !clean.startsWith('/workspace')) return
        out.push(clean)
    }
    // redirections: `> path`, `>> path` (but not `2>&1`, `>&2`, `->`)
    for (const m of cmd.matchAll(/(?<![0-9&>=<!~^*/+-])>>?\s*(?!&)([^\s;|&)]+)/g)) push(m[1])
    for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?([^\s;|&)]+)/g)) push(m[1])
    for (const m of cmd.matchAll(/\btouch\s+([^\s;|&)]+)/g)) push(m[1])
    for (const m of cmd.matchAll(/\bmkdir\s+(?:-p\s+)?([^\s;|&)]+)/g)) push(m[1])
    for (const m of cmd.matchAll(/\bsed\s+-i[^\s]*\s+(?:'[^']*'|"[^"]*"|\S+)\s+([^\s;|&)]+)/g))
        push(m[1])
    for (const m of cmd.matchAll(/\b(?:cp|mv)\s+(?:-\S+\s+)*\S+\s+([^\s;|&)]+)/g)) push(m[1])
    // package installs write node_modules + a lockfile
    if (/\b(?:npm|bun|pnpm|yarn)\s+(?:i|install|add)\b/.test(cmd)) out.push('node_modules')
    return out
}

/** Map an absolute sandbox path (`/workspace/...`) or a relative one onto the repo. */
function toRel(repo: string, target: string): string | null {
    let t = target
    if (t.startsWith('/workspace/')) t = t.slice('/workspace/'.length)
    else if (t === '/workspace') return null
    else if (path.isAbsolute(t)) {
        if (!t.startsWith(repo + path.sep)) return null // outside the repo entirely
        t = t.slice(repo.length + 1)
    }
    t = t.replace(/^\.\//, '')
    if (t.length === 0 || t.startsWith('..')) return null
    return t
}

function parseLog(repo: string, file: string): WriteEvent[] {
    const base = path.basename(file)
    const events: WriteEvent[] = []
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const m = TOOL_LINE.exec(lines[i]!)
        if (!m) continue
        const [, ts, tool, rest] = m as unknown as [string, string, string, string]
        const tsMs = Date.parse(ts)
        const targets =
            tool === 'bash' ? bashWriteTargets(rest)
            : [rest.trim().split(/\s+/)[0] ?? '']
        for (const t of targets) {
            const rel = toRel(repo, t)
            if (rel === null) continue
            events.push({
                repo: path.basename(repo),
                log: base,
                line: i + 1,
                tsMs,
                via: tool as WriteEvent['via'],
                rel,
                evidence: rest.length > 120 ? rest.slice(0, 120) + '…' : rest
            })
        }
    }
    return events
}

// ── report ───────────────────────────────────────────────────────────────────

interface StateEntry {
    repo: string
    rel: string
    category: Category
    rule: string | null
    mtimeMs: number | null
    inRunWindow: boolean
}

function runWindow(repo: string): {from: number; to: number} | null {
    const dir = path.join(repo, '.pi-tasks')
    if (!fs.existsSync(dir)) return null
    let from = Infinity
    let to = -Infinity
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue
        const st = fs.statSync(path.join(dir, f))
        from = Math.min(from, st.mtimeMs - 24 * 3600 * 1000) // logs are appended; birth is unknown
        to = Math.max(to, st.mtimeMs)
    }
    return from === Infinity ? null : {from, to}
}

function main(): void {
    if (!fs.existsSync(HUB)) {
        console.log('ABSTAIN — no corpus under ~/hub')
        process.exit(2)
    }
    const repos = fs
        .readdirSync(HUB)
        .map(d => path.join(HUB, d))
        .filter(d => fs.existsSync(path.join(d, '.git')))
        .sort()
    if (repos.length === 0) {
        console.log('ABSTAIN — no git repos under ~/hub')
        process.exit(2)
    }

    // ── TRAIL ────────────────────────────────────────────────────────────────
    const trail: (WriteEvent & {ignored: boolean; rule: string | null; category: Category})[] = []
    let logsSeen = 0
    for (const repo of repos) {
        const dir = path.join(repo, '.pi-tasks')
        if (!fs.existsSync(dir)) continue
        const outdirs = parsedOutdirs(repo)
        for (const f of fs.readdirSync(dir).sort()) {
            if (!f.endsWith('.log')) continue
            logsSeen++
            for (const e of parseLog(repo, path.join(dir, f))) {
                const rule = ignoreRule(repo, e.rel)
                trail.push({
                    ...e,
                    ignored: rule !== null,
                    rule,
                    category: categorize(e.rel, outdirs)
                })
            }
        }
    }

    console.log(`# STEP 0 — ignored-path writes by gate children`)
    console.log(`\ncorpus: ${repos.length} repos under ~/hub, ${logsSeen} recorded child logs\n`)

    console.log('## TRAIL channel — write events announced by a child')
    const byKind = new Map<string, {total: number; ignored: number}>()
    for (const e of trail) {
        const k = logKind(e.log)
        const c = byKind.get(k) ?? {total: 0, ignored: 0}
        c.total++
        if (e.ignored) c.ignored++
        byKind.set(k, c)
    }
    for (const [k, c] of [...byKind].sort()) {
        console.log(`  ${k.padEnd(6)} ${String(c.total).padStart(4)} writes, ${c.ignored} ignored`)
    }
    const ignoredTrail = trail.filter(e => e.ignored)
    console.log(`\n  IGNORED writes (${ignoredTrail.length}):`)
    if (ignoredTrail.length === 0) console.log('    (none)')
    for (const e of ignoredTrail) {
        console.log(
            `    ${e.repo}/${e.log}:${e.line}  ${e.via.padEnd(5)} ${e.rel}` +
                `  [${e.category}] ← ${e.rule}`
        )
    }
    const trackedByBash = trail.filter(e => e.via === 'bash' && !e.ignored && isTracked(e.repo === path.basename(HUB) ? HUB : path.join(HUB, e.repo), e.rel))
    console.log(
        `\n  (control) bash writes to TRACKED paths: ${trackedByBash.length}` +
            ` — these the porcelain capture already sees`
    )

    // ── STATE ────────────────────────────────────────────────────────────────
    console.log('\n## STATE channel — `git status --porcelain --ignored=matching`')
    const state: StateEntry[] = []
    for (const repo of repos) {
        const outdirs = parsedOutdirs(repo)
        const win = runWindow(repo)
        const r = git(repo, [
            'status',
            '--porcelain',
            '--ignored=matching',
            '--',
            '.',
            ':(exclude).pi-tasks'
        ])
        if (r.code !== 0) {
            console.log(`  ${path.basename(repo)}: git failed — skipped`)
            continue
        }
        for (const raw of r.out.split('\n')) {
            if (!raw.startsWith('!! ')) continue
            const rel = raw.slice(3).trim().replace(/^"|"$/g, '')
            let mtimeMs: number | null
            try {
                mtimeMs = fs.statSync(path.join(repo, rel)).mtimeMs
            } catch {
                mtimeMs = null
            }
            state.push({
                repo: path.basename(repo),
                rel,
                category: categorize(rel, outdirs),
                rule: ignoreRule(repo, rel),
                mtimeMs,
                inRunWindow:
                    win !== null && mtimeMs !== null && mtimeMs >= win.from && mtimeMs <= win.to
            })
        }
    }
    const counts = new Map<Category, number>()
    for (const s of state) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
    console.log(`  ${state.length} ignored entries across ${repos.length} repos, by category:`)
    for (const [c, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${c.padEnd(13)} ${String(n).padStart(3)}`)
    }
    const actionable = state.filter(s => s.category === 'other')
    console.log(`\n  ACTIONABLE (category 'other' — what the rule would fire on):`)
    for (const s of actionable.sort((a, b) => a.repo.localeCompare(b.repo) || a.rel.localeCompare(b.rel))) {
        console.log(
            `    ${(s.repo + '/' + s.rel).padEnd(56)} ${s.inRunWindow ? 'IN-RUN-WINDOW' : 'older'}`
        )
    }
    const exemptRatio = state.length === 0 ? 0 : (state.length - actionable.length) / state.length
    console.log(
        `\n  exempt-by-mechanism: ${state.length - actionable.length}/${state.length}` +
            ` (${(exemptRatio * 100).toFixed(1)}%) — build-output, dep-dir, task-dir, vcs-meta`
    )

    // ── LEAD ─────────────────────────────────────────────────────────────────
    const lead = ignoredTrail.filter(
        e => e.repo === 'mx5' && e.log === 'final-gate-debug.log' && e.rel === '.env'
    )
    console.log(
        `\nLEAD mx5 run 19 — ${
            lead.length > 0 ?
                `${lead.length} ignored write(s) to .env by the final-gate fix pass, category '${lead[0]!.category}'`
            :   'NOT reproduced from the trail — the parser misses the case it was built for'
        }`
    )
    if (lead.length === 0) process.exit(1)
}

main()
