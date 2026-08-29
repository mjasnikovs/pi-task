/**
 * env-template-closure — a shipped source file requires an env var the shipped
 * template never mentions.
 *
 * The failure this closes: `src/server/seed.ts`
 * reads `process.env.ADMIN_PHONE` / `ADMIN_PASSWORD` with no default, the tracked
 * `.env.example` declares only `DATABASE_URL` + `APP_URL`, and `bun run seed` was
 * one of the run's final-gate commands. It exited 1; the gate's autofix wrote the
 * two vars into `.env`, which is GITIGNORED — so the committed tree
 * still cannot seed and nothing at run end ever said why. Coverage credits the
 * CONSUMING side (seed.ts exists, is owned, passes its own VERIFY); the template is
 * a separate artifact nobody re-reads after the task that wrote it.
 *
 * THE RULE. Every REQUIRED env read in TRACKED source must appear in the TRACKED
 * env template. One-directional: a variable DECLARED but never read is silence, not
 * a finding (dace-pro ships 13 declared / 7 required and must stay clean).
 *
 * REQUIRED is mechanical. A read steps aside when it:
 *   1. carries a default — `?? …`, `|| …`, `os.getenv('X', d)`, `environ.get('X', d)`;
 *   2. is compared, not consumed — `===`, `!==`, `==`, `!=` on either side;
 *   3. is an assignment TARGET — `process.env.DATABASE_URL = testDbUrl`, which is
 *      what a test file typically does, and is the single largest FP
 *      source in the corpus;
 *   4. names an AMBIENT variable — a short fixed allowlist (below) of things the
 *      platform, not the project, supplies.
 *
 * FP discipline (the artifact-closure discipline, one layer up):
 *   • literal names only. `process.env[key]`, `const {A} = process.env` and every
 *     other dynamic form is OPAQUE and steps aside — a false negative is free, a
 *     false rank-0 gate failure is not.
 *   • TRACKED files only, via `git ls-files`, so a gitignored `.env` or an
 *     untracked scratch file can neither declare nor require anything.
 *   • generated/vendored trees (`dist/`, `build/`, `node_modules/`, …) are not
 *     authored source and are skipped; they only ever mirror a read we already saw.
 *   • NO TEMPLATE IN THE TREE ⇒ THE CHECK IS INERT (as `repo-health-check` does
 *     with a missing manifest). This must never invent a file the project chose
 *     not to have.
 *
 * Not npm-shaped: JS/TS
 * (`process.env` / `Bun.env`), Python (`os.environ[…]`, `os.environ.get`,
 * `os.getenv`) and Go (`os.Getenv`) read the same way. Go's `os.LookupEnv` is the
 * explicit may-be-absent API and is treated as its own step-aside.
 */
