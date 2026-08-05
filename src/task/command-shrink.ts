/**
 * SCOPE-SHRINK detection for the final-gate fix pass.
 *
 * The label guard (final-gate-fix.ts) compares the SET of discoverable gate
 * commands before and after the fix child. mx5 run 19 walked straight through
 * it: the autofix rewrote `"test": "AGENT=1 bun test"` to
 * `"AGENT=1 bun test ./test"`, the label `bun run test` existed before and
 * after, the set difference was empty, and the gate re-ran a suite that no
 * longer covered the repository — then reported "autofix converged".
 *
 * What changed was not the command's NAME but its SCOPE. This module compares
 * the RESOLVED BODIES (`scripts[name]` for package.json, the recipe lines for a
 * Makefile target) and classifies each change as narrow / widen / neutral.
 *
 * A narrowing is defined MECHANICALLY, four shapes only:
 *   1. a path/glob argument is ADDED to a command member that had none
 *      (`bun test` → `bun test ./test`);
 *   2. an existing path/glob argument is replaced by a strict SUBPATH of itself
 *      (`eslint src` → `eslint src/server`);
 *   3. an exclusion flag/pattern is ADDED (`--ignore`, `--exclude`,
 *      `--testPathIgnorePatterns`, `-x`, …);
 *   4. a config-file argument is swapped for one the fix pass itself created.
 *
 * With ONE excuse, measured on mx5@a9c6145 and documented at
 * `excusedByRelocation`: rule 3 does not fire when the same pass hands the
 * excluded input to another command the gate already runs.
 *
 * Everything else passes: new env vars, added flags that do not restrict the
 * input set, reordering, added chain members, whole new scripts. The guard's
 * job is to stop the fix pass from silently redefining the gate's own success
 * criterion — not to review the fix.
 *
 * PURE by construction (no fs, no git): the live guard feeds it two body maps
 * from `discoverGateCommandBodies`, the replay harness feeds it two maps built
 * from git blobs. Same code decides both.
 */

/** Which of the four mechanical shapes fired. */
export type ShrinkKind = 'path-added' | 'path-narrowed' | 'exclusion-added' | 'config-swapped'

export type BodyChangeClass = 'narrow' | 'widen' | 'neutral'

export interface BodyChange {
    cls: BodyChangeClass
    /** Every narrowing shape found (empty unless cls === 'narrow'). */
    kinds: ShrinkKind[]
    /** Human-readable one-liners, most specific first. */
    reasons: string[]
    /** Non-deciding observations (e.g. a chain member disappeared) — reported by
     *  the base-rate harness, never a rejection on their own. */
    notes: string[]
}

export interface ShrinkEnv {
    /** Did the fix pass itself CREATE this path? Powers rule 4 only. Absent →
     *  rule 4 is inert (a config swap with no provenance is not evidence). */
    createdByFix?: (p: string) => boolean
    /** The resolved bodies of the OTHER gate commands after the pass. Powers the
     *  RELOCATION excuse on rule 3 (see excusedByRelocation). Absent → no
     *  exclusion is ever excused. */
    siblingBodies?: string[]
}

export interface Narrowing {
    /** The gate command label whose body narrowed (`bun run test`). */
    label: string
    before: string
    after: string
    kinds: ShrinkKind[]
    reasons: string[]
}

// ── tokenizing ──────────────────────────────────────────────────────────────

/** Split a shell body into chain members, quote-aware: `&&`, `||`, `;`, `|`,
 *  and newlines (Makefile recipes arrive as multiple lines). */
export function splitChainMembers(body: string): string[] {
    const out: string[] = []
    let cur = ''
    let quote: string | null = null
    for (let i = 0; i < body.length; i++) {
        const c = body[i]
        if (quote) {
            cur += c
            if (c === quote && body[i - 1] !== '\\') quote = null
            continue
        }
        if (c === '"' || c === "'") {
            quote = c
            cur += c
            continue
        }
        if (c === '\n' || c === ';') {
            out.push(cur)
            cur = ''
            continue
        }
        if ((c === '&' || c === '|') && body[i + 1] === c) {
            out.push(cur)
            cur = ''
            i++
            continue
        }
        if (c === '|') {
            out.push(cur)
            cur = ''
            continue
        }
        cur += c
    }
    out.push(cur)
    return out.map(s => s.trim()).filter(s => s.length > 0)
}

