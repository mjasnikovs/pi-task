/**
 * Grep-theater VERIFY detector, wired as the `grep-theater` compose-critique
 * probe in `critique-probes.ts`.
 *
 * A finding fires when the spec's VERIFY block (a) inspects the source of a
 * TypeScript/JavaScript/shell file with grep/rg/cat/head/tail/wc and (b)
 * contains no execution command at all — every pipeline segment's head is in
 * STATIC_HEADS. One unknown head anywhere in the block (bun, node, npm, yarn,
 * pnpm, curl, `./script`, python3) counts as execution and the whole block is
 * skipped. Recall is therefore floored at the unambiguous all-static case
 * instead of deciding which command exercises which file.
 */
import {parseVerifyBlock} from './spec-validation.js'

export interface GrepOnlyVerifyFinding {
    /** The runnable source file being grep-asserted, e.g. "build.ts". */
    target: string
    /** The VERIFY lines that inspect it, verbatim. */
    lines: string[]
}

/** Commands that only inspect — a segment headed by one never runs the deliverable. */
const STATIC_HEADS = new Set([
    'grep',
    'rg',
    'cat',
    'ls',
    'test',
    '[',
    '[[',
    'find',
    'wc',
    'head',
    'tail',
    'diff',
    'stat',
    'echo',
    'printf',
    'true',
    'false',
    'cd',
    'pwd',
    'which',
    'command',
    'file',
    'jq',
    'sed',
    'awk',
    'sort',
    'uniq',
    'cut',
    'tr',
    'sleep',
    'exit',
    // static-analysis tools: they read source, they don't run the deliverable
    'tsc',
    'eslint',
    'prettier',
    'biome'
])

/**
 * A bare path token ending in a runnable-source extension: ts, tsx, js, jsx,
 * mjs, cjs, mts, cts, sh. The character class holds no quote, so a quoted
 * `'build.ts'` never matches.
 */
const RUNNABLE_SRC_RE = /^[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|sh)$/

/**
 * Heads whose file arguments count as "inspecting the source of". The other
 * STATIC_HEADS (sed, awk, jq, ls, diff, file …) keep a block static but name
 * no target of their own.
 */
const INSPECT_HEADS = new Set(['grep', 'rg', 'cat', 'head', 'tail', 'wc'])

/**
 * Shell-control noise that precedes (or IS) a segment without being a command.
 * `if grep -q x f; then` splits into `if grep -q x f` plus a bare ` then`;
 * `… || { echo FAIL; exit 1; }` yields ` { echo FAIL`, ` exit 1` and ` }`.
 * An unknown head counts as execution and skips the whole block, so treating
 * these tokens as heads would blind the detector on any guarded grep.
 */
const CONTROL_PREFIX = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', '!'])
const CONTROL_ONLY = new Set(['}', ')', 'fi', 'done', 'esac'])

/**
 * The effective head of one pipeline segment: leading `(`/`{`/`!`,
 * shell-control prefixes, VAR=val assignments and `timeout N` are skipped;
 * `bunx`/`npx` resolve to the tool they invoke, so `bunx tsc --noEmit` stays
 * static. `bun`/`npm`/`yarn`/`pnpm`/`node` stay as themselves and are absent
 * from STATIC_HEADS, so whatever they run is execution.
 */
