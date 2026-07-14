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
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from './task-io.js'

const LAUNCH_CONTRACT_FILE = 'launch-contract.md'
/** Cap kept entries so a noisy extraction cannot grow the artifact unboundedly. */
const MAX_SCRIPTS = 40
/** npm/package script names are short kebab/colon tokens; reject anything unscript-like. */
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9:_-]{0,39}$/i

export function launchContractFile(cwd: string): string {
    return path.join(tasksDir(cwd), LAUNCH_CONTRACT_FILE)
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

/** The stored declared-script list ('' when none recorded). */
export async function readLaunchContractRaw(cwd: string): Promise<string> {
    try {
        return (await fsp.readFile(launchContractFile(cwd), 'utf8')).trim()
    } catch {
        return ''
    }
}

/** The declared script names recorded for this run (deduped, order preserved). */
export async function readDeclaredScripts(cwd: string): Promise<string[]> {
    const raw = await readLaunchContractRaw(cwd)
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

/** Append grounded script names, deduped against what is stored, keeping newest MAX. */
export async function appendDeclaredScripts(cwd: string, names: string[]): Promise<void> {
    if (names.length === 0) return
    try {
        const existing = await readDeclaredScripts(cwd)
        const seen = new Set(existing.map(n => n.toLowerCase()))
        const merged = [...existing]
        for (const n of names) {
            if (seen.has(n.toLowerCase())) continue
            seen.add(n.toLowerCase())
            merged.push(n)
        }
        const kept = merged.slice(-MAX_SCRIPTS)
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        await fsp.writeFile(launchContractFile(cwd), kept.join('\n') + '\n', 'utf8')
    } catch {
        // best-effort artifact
    }
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
 */
export const LAUNCH_EXTRACT_PROMPT = (feature: string): string =>
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