/** Quote-aware word split; surrounding quotes are stripped from each token. */
function tokenize(member: string): string[] {
    const out: string[] = []
    let cur = ''
    let quote: string | null = null
    let started = false
    for (let i = 0; i < member.length; i++) {
        const c = member[i]
        if (quote) {
            if (c === quote && member[i - 1] !== '\\') quote = null
            else cur += c
            continue
        }
        if (c === '"' || c === "'") {
            quote = c
            started = true
            continue
        }
        if (/\s/.test(c)) {
            if (started || cur.length > 0) out.push(cur)
            cur = ''
            started = false
            continue
        }
        cur += c
    }
    if (started || cur.length > 0) out.push(cur)
    return out
}

/** Leading `FOO=bar` env assignments and `sudo`/`exec`/`env`/`time` wrappers,
 *  and a Makefile recipe's `@`/`-`/`+` prefix, carry no verb. */
function stripPrefixes(tokens: string[]): string[] {
    const t = [...tokens]
    if (t.length > 0) t[0] = t[0].replace(/^[@\-+]+(?=[A-Za-z_./])/, '')
    while (
        t.length > 0
        && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^(?:sudo|exec|env|time|nice)$/.test(t[0]))
    ) {
        t.shift()
    }
    return t
}

// ── argument classification ─────────────────────────────────────────────────

const GLOB_RE = /[*?[\]{}]/
/** A conservative source/config extension set — enough to catch a bare file
 *  argument (`jest.config.js`) without calling `--log-level 1.2` a path. */
const EXT_RE =
    /\.(?:[cm]?[jt]sx?|json|jsonc|toml|ya?ml|md|html?|css|scss|py|go|rs|rb|java|kt|swift|c|cc|cpp|h|hpp|sh|sql|lock|cfg|ini|conf|xml|txt)$/i

/** Is this token SYNTACTICALLY a path or glob? Deliberately lexical: no fs. */
export function looksLikePath(tok: string): boolean {
    if (tok.length === 0) return false
    if (tok === '.' || tok === '..') return true
    if (tok.startsWith('-')) return false
    return tok.includes('/') || tok.includes('\\') || GLOB_RE.test(tok) || EXT_RE.test(tok)
}

const RUNNER_RE = /^(?:bun|bunx|npm|npx|pnpm|pnpx|yarn|deno|node|make|cargo|go|uv|poetry|pipenv)$/
const RUN_VERB_RE = /^(?:run|run-script|exec|dlx|x|task)$/

/** Flags whose next token is their VALUE (so it is not itself a path argument).
 *  Every exclusion flag that takes a PATTERN belongs here too — otherwise
 *  `mocha -x slow` reads as a path argument as well as an exclusion. The
 *  boolean-ish exclusions (`--skip`, `--no-tests`) are deliberately absent: they
 *  take no value, and consuming the next token would swallow a real path. */
const VALUE_FLAG_RE =
    /^--?(?:config|configfile|config-file|c|project|tsconfig|ignore|ignores|ignore-pattern|ignore-patterns|ignore-path|ignorePath|exclude|excludes|excludePattern|testPathIgnorePatterns|path-ignore-patterns|deselect|x|reporter|log-level|loglevel|outdir|outfile|out|target|env-file)$/

/** Flags that REMOVE input from the command's set. Adding one narrows scope. */
const EXCLUSION_FLAG_RE =
    /^--?(?:ignore|ignores|ignore-pattern|ignore-patterns|ignore-path|ignorePath|exclude|excludes|excludePattern|testPathIgnorePatterns|path-ignore-patterns|deselect|skip|skip-tests|no-tests|x)$/