import {spawnSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import * as path from 'node:path'

/** Variables the PLATFORM supplies, not the project. Deliberately short: every
 *  entry is a name no `.env.example` is expected to carry. */
export const AMBIENT_ENV = new Set([
    'NODE_ENV',
    'CI',
    'PATH',
    'HOME',
    'TZ',
    'PORT',
    'USER',
    'SHELL',
    'TMPDIR',
    'LANG',
    // Windows/OS equivalents of the above, and the package manager's own vars —
    // every one of these reads as "required" to a naive scan (`npm_execpath`,
    // `LOCALAPPDATA`, `XDG_CACHE_HOME`), and none belongs in a project's template.
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'TEMP',
    'TMP',
    'PWD',
    'HOSTNAME',
    'LOGNAME',
    'TERM',
    'COMSPEC'
])

/** The same rule by MECHANISM rather than by name: a variable INJECTED by a
 *  platform (CI runner, package manager, freedesktop base dirs). STEP 0 found
 *  `GITHUB_ENV` (written by GitHub Actions), `npm_execpath` and `XDG_CACHE_HOME`
 *  classified as required in real trees; a template that declared them would be
 *  wrong, so the exclusion is the prefix, not a growing list of names. */
export const AMBIENT_PREFIXES = ['npm_', 'GITHUB_', 'RUNNER_', 'CI_', 'XDG_', 'BUN_', 'NODE_']

/** Rule 4: is this variable the platform's to supply? */
export function isAmbient(name: string): boolean {
    return AMBIENT_ENV.has(name) || AMBIENT_PREFIXES.some(p => name.startsWith(p))
}

/** Basenames that count as the project's env TEMPLATE. */
export const ENV_TEMPLATE_NAMES = ['.env.example', '.env.sample', '.env.template', '.env.dist']

/** Source extensions we can read env accesses out of. */
const SOURCE_EXT_RE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/i

/** Generated / vendored trees — not authored source. */
const GENERATED_RE = /(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|\.next|\.output)\//

/** Why a read does not require a declaration. `null` ⇒ it does. */
export type StepAside = 'default' | 'compared' | 'assigned' | 'ambient' | 'optional-api' | 'probe'

export interface EnvRead {
    /** Variable name, always a literal. */
    name: string
    /** Repo-relative file the read lives in. */
    file: string
    /** 1-indexed line of the read. */
    line: number
    /** The matched construct (`process.env`, `os.getenv`, …). */
    construct: string
    /** null ⇒ REQUIRED; otherwise the mechanical reason it stepped aside. */
    stepAside: StepAside | null
}

export interface EnvClosure {
    /** Tracked template files found (repo-relative). Empty ⇒ check is inert. */
    templates: string[]
    /** Every variable any template declares. */
    declared: Set<string>
    /** Every literal env read seen in tracked source, step-asides included. */
    reads: EnvRead[]
    /** Required reads whose variable no template declares — the findings. */
    missing: EnvRead[]
}

/** An inert result: what every tree with no tracked template returns. */
export function inertClosure(): EnvClosure {
    return {templates: [], declared: new Set(), reads: [], missing: []}
}

function git(cwd: string, args: string[]): string | null {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null
    return r.stdout
}

/** Tracked files, repo-root-relative. null when `cwd` is not a git work tree. */
export function trackedFiles(cwd: string): string[] | null {
    const out = git(cwd, ['ls-files', '-z'])
    if (out === null) return null
    return out.split('\0').filter(p => p.length > 0)
}

/** Variables a template file declares. A bare `X=` line declares `X`. */
export function parseTemplate(text: string): string[] {
    const names: string[] = []
    for (const raw of text.split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
        if (m) names.push(m[1])
    }
    return names
}

/** Strip line comments so a read quoted in prose is not a read. Conservative:
 *  only whole-line `//`, `#`, `*` and `/*` openers — never mid-line, because a
 *  `//` inside a string literal (a URL) would eat real code. */
function isCommentLine(line: string): boolean {
    return /^\s*(?:\/\/|#|\*|\/\*)/.test(line)
}

interface Matcher {
    re: RegExp
    construct: string
    /** The match stops INSIDE a call (`os.Getenv("X"` ← here), so the operator that
     *  decides rule 2 sits after the closing paren: `os.Getenv("X") == ""`, the Go
     *  defaulting idiom. Call-form matchers strip that paren before classifying. */
    call?: true
    /** Extra step-aside decided by the matcher itself (Go's LookupEnv, a
     *  two-argument getenv default). */
    classify?: (m: RegExpExecArray, after: string) => StepAside | null
}

/** A trailing `, default` inside the call — `os.getenv('X', 'y')`. */
const callHasDefault = (after: string): boolean => /^\s*,/.test(after)

const MATCHERS: Matcher[] = [
    // JS/TS — dotted and bracketed.
    {re: /\b(?:process|Bun)\.env\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g, construct: 'process.env'},
    {
        re: /\b(?:process|Bun)\.env\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
        construct: 'process.env[]'
    },
    // Python.
    {
        re: /\bos\.environ\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g,
        construct: 'os.environ[]'
    },
    {
        re: /\bos\.environ\.get\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
        construct: 'os.environ.get',
        call: true,
        classify: (_m, after) => (callHasDefault(after) ? 'default' : null)
    },
    {
        re: /\bos\.getenv\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g,
        construct: 'os.getenv',
        call: true,
        classify: (_m, after) => (callHasDefault(after) ? 'default' : null)
    },
    // Go.
    {re: /\bos\.Getenv\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, construct: 'os.Getenv', call: true},
    {
        re: /\bos\.LookupEnv\s*\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g,
        construct: 'os.LookupEnv',
        call: true,
        classify: () => 'optional-api'
    }
]

/** Does the text right after the read supply a default, or continue onto a line
 *  that opens with one? (`process.env.X\n    ?? 'y'` is one expression.)
 *
 *  A ternary CONDITION counts: `process.env.npm_execpath ? a : b` names both
 *  outcomes, so nothing is required. `?.` is
 *  optional chaining, not a ternary, and must not match. */
function hasDefault(before: string, after: string, nextLine: string | undefined): boolean {
    // The read IS the fallback: `X ?? process.env.BRAVE_API_KEY` (brave-warning.ts)
    // — an alternative to another source, never independently required.
    if (/(?:\?\?|\|\|)\s*$/.test(before)) return true
    if (/^\s*(?:\?\?|\|\||\?(?![.?]))/.test(after)) return true
    if (after.trim().length === 0 && nextLine !== undefined && /^\s*(?:\?\?|\|\|)/.test(nextLine))
        return true
    return false
}

/**
 * Rule 5 — a PRESENCE PROBE: the read asks whether the variable is set and the
 * code carries on either way. Demanded by the STEP-0 hand-read, which found three
 * shapes of it in real trees and NONE of them belongs in a template:
 *
 *   `if (process.env.PI_BIN) {…}`            pi-invocation.ts — a test override
 *   `const c = process.env.CHROME_BIN`       render-check.ts — falls back to the
 *   `if (c) …`                               Playwright cache when unset
 *
 * The discriminator is the SIGN of the guard, and it is exactly what separates
 * those from the lead: a seed script writes `const phone = process.env.ADMIN_PHONE`
 * … `if (!phone) throw`. A NEGATED guard means the variable is required and the
 * program stops without it; a POSITIVE guard means it is an override. So a bare
 * `if (` / `while (` head steps aside, `if (!` does not, and an assign-then-guard
 * is resolved by looking ahead for the FIRST guard on that variable.
 */
const GUARD_HEAD_RE = /\b(?:if|while)\s*\(\s*$/
/** How far an assign-then-guard may reach. A few lines is typical; 10 is slack. */
const GUARD_LOOKAHEAD = 10

function isProbeHead(before: string): boolean {
    return GUARD_HEAD_RE.test(before)
}

/** `const v = process.env.X` → the variable's name, else null. */
function assignedTo(before: string): string | null {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(before)
    return m ? m[1] : null
}

/**
 * What the guard's own body does. A NEGATED guard only means "required" when the
 * program STOPS without the variable — `if (!phone) throw`. When
 * it merely returns or falls through — `if (!process.env.PI_REMOTE_PUSH_DEBUG)
 * return` (push.ts, a debug flag) — the variable is optional and the negation
 * proves nothing. Same syntax, opposite meaning; the body is the discriminator.
 */
const HARD_STOP_RE =
    /\bthrow\b|process\.exit\s*\(|\bos\.Exit\s*\(|\bsys\.exit\s*\(|\bpanic\s*\(|\braise\b/
const HARD_STOP_LOOKAHEAD = 3

function bodyStops(lines: string[], at: number): boolean {
    for (let i = at; i < Math.min(lines.length, at + HARD_STOP_LOOKAHEAD); i++) {
        if (HARD_STOP_RE.test(lines[i])) return true
    }
    return false
}

/** First `if (v)` / `if (!v)` on `name` within the window. `required` only for a
 *  negated guard that stops; anything else is an override probe. */
function guardVerdict(lines: string[], from: number, name: string): 'required' | 'probe' | null {
    const re = new RegExp(`\\bif\\s*\\(\\s*(!?)\\s*${name}\\b`)
    for (let i = from; i < Math.min(lines.length, from + GUARD_LOOKAHEAD); i++) {
        const m = re.exec(lines[i])
        if (m) return m[1] === '!' && bodyStops(lines, i) ? 'required' : 'probe'
    }
    return null
}

/** Rule 6 — a file that WRITES the variable is not a consumer of the project's
 *  env contract for it. Covers the test save/restore idiom (`prev =
 *  process.env.X` in `beforeEach`, `process.env.X = prev` in `afterEach`), which
 *  reads the variable only to put it back. File-scoped extension of rule 3. */
function locallySupplied(text: string, name: string): boolean {
    const n = name.replace(/[$]/g, '\\$')
    return (
        new RegExp(`(?:process|Bun)\\.env\\s*\\.\\s*${n}\\s*(?:\\+|\\?\\?|\\|\\|)?=(?![=>])`).test(
            text
        )
        || new RegExp(`(?:process|Bun)\\.env\\s*\\[\\s*['"]${n}['"]\\s*\\]\\s*=(?![=>])`).test(text)
        || new RegExp(`delete\\s+(?:process|Bun)\\.env\\s*\\.\\s*${n}\\b`).test(text)
        || new RegExp(`\\bos\\.environ\\s*\\[\\s*['"]${n}['"]\\s*\\]\\s*=(?![=])`).test(text)
        || new RegExp(`\\bos\\.[Ss]etenv\\s*\\(\\s*['"]${n}['"]`).test(text)
    )
}

/** Rule 5b — a file that PRESENCE-CHECKS the variable positively anywhere treats
 *  it as an override, so every read of it in that file is a probe. Without this,
 *  the CONSUMING read inside the guarded branch — `if (process.env.PI_BIN) return
 *  {command: process.env.PI_BIN}` (pi-invocation.ts), `process.env.GOFER_PYTHON ?
 *  [process.env.PYTHON_BIN] : [...]` — reads as required. */
function locallyProbed(text: string, name: string): boolean {
    const e = `(?:process|Bun)\\.env\\s*\\.\\s*${name}`
    return (
        new RegExp(`\\b(?:if|while)\\s*\\(\\s*${e}\\b`).test(text)
        || new RegExp(`${e}\\s*\\?(?![.?])`).test(text)
        || new RegExp(`\\bBoolean\\s*\\(\\s*${e}\\b`).test(text)
    )
}

/** Comparison on either side — a probe of the environment, not a consumption. */
function isCompared(before: string, after: string): boolean {
    if (/^\s*(?:===|!==|==|!=)/.test(after)) return true
    if (/(?:===|!==|==|!=)\s*$/.test(before)) return true
    return false
}

/** Rule 3: the read is a WRITE — `process.env.X = …` (but not `==`/`===`), or
 *  `delete process.env.X`. Both mean the file SUPPLIES the variable rather than
 *  consuming it; a suite of test files is the assignment case and a
 *  `wdio.packaged.conf.ts` (`delete process.env.GOFER_GDFORMAT`) is the delete
 *  case — a scrub of a developer override, the opposite of a requirement. */
function isAssigned(before: string, after: string): boolean {
    if (/^\s*=(?![=>])/.test(after)) return true
    if (/\bdelete\s*$/.test(before)) return true
    return false
}

/** Every literal env read in one file's text. */
export function scanSource(file: string, text: string): EnvRead[] {
    const lines = text.split(/\r?\n/)
    const reads: EnvRead[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (isCommentLine(line)) continue
        for (const matcher of MATCHERS) {
            matcher.re.lastIndex = 0
            let m: RegExpExecArray | null
            while ((m = matcher.re.exec(line)) !== null) {
                const name = m[1]
                const before = line.slice(0, m.index)
                const raw = line.slice(m.index + m[0].length)
                let stepAside: StepAside | null = matcher.classify?.(m, raw) ?? null
                // Past the call's own closing paren, so an operator that applies to
                // the RESULT is seen (`os.Getenv("X") == ""`).
                const after = matcher.call ? raw.replace(/^\s*\)/, '') : raw
                // …and past any WRAPPING call's brackets, so `Number(process.env.X)
                // || 32` — the largest false-positive class — reads as defaulted. Stepping aside when the `||` in fact
                // defaults an enclosing expression is a false NEGATIVE, which this
                // check spends freely; a false rank-0 gate failure it does not.
                // …and past a trailing accessor chain, so `process.env.X?.trim() ||
                // '/tmp/…'` (push.ts) is the defaulted read it plainly is.
                const unwrapped = after
                    .replace(/^(?:\s*\??\.\s*[A-Za-z_$][\w$]*(?:\([^()]*\))?)*/, '')
                    .replace(/^[\s)\]]+/, '')
                if (stepAside === null && isAmbient(name)) stepAside = 'ambient'
                if (stepAside === null && isAssigned(before, after)) stepAside = 'assigned'
                if (stepAside === null && isCompared(before, unwrapped)) stepAside = 'compared'
                if (stepAside === null && hasDefault(before, unwrapped, lines[i + 1]))
                    stepAside = 'default'
                if (stepAside === null && locallySupplied(text, name)) stepAside = 'assigned'
                if (stepAside === null && (isProbeHead(before) || locallyProbed(text, name)))
                    stepAside = 'probe'
                // `if (!process.env.X) …` — required only if the body stops.
                if (
                    stepAside === null
                    && /\b(?:if|while)\s*\(\s*!\s*$/.test(before)
                    && !bodyStops(lines, i)
                )
                    stepAside = 'probe'
                if (stepAside === null) {
                    const v = assignedTo(before)
                    if (v !== null && guardVerdict(lines, i + 1, v) === 'probe') stepAside = 'probe'
                }
                reads.push({name, file, line: i + 1, construct: matcher.construct, stepAside})
            }
        }
    }
    return reads
}

/**
 * Scan a tree: tracked templates × required reads in tracked source.
 *
 * Inert (empty templates, no findings) when the tree is not a git work tree or
 * carries no tracked env template — the ENOENT=pass contract.
 */
export function scanEnvTemplateClosure(cwd: string): EnvClosure {
    const tracked = trackedFiles(cwd)
    if (tracked === null) return inertClosure()
    const templates = tracked.filter(p => ENV_TEMPLATE_NAMES.includes(path.posix.basename(p)))
    if (templates.length === 0) return inertClosure()
    const declared = new Set<string>()
    for (const t of templates) {
        try {
            for (const n of parseTemplate(readFileSync(path.join(cwd, t), 'utf8'))) declared.add(n)
        } catch {
            // a tracked-but-absent template (dirty worktree) declares nothing
        }
    }
    const reads: EnvRead[] = []
    for (const f of tracked) {
        if (!SOURCE_EXT_RE.test(f) || GENERATED_RE.test(f)) continue
        let text: string
        try {
            text = readFileSync(path.join(cwd, f), 'utf8')
        } catch {
            continue
        }
        // Cheap prefilter. Case-insensitive substring, NOT a word boundary:
        // `os.Getenv(` / `os.LookupEnv(` carry no boundary before `env`, and a
        // boundary-anchored filter silently drops every Go file (caught by the
        // go fixture in STEP 0).
        if (!/env/i.test(text)) continue
        reads.push(...scanSource(f, text))
    }
    const missing = reads.filter(r => r.stepAside === null && !declared.has(r.name))
    return {templates, declared, reads, missing}
}

/**
 * The gate's view: one finding per VARIABLE (first read site, source order), not
 * one per read — a var read in four files is one artifact defect, and the ranked
 * failure list is read by a human and seeds the autofix prompt.
 */
export function findMissingEnvDeclarations(cwd: string): {templates: string[]; missing: EnvRead[]} {
    const c = scanEnvTemplateClosure(cwd)
    const seen = new Set<string>()
    const missing: EnvRead[] = []
    for (const r of c.missing) {
        if (seen.has(r.name)) continue
        seen.add(r.name)
        missing.push(r)
    }
    return {templates: c.templates, missing}
}

/** One finding, as the final gate would phrase it. */
export function envGateFailureText(t: EnvRead, templates: string[]): string {
    return (
        `env closure: \`${t.name}\` is required by ${t.file}:${t.line} (${t.construct}) but no `
        + `tracked env template declares it (${templates.join(', ')}) — a fresh clone cannot `
        + 'supply it.'
    )
}
