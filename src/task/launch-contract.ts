/**
 * launch-contract — a per-run record of the package/build SCRIPTS the SOURCE design
 * declares the finished project must expose, extracted once at plan time and diffed
 * by the final gate against the shipped manifest.
 *
 * The failure this closes (mx5 run 10 item 4): the design's §9 "Build & run" listed
 * the required scripts verbatim — `dev`, `build`, `migrate`, `seed`, `test` — but the
 * shipped package.json declared only `dev`, `build`, `lint`, `test`, `test:ct`. No
 * task owned `migrate`/`seed` (they fell through decompose), and NOTHING re-checked
 * the finished manifest against the design's own list, so the run completed missing
 * two of its declared entrypoints. A per-slice gate cannot catch this — it is a
 * whole-project launch-surface fact — and the final gate never had the design's list.
 *
 * Mechanism (mirrors contracts.ts): a plan-time child EMITs `SCRIPT:` lines naming the
 * scripts the design declares; the host GROUNDS each against the design — a name is
 * kept only if the design mentions it as an inline-code token (`` `migrate` ``), the
 * form designs use to declare a script. A paraphrase or a script the model invented is
 * not grounded and is dropped, so the diff can never false-flag on a hallucinated
 * requirement. The grounded list is appended HOST-SIDE to `.pi-tasks/launch-contract.md`
 * (children never write it), which survives discardEdits and the git-state guard.
 *
 * At run end the final gate reads the list, reads the manifest's `scripts`, and FAILs
 * naming any declared script the manifest is missing. FP-safe by construction: an
 * empty/ungrounded list (a design that never backticks a script name) yields no check.
 */
import {makeLedger} from './ledger.js'

const LAUNCH_CONTRACT_FILE = 'launch-contract.md'
/** Cap kept entries so a noisy extraction cannot grow the artifact unboundedly. */
const MAX_SCRIPTS = 40
/** npm/package script names are short kebab/colon tokens; reject anything unscript-like. */
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/i

/** Stored one name per line; a line that is not a script name is skipped on read. */
const ledger = makeLedger<string>({
    file: LAUNCH_CONTRACT_FILE,
    max: MAX_SCRIPTS,
    key: n => n.toLowerCase(),
    serialize: n => n,
    parse: raw => {
        const seen = new Set<string>()
        const out: string[] = []
        for (const line of raw.split('\n')) {
            const n = line.trim()
            if (n.length === 0 || !SCRIPT_NAME_RE.test(n)) continue
            const key = n.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(n)
        }
        return out
    }
})

export function launchContractFile(cwd: string): string {
    return ledger.path(cwd)
}

/**
 * Parse `SCRIPT: <name>` lines out of a child's answer into bare script names. A line
 * whose token is not script-name-shaped is skipped (an accidental sentence, a path).
 */