/** Flags that point the command at a configuration file. */
const CONFIG_FLAG_RE = /^--?(?:config|configfile|config-file|c|project|tsconfig)$/

interface MemberShape {
    /** Alignment key: `bin verb` (`bun test`, `bun run lint`, `eslint`). */
    key: string
    /** Path/glob arguments, excluding flag values. */
    paths: string[]
    /** Every flag seen, normalized to its name (`--ignore=x` → `--ignore`). */
    flags: Set<string>
    /** Value-flag name → its value (last wins). */
    flagValues: Map<string, string>
    text: string
}

/** Decompose one chain member into the shape the rules compare. */
export function shapeMember(member: string): MemberShape {
    const tokens = stripPrefixes(tokenize(member))
    const shape: MemberShape = {
        key: '',
        paths: [],
        flags: new Set(),
        flagValues: new Map(),
        text: member.trim()
    }
    if (tokens.length === 0) return shape
    const bin = basename(tokens[0])
    shape.key = bin
    let verb = ''
    for (let i = 1; i < tokens.length; i++) {
        const tok = tokens[i]
        if (tok.startsWith('-') && tok.length > 1) {
            const eq = tok.indexOf('=')
            const name = eq >= 0 ? tok.slice(0, eq) : tok
            shape.flags.add(name)
            if (eq >= 0) {
                shape.flagValues.set(name, tok.slice(eq + 1))
            } else if (VALUE_FLAG_RE.test(name) && i + 1 < tokens.length) {
                shape.flagValues.set(name, tokens[i + 1])
                i++
            }
            continue
        }
        // The verb slot — the token IMMEDIATELY after the bin (`bun TEST …`,
        // `ruff CHECK .`) — and, for a runner, the script-name slot after it
        // (`bun run TEST`) name a target, not a path, unless written as one
        // (`bun run src/x.ts`). Both ride in the alignment key instead. The slot
        // is POSITIONAL on purpose: making it "the first non-flag token" would
        // swallow the first path of `eslint --fix src`, and then reading a
        // second one (`eslint --fix src tests`) as a scope shrink — measured as
        // a false positive on dace-pro@45b6fa0.
        if (!looksLikePath(tok)) {
            if (i === 1) {
                verb = tok
                shape.key = `${bin} ${tok}`
                continue
            }
            if (i === 2 && verb !== '' && RUNNER_RE.test(bin) && RUN_VERB_RE.test(verb)) {
                shape.key = `${bin} ${verb} ${tok}`
                continue
            }
            // A BARE word elsewhere is a filter/path argument (`bun test test`,
            // `pytest -q tests`) — without this the guard's own lead is one
            // keystroke from a dodge, since `bun test ./test` and `bun test
            // test` do the same thing. Numbers and booleans are flag values, not
            // paths (`jest --maxWorkers 2`).
            if (!/^(?:[\d.]+|true|false)$/.test(tok)) shape.paths.push(tok)
            continue
        }
        shape.paths.push(tok)
    }
    return shape
}

function basename(p: string): string {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    return i >= 0 ? p.slice(i + 1) : p
}

/** Normalized comparable form: drop `./`, trailing `/`, and everything from the
 *  first glob metacharacter on (so `src/**\/*.ts` compares as `src/`). */
