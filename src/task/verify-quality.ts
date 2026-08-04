/**
 * Grep-theater VERIFY detector (mx5 run-13 Bug B), compose-critique side.
 *
 * TASK_0018's VERIFY block "verified" a build script with tsc + three greps on
 * build.ts's SOURCE — it never ran `bun build.ts`. The greps asserted the
 * hallucinated `Bun.mkdirSync` line was present, so a broken build shipped
 * green and stayed broken for 14 tasks. Grep-on-source is not verification of
 * a runnable deliverable; only executing the artifact is.
 *
 * Deterministic shape (findSkipEscapes → critique-rewrite pattern): a finding
 * fires when the VERIFY block (a) grep/cat-asserts the SOURCE of a runnable
 * file (.ts/.js/.sh — a build script, server, CLI entry) and (b) contains NO
 * execution command at all — every command is static inspection (grep, test,
 * ls, cat, tsc --noEmit, eslint, prettier). Any real execution anywhere in the
 * block (bun/node/npm run/test, curl, ./script) means the deliverable-runs
 * question is at worst partially covered, and we step aside — the guard may
 * only cost time, never work, so recall is floored at the unambiguous
 * all-static case rather than chasing which command exercises which file.
 */
import {parseVerifyBlock} from './spec-validation.js'

export interface GrepOnlyVerifyFinding {
    /** The runnable source file being grep-asserted, e.g. "build.ts". */
    target: string
    /** The VERIFY lines that inspect it, verbatim. */
    lines: string[]
}

/** Commands that only inspect — they never execute the shipped artifact. */
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

/** A bare (unquoted) path token ending in a runnable-source extension. */
const RUNNABLE_SRC_RE = /^[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|sh)$/

/** Heads whose file arguments count as "inspecting the source of". */
const INSPECT_HEADS = new Set(['grep', 'rg', 'cat', 'head', 'tail', 'wc'])

/**
 * Shell-control noise that precedes (or IS) a segment without being a command:
 * `if grep -q x f; then` splits into an `if`-prefixed segment plus bare `then`;
 * `… || { echo FAIL; exit 1; }` yields `{ echo …` and `}` segments. Treating
 * these as unknown heads would count them as execution and silently blind the
 * detector on exactly the incident shape (run-13's VERIFY used all of them).
 */
const CONTROL_PREFIX = new Set(['if', 'elif', 'while', 'until', 'then', 'else', 'do', '!'])
const CONTROL_ONLY = new Set(['}', ')', 'fi', 'done', 'esac'])

/**
 * The effective head of one pipeline segment: shell-control prefixes, leading
 * `(`/`{`, VAR=val prefixes and `timeout N` are skipped; `bunx`/`npx` resolve
 * to the tool they invoke (so `bunx tsc --noEmit` is static).
 * `bun`/`npm`/`yarn`/`pnpm`/`node` stay as themselves — whatever they run (a
 * script, a test suite, a file) is execution.
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
 * Scan a composed spec's VERIFY block: all-static block that grep/cat-asserts
 * runnable source ⇒ one finding per inspected file. Empty when the block
 * contains any execution command, has no VERIFY block, or inspects no runnable
 * source (doc/config-only tasks).
 */
export function findGrepOnlyVerify(spec: string): GrepOnlyVerifyFinding[] {
    const cmds = parseVerifyBlock(spec)
    if (!cmds) return []
    const inspected = new Map<string, string[]>()
    for (const {raw} of cmds) {
        // Split into pipeline segments; quotes are rare in VERIFY one-liners and
        // a mis-split only risks a MISSED finding (a quoted `&&` making a fake
        // segment whose head is unknown ⇒ counted as execution ⇒ step aside).
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
    /** Every pipeline segment is a STATIC head (grep/test/tsc/…) — it inspects
     *  files and can never observe the deliverable's behaviour. */
    staticOnly: boolean
    /**
     * The command observes RUNTIME behaviour: an HTTP request, a port probe, a
     * process it starts and watches. This is the distinction nexttask 7's M3
     * turns on — mx5 run 18's TASK_0023 VERIFY is all `node -e "…package.json…"`,
     * which EXECUTES node yet can only assert that a string is present in a
     * config file, and the behavioural half of the owned requirement ("serves
     * `/api` + static `dist/`") is exactly what it cannot see.
     */
    observesBehaviour: boolean
}

const BEHAVIOUR_RE =
    /\bcurl\b|\bwget\b|\bhttpie?\b|https?:\/\/|\bnc\s+-z\b|\bss\s+-|\blsof\b|127\.0\.0\.1|localhost|\bplaywright\b|\bfetch\(/i

/**
 * Classify each command of a spec's VERIFY block. Shares `segmentHead` with the
 * grep-theater detector, so "static" means one thing across the two measures.
 * Empty when the spec has no runnable VERIFY block.
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
 * Retry hint when the critique rewrite KEPT the grep-theater block it was told
 * to fix (live A/B: 1/5 rewrites ignored the injected defect). Prepended to the
 * second rewrite attempt; the defect block naming the exact files is still in
 * the prompt body.
 */
export const GREP_THEATER_RETRY_HINT =
    '[SYSTEM NOTE: Your previous rewrite still shipped a VERIFY block whose only signal '
    + 'on the runnable deliverable is grep-on-source — every command is static inspection '
    + '(grep/cat/test/tsc) and the artifact is never run. This exact shape shipped a broken '
    + 'build that stayed broken for 14 tasks. The rewritten VERIFY MUST execute the '
    + 'deliverable (e.g. `bun <script>.ts`, `bun run <script>`, start it and curl it) and '
    + 'assert an observable outcome of that run (exit code, a file the run produces, a '
    + 'served response). Keep greps only as additions to the run, never as the only signal.]'

/**
 * Render the findings as a defect block for the critique rewrite: VERIFY must
 * EXECUTE the runnable deliverable and assert an observable outcome of THAT
 * run, not grep its source.
 */
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