export function parseScriptLines(text: string): string[] {
    const out: string[] = []
    for (const m of text.matchAll(/^[ \t]*SCRIPT:[ \t]*(.+)$/gim)) {
        // Take the first whitespace/comma-delimited token, stripping backticks/quotes.
        const raw =
            m[1]
                .trim()
                .split(/[\s,]+/)[0]
                ?.replace(/[`'"]/g, '') ?? ''
        if (SCRIPT_NAME_RE.test(raw)) out.push(raw)
    }
    return out
}

/**
 * THE GROUNDING GUARD: keep only names the design declares as an inline-code token
 * (`` `name` ``) — the form a design uses to name a script. A name the model
 * paraphrased or invented has no such token, so it is dropped and the diff cannot
 * false-flag on it. Deduplicated, case-insensitive.
 */
export function keepGroundedScripts(names: string[], sourceDoc: string): string[] {
    const haystack = sourceDoc.toLowerCase()
    const seen = new Set<string>()
    const kept: string[] = []
    for (const n of names) {
        const key = n.toLowerCase()
        if (seen.has(key)) continue
        if (!haystack.includes('`' + key + '`')) continue
        seen.add(key)
        kept.push(n)
    }
    return kept
}

/**
 * DETERMINISTIC RECALL (mx5 run 11): enumerate every backticked, script-name-shaped
 * token in a paragraph that mentions the word "script", as extraction CANDIDATES.
 *
 * The run-11 failure this closes: `test:ct` is backticked in the design's §2 tooling
 * paragraph, so the grounding guard would have KEPT it — but the extraction child
 * anchored on §9's one-line summary (`dev`,`build`,`migrate`,`seed`,`test`) and never
 * emitted it. Grounding can only DROP a candidate, never add one, so recall was
 * entirely the model's, over a 20KB doc. This makes recall mechanical: the host
 * enumerates candidates and hands them to the child as an explicit checklist; the
 * model's job flips from recall (weak) to per-candidate classification (strong).
 *
 * The paragraph gate (`\bscripts?\b`, word-bounded so "TypeScript"/"JavaScript"
 * don't match) is a grounded-context filter, not a tuned knob: a design declares a
 * script by calling it one. It keeps package-name paragraphs (`hono`, `react`) out
 * of the checklist so a weak model isn't invited to keep junk the grounding guard
 * would then bless (every package name is backticked somewhere). A design with no
 * such paragraph yields no candidates and the prompt is unchanged.
 */
export function enumerateScriptCandidates(sourceDoc: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    // Normalise CRLF/CR → LF first: a Windows-authored design would otherwise
    // collapse into one paragraph (the split marker never matches `\r\n\r\n`),
    // caps out on early package-name backticks, and drops the real scripts.
    for (const para of sourceDoc.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
        if (!/\bscripts?\b/i.test(para)) continue
        for (const m of para.matchAll(/`([^`\n]+)`/g)) {
            const tok = m[1].trim()
            if (!SCRIPT_NAME_RE.test(tok)) continue
            const key = tok.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(tok)
        }
    }
    return out.slice(0, MAX_SCRIPTS)
}

/** The stored declared-script list ('' when none recorded). */
export async function readLaunchContractRaw(cwd: string): Promise<string> {
    return ledger.readRaw(cwd)
}

/** The declared script names recorded for this run (deduped, order preserved). */
export async function readDeclaredScripts(cwd: string): Promise<string[]> {
    return ledger.read(cwd)
}

/** Append grounded script names, deduped against what is stored, keeping newest MAX. */
export async function appendDeclaredScripts(cwd: string, names: string[]): Promise<void> {
    await ledger.append(cwd, names)
}

/**
 * Boot-class script names: long-running serve/watch shapes the gate's BOOT check
 * owns (it needs a listener, a grace window, and a group kill). These are never run
 * as one-shot gate commands — a `dev` server run synchronously would only burn the
 * timeout. Suffixed variants (`dev:client`, `start-prod`) are boot-class too.
 */
const BOOT_CLASS_RE = /^(?:dev|start|serve|preview|watch)(?:[:_-].*)?$/i

/**
 * The declared scripts the final gate must EXECUTE as one-shot commands (mx5 run
 * 11): everything the launch contract declares that is neither boot-class (the
 * boot check exercises those) nor already covered by the gate's integration
 * commands (`covered`, case-insensitive — the test/build-shaped scripts that ran).
 * Run 11 shipped `migrate` and `seed` broken (`.rows` on a Bun sql array —
 * TypeError on first call) while the gate checked only that the scripts EXIST;
 * existence is not launchability.
 */
export function runnableDeclaredScripts(declared: string[], covered: string[]): string[] {
    const have = new Set(covered.map(s => s.toLowerCase()))
    return declared.filter(n => !BOOT_CLASS_RE.test(n) && !have.has(n.toLowerCase()))
}

/**
 * Declared scripts the manifest does NOT expose (case-insensitive). Empty when every
 * declared script is present, or when nothing was declared (no check). This is the
 * deterministic lever the final gate FAILs on.
 */
export function missingDeclaredScripts(declared: string[], manifestScripts: string[]): string[] {
    const have = new Set(manifestScripts.map(s => s.toLowerCase()))
    const seen = new Set<string>()
    const missing: string[] = []
    for (const d of declared) {
        const key = d.toLowerCase()
        if (have.has(key) || seen.has(key)) continue
        seen.add(key)
        missing.push(d)
    }
    return missing
}

/**
 * The plan-time extraction prompt: the design in hand, emit the scripts it declares.
 * Runs with --no-tools (pure extraction). Every emitted name is re-grounded HOST-SIDE
 * (keepGroundedScripts), so a hallucinated script cannot reach the diff.
 *
 * `candidates` is enumerateScriptCandidates' mechanical checklist. It exists so the
 * model cannot MISS a declared script buried far from the design's summary list (the
 * run-11 `test:ct` hole); the model still classifies each candidate against the
 * design, and the host grounding still applies. Empty ⇒ the prompt is unchanged.
 */
export const LAUNCH_EXTRACT_PROMPT = (feature: string, candidates: string[] = []): string =>
    [
        'You are recording the PACKAGE/BUILD SCRIPTS the design below says the finished',
        'project MUST expose (the `scripts` a package.json / Makefile / task runner must',
        'declare — e.g. build, test, a migration runner, a seed step, a start/serve command).',
        'These are launch-surface entrypoints the whole project shares; if one the design',
        'names is missing from the shipped manifest, the project cannot be run as specified.',
        '',
        'DESIGN (the ONLY source — name only scripts the design itself declares):',
        feature.trim(),
        '',
        ...(candidates.length > 0 ?
            [
                'CANDIDATE TOKENS — found mechanically in the design near the word "script".',
                'This checklist exists ONLY so you do not MISS a declared script; many of these',
                'tokens are NOT scripts (config option names, tool names). For EACH candidate,',
                'decide from the design whether it is a script the finished project must expose,',
                'and emit it only if so. A declared script MISSING from this checklist must still',
                'be emitted — the checklist is a floor, not a ceiling.',
                candidates.map(c => `  - ${c}`).join('\n'),
                ''
            ]
        :   []),
        'For each script the design declares by name, emit exactly:',
        '  SCRIPT: <name>',
        'one per line, the bare script name only (e.g. `SCRIPT: migrate`). RULES: (1) name',
        'ONLY scripts the design explicitly lists — do NOT invent conventional ones it does',
        'not mention. (2) Use the exact name the design uses. (3) A name that is not literally',
        'in the design is DISCARDED host-side, so guessing wastes effort. If the design',
        'declares no scripts, output nothing.',
        '',
        'Output the SCRIPT: lines and nothing else.'
    ].join('\n')