function pathPrefix(p: string): string {
    let s = p.replace(/\\/g, '/')
    const g = s.search(GLOB_RE)
    if (g >= 0) s = s.slice(0, g)
    s = s.replace(/^\.\//, '').replace(/\/+$/, '')
    if (s === '.' || s === '') return ''
    return s
}

/** Is `child` strictly INSIDE `parent`? (`''` is the repo root.) */
export function isStrictSubpath(parent: string, child: string): boolean {
    const a = pathPrefix(parent)
    const b = pathPrefix(child)
    if (a === b) return false
    if (a === '') return b.length > 0
    return b.startsWith(`${a}/`)
}

/**
 * The recipe lines of `target:` in a Makefile, joined by newlines (which
 * splitChainMembers treats as member separators), or null when the target has
 * no rule. Continuations (`\` at end of line) are folded into one line.
 */
export function makefileRecipe(makefileText: string, target: string): string | null {
    const lines = makefileText.split(/\r?\n/)
    const head = new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:(?!=)`)
    let i = lines.findIndex(l => head.test(l))
    if (i < 0) return null
    const recipe: string[] = []
    for (i++; i < lines.length; i++) {
        const l = lines[i]
        if (l.trim() === '' || l.startsWith('#')) continue
        if (!/^\t/.test(l)) break
        let cur = l.replace(/^\t+/, '')
        while (/\\$/.test(cur) && i + 1 < lines.length) {
            cur = `${cur.replace(/\\$/, '')} ${lines[++i].replace(/^\t+/, '')}`
        }
        recipe.push(cur)
    }
    return recipe.length > 0 ? recipe.join('\n') : null
}

// ── the rules ───────────────────────────────────────────────────────────────

/**
 * RELOCATION EXCUSE (rule 3 only, measured on mx5@a9c6145).
 *
 * That autofix rewrote `test` from `AGENT=1 bun test` to `AGENT=1 bun test
 * --path-ignore-patterns '**\/*.spec.tsx' && playwright test -c
 * playwright-ct.config.ts`. Read by hand: `test:ct` was ALREADY
 * `playwright test -c playwright-ct.config.ts` and already a discovered gate
 * command, so the excluded specs never left the gate's coverage — the pass
 * separated two runners that collide, it did not shrink what is measured.
 * Rejecting it would be a false positive, and the rule as first written did.
 *
 * The excuse is deliberately narrow and hard to game: the pass must have added
 * a chain member that is VERBATIM (whitespace-normalized) a member of another
 * discovered gate command's body. `&& echo ok` does not qualify; neither does a
 * near-copy pointed at a different config. Nothing excuses rules 1, 2 or 4 —
 * a path narrowing stands on its own.
 *
 * Returns the matching sibling member, or null.
 */
function excusedByRelocation(addedMembers: MemberShape[], siblingBodies: string[]): string | null {
    if (addedMembers.length === 0 || siblingBodies.length === 0) return null
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ')
    const sibling = new Set(siblingBodies.flatMap(b => splitChainMembers(b)).map(m => norm(m)))
    for (const m of addedMembers) {
        if (sibling.has(norm(m.text))) return m.text.trim()
    }
    return null
}

/** Align members of two bodies by key; duplicates align in declaration order. */
function alignMembers(
    before: MemberShape[],
    after: MemberShape[]
): {
    pairs: Array<[MemberShape, MemberShape]>
    onlyBefore: MemberShape[]
    onlyAfter: MemberShape[]
} {
    const pairs: Array<[MemberShape, MemberShape]> = []
    const pool = [...after]
    const onlyBefore: MemberShape[] = []
    for (const b of before) {
        const i = pool.findIndex(a => a.key === b.key)
        if (i < 0) onlyBefore.push(b)
        else pairs.push([b, pool.splice(i, 1)[0]])
    }
    return {pairs, onlyBefore, onlyAfter: pool}
}

/**
 * Classify one command body change. Deterministic, no side conditions beyond
 * the optional `createdByFix` provenance used by rule 4.
 */
export function classifyBodyChange(before: string, after: string, env: ShrinkEnv = {}): BodyChange {
    const out: BodyChange = {cls: 'neutral', kinds: [], reasons: [], notes: []}
    if (before.trim() === after.trim()) return out

    const {pairs, onlyBefore, onlyAfter} = alignMembers(
        splitChainMembers(before).map(shapeMember),
        splitChainMembers(after).map(shapeMember)
    )

    let widened = false
    const narrow = (kind: ShrinkKind, reason: string) => {
        out.cls = 'narrow'
        if (!out.kinds.includes(kind)) out.kinds.push(kind)
        out.reasons.push(reason)
    }

    for (const [b, a] of pairs) {
        // RULE 1 — a path/glob argument added to a member that had none.
        if (b.paths.length === 0 && a.paths.length > 0) {
            narrow(
                'path-added',
                `\`${b.key}\` ran over the whole project and now runs over ${a.paths.map(p => `\`${p}\``).join(', ')}`
            )
        } else if (b.paths.length > 0 && a.paths.length === 0) {
            widened = true
        }

        // RULE 2 — an existing path replaced by a strict subpath of itself.
        const goneFromA = b.paths.filter(p => !a.paths.includes(p))
        const newInA = a.paths.filter(p => !b.paths.includes(p))
        for (const p of goneFromA) {
            const sub = newInA.find(q => isStrictSubpath(p, q))
            if (sub) {
                narrow(
                    'path-narrowed',
                    `\`${b.key}\` argument \`${p}\` was replaced by its subpath \`${sub}\``
                )
            } else if (newInA.some(q => isStrictSubpath(q, p))) {
                widened = true
            }
        }

        // RULE 3 — an exclusion flag/pattern added, unless the same pass handed
        // the excluded input to another command the gate already runs.
        for (const f of a.flags) {
            if (!EXCLUSION_FLAG_RE.test(f) || b.flags.has(f)) continue
            const v = a.flagValues.get(f)
            const relocation = excusedByRelocation(onlyAfter, env.siblingBodies ?? [])
            if (relocation) {
                out.notes.push(
                    `exclusion \`${f}${v ? ` ${v}` : ''}\` excused — relocated to \`${relocation}\``
                )
                continue
            }
            narrow(
                'exclusion-added',
                `\`${b.key}\` gained the exclusion \`${f}${v ? ` ${v}` : ''}\`, removing input from what the gate measures`
            )
        }
        for (const f of b.flags) {
            if (EXCLUSION_FLAG_RE.test(f) && !a.flags.has(f)) widened = true
        }

        // RULE 4 — a config argument swapped for a file the fix pass created.
        for (const f of a.flags) {
            if (!CONFIG_FLAG_RE.test(f)) continue
            const av = a.flagValues.get(f)
            const bv = b.flagValues.get(f)
            if (!av || av === bv) continue
            if (env.createdByFix?.(av)) {
                narrow(
                    'config-swapped',
                    `\`${b.key}\` was pointed at \`${av}\`, a config file this fix pass created`
                )
            }
        }
    }

    // Observations only — a vanished chain member is a scope change the four
    // pre-registered rules do not cover. Reported, never rejected on.
    for (const b of onlyBefore) out.notes.push(`member-removed: \`${b.text}\``)
    for (const a of onlyAfter) out.notes.push(`member-added: \`${a.text}\``)

    if (out.cls === 'neutral' && widened) out.cls = 'widen'
    return out
}

/**
 * Every gate command whose resolved body NARROWED across the fix pass. Labels
 * present on only one side are the label guard's business, not this one's.
 */
export function findNarrowedCommands(
    before: Record<string, string>,
    after: Record<string, string>,
    env: ShrinkEnv = {}
): Narrowing[] {
    const out: Narrowing[] = []
    for (const [label, body] of Object.entries(before)) {
        const now = after[label]
        if (now === undefined) continue
        const siblingBodies = Object.entries(after)
            .filter(([l]) => l !== label)
            .map(([, b]) => b)
        const c = classifyBodyChange(body, now, {siblingBodies, ...env})
        if (c.cls !== 'narrow') continue
        out.push({label, before: body, after: now, kinds: c.kinds, reasons: c.reasons})
    }
    return out
}

/** One-line rejection text for the guard and the log. */
export function narrowingRejectionText(narrowed: Narrowing[]): string {
    const first = narrowed[0]
    const more = narrowed.length > 1 ? ` (+${narrowed.length - 1} more)` : ''
    return (
        `fix pass NARROWED the gate's own command \`${first.label}\`${more}: ${first.reasons[0]}`
        + ` — \`${first.before}\` → \`${first.after}\``
    )
}