function segmentHead(segment: string): {head: string; args: string[]} | null {
    const tokens = segment.split(/\s+/).filter(t => t.length > 0)
    let i = 0
    while (i < tokens.length) {
        const t = tokens[i].replace(/^[({!]+/, '')
        if (t.length === 0 || CONTROL_PREFIX.has(t)) {
            i++
            continue
        }
        tokens[i] = t
        break
    }
    if (i >= tokens.length || CONTROL_ONLY.has(tokens[i])) return null
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++
    if (i < tokens.length && tokens[i] === 'timeout') {
        i++
        if (i < tokens.length && /^\d/.test(tokens[i])) i++
    }
    if (i >= tokens.length) return null
    let head = tokens[i]
    if (head === 'bunx' || head === 'npx') {
        i++
        while (i < tokens.length && tokens[i].startsWith('-')) i++
        if (i >= tokens.length) return null
        head = tokens[i]
    }
    return {head, args: tokens.slice(i + 1)}
}

/**
 * Scan a composed spec's VERIFY block: one finding per runnable source file the
 * block inspects, each carrying the verbatim lines that inspect it. Empty when
 * the block contains any execution command, when the spec has no fenced VERIFY
 * block, or when nothing runnable is inspected (doc/config-only tasks).
 */
export function findGrepOnlyVerify(spec: string): GrepOnlyVerifyFinding[] {
    const cmds = parseVerifyBlock(spec)
    if (!cmds) return []
    const inspected = new Map<string, string[]>()
    for (const {raw} of cmds) {
        // Split into pipeline segments. A mis-split — a quoted `&&` making a
        // fake segment — leaves a segment whose head is unknown, which counts
        // as execution and skips the block. The error direction is a MISSED
        // finding, never a false one.
        for (const segment of raw.split(/&&|\|\||;|\|/)) {
            const s = segmentHead(segment)
            if (s === null) continue
            if (!STATIC_HEADS.has(s.head)) return [] // real execution — step aside
            if (!INSPECT_HEADS.has(s.head)) continue
            for (const arg of s.args) {
                if (arg.startsWith('-') || arg.startsWith("'") || arg.startsWith('"')) continue
                if (!RUNNABLE_SRC_RE.test(arg)) continue
                const lines = inspected.get(arg) ?? []
                if (!lines.includes(raw)) lines.push(raw)
                inspected.set(arg, lines)
            }
        }
    }
    return [...inspected.entries()].map(([target, lines]) => ({target, lines}))
}

/** One VERIFY command, classified by what it can observe. */
export interface VerifyCommandClass {
    /** The command line, verbatim. */
    raw: string
    /** Every pipeline segment's head is in STATIC_HEADS (grep/test/tsc/…) — it
     *  inspects files and can never observe the deliverable's behaviour. */
    staticOnly: boolean
    /**
     * The command names an HTTP request (`curl`, `wget`, an http(s) URL,
     * `fetch(`), a port probe (`nc -z`, `ss -`, `lsof`, `localhost`,
     * `127.0.0.1`) or `playwright`. Executing something is not enough:
     * `bun run start` and `node -e "…package.json…"` are both false here — they
     * run, yet observe only a file's contents.
     */
    observesBehaviour: boolean
}

const BEHAVIOUR_RE =
    /\bcurl\b|\bwget\b|\bhttpie?\b|https?:\/\/|\bnc\s+-z\b|\bss\s+-|\blsof\b|127\.0\.0\.1|localhost|\bplaywright\b|\bfetch\(/i

/**
 * Classify each command of a spec's VERIFY block. Shares `segmentHead` with the
 * grep-theater detector, so "static" means one thing across the two measures.
 * Empty when the spec has no fenced VERIFY block.
 */
export function classifyVerifyCommands(spec: string): VerifyCommandClass[] {
    const cmds = parseVerifyBlock(spec)
    if (!cmds) return []
    return cmds.map(({raw}) => {
        let staticOnly = true
        for (const segment of raw.split(/&&|\|\||;|\|/)) {
            const s = segmentHead(segment)
            if (s === null) continue
            if (!STATIC_HEADS.has(s.head)) staticOnly = false
        }
        return {raw, staticOnly, observesBehaviour: BEHAVIOUR_RE.test(raw)}
    })
}

/**
 * Prepended to the SECOND `runWithEmphasisRetry` attempt when the first critique
 * rewrite still leaves `findGrepOnlyVerify` non-empty. The generic emphasis line
 * would claim the previous attempt had no VERIFY block, which is wrong here — it
 * had one. The defect block naming the exact files stays in the prompt body
 * underneath the hint.
 */
export const GREP_THEATER_RETRY_HINT =
    '[SYSTEM NOTE: Your previous rewrite still shipped a VERIFY block whose only signal '
    + 'on the runnable deliverable is grep-on-source — every command is static inspection '
    + '(grep/cat/test/tsc) and the artifact is never run. This exact shape shipped a broken '
    + 'build that stayed broken for 14 tasks. The rewritten VERIFY MUST execute the '
    + 'deliverable (e.g. `bun <script>.ts`, `bun run <script>`, start it and curl it) and '
    + 'assert an observable outcome of that run (exit code, a file the run produces, a '
    + 'served response). Keep greps only as additions to the run, never as the only signal.]'

/** Render the findings as the defect block handed to the critique rewrite. */
export function grepOnlyVerifyDefectText(findings: GrepOnlyVerifyFinding[]): string {
    return [
        'GREP-THEATER VERIFY — every command in the VERIFY block is static inspection',
        '(grep/cat/test/tsc), yet the deliverable includes runnable source. Grep-asserting',
        'that a source file CONTAINS some text proves nothing about behavior (run-13: a',
        'build script "verified" by greps shipped broken and stayed broken for 14 tasks',
        'because `bun build.ts` was never run). Rewrite the VERIFY block so it EXECUTES the',
        'runnable deliverable and asserts an OBSERVABLE OUTCOME of that run — exit code,',
        'a produced file (`rm -rf dist && bun run build && test -f dist/…`), a served',
        'response (`curl -sf http://…`). Keep static checks only as ADDITIONS to the run,',
        'never as the sole signal. Runnable files currently only grep/cat-inspected:',
        ...findings.map((f, i) => `  ${i + 1}. ${f.target} — via: ${f.lines.join(' ; ')}`)
    ].join('\n')
}
