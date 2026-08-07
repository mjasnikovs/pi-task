/**
 * launch-manifest — WHICH manifest the launch-contract diff is entitled to diff
 * against, and whether there is one at all (nexttask 16A).
 *
 * The defect this closes (unobserved, proven by construction). The extraction end
 * of the launch contract has no ecosystem test anywhere in it:
 * `enumerateScriptCandidates` scrapes backticked, script-name-shaped tokens out of
 * any design paragraph that says "script", and `keepGroundedScripts` can only DROP
 * a candidate. So a CMake / cargo / poetry / Makefile design saying *"the Makefile
 * must expose `build`, `test`, `migrate`"* records exactly the same artifact an npm
 * design does. The diff end hardcoded the ecosystem anyway:
 *
 *     missingDeclaredScripts(declared, Object.keys(packageScripts(cwd)))
 *     …where packageScripts' catch returns {} — so "this project has no
 *     package.json" was indistinguishable from "its package.json declares no
 *     scripts", and every declared script was reported missing, at rank 1, in
 *     wording that NAMES a file the project was never meant to have.
 *
 * That text seeds the autofix child's prompt (final-gate.ts's FinalGateOutcome.reason),
 * so the most likely repair on a CMake project was to write a package.json.
 *
 * IAR1 is how close this got: `plan-debug.log:10` records "launch-contract
 * extraction: 0 grounded script(s) kept from 3 emitted" — a non-npm project that
 * reached extraction and emitted three candidates, saved only by its design not
 * backticking them in a "script" paragraph.
 *
 * THE RULE, and it is deliberately two ecosystems wide, not three:
 *   • package.json present and parseable ⇒ diff against its `scripts` keys, exactly
 *     as before (byte-identical failure text on every npm tree — mx5's missing
 *     `build`/`seed` is a TRUE positive and must keep failing).
 *   • no package.json but a Makefile ⇒ diff against its TARGETS. The capability was
 *     already in final-gate.ts (`makeHasTarget`); the diff simply never called it.
 *   • neither ⇒ the check is INERT. No failure, and a note saying the contract was
 *     recorded but is not checkable here, so the silence is not read later as a pass
 *     (the repo-health-check / env-template-closure discipline: ENOENT = pass, and a
 *     check must never invent a file the project chose not to have).
 *
 * cargo/poetry/gradle are NOT here on purpose. The corpus on this box contains one
 * project that ever recorded a launch contract (mx5, npm) and one non-npm project
 * that reached extraction (IAR1, CMake). A third ecosystem would be a guess.
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import * as path from 'node:path'

/** Which manifest kind the diff resolved for a tree. `none` ⇒ the diff is INERT. */
export type LaunchManifestKind = 'npm' | 'make' | 'none'

export interface LaunchManifest {
    kind: LaunchManifestKind
    /** The manifest the diff is taken against, for the failure text. '' when none. */
    file: string
    /** Entrypoint names the manifest exposes: npm script keys / Makefile targets. */
    names: string[]
    /** Why nothing is checkable (kind === 'none' only). */
    why?: string
}

/** GNU make's own lookup order, and nothing beyond it — this is one ecosystem. */
const MAKEFILE_NAMES = ['GNUmakefile', 'makefile', 'Makefile']

/** A target we are willing to name in a failure: an ordinary word-shaped target. */
const TARGET_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i

/**
 * A variable assignment, in every form make accepts (`=`, `:=`, `::=`, `?=`, `+=`,
 * `!=`, with an optional `override`/`export`). Matched BEFORE the target rule
 * because `FLAGS ::= -O2` otherwise reads as a target named `FLAGS`.
 */
const ASSIGN_RE = /^(?:override\s+|export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*(?:::|:|\?|\+|!)?=/

/**
 * The explicit targets a Makefile declares. Deliberately conservative — this list
 * only ever has to answer "does the project expose `migrate`", so a missed exotic
 * target costs a false FAIL and is the one error worth avoiding:
 *   • recipe lines (leading TAB) are skipped — they are shell, not targets;
 *   • `:=` / `::=` / `?=` / `+=` assignments are skipped;
 *   • pattern rules (`%.o: %.c`) and dot-targets (`.PHONY:`) fail TARGET_NAME_RE,
 *     which is also why the names listed AFTER `.PHONY:` are ignored here: they are
 *     prerequisites, and every one of them that is real is declared by its own rule.
 * Multiple targets on one line (`build test:`) all count.
 */
export function makeTargets(src: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
        if (raw.startsWith('\t') || raw.trim().length === 0 || raw.trimStart().startsWith('#'))
            continue
        if (ASSIGN_RE.test(raw)) continue
        const m = /^([^:#=]+):(?![=])/.exec(raw)
        if (!m) continue
        for (const tok of m[1].trim().split(/\s+/)) {
            if (!TARGET_NAME_RE.test(tok)) continue
            const key = tok.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            out.push(tok)
        }
    }
    return out
}

/**
 * The makefiles that really exist in `cwd`, in GNU make's lookup order, named as
 * the DIRECTORY spells them. `existsSync` cannot do this job: on a case-insensitive
 * filesystem (Windows, macOS) `existsSync('makefile')` is true for a `Makefile`, and
 * the failure text would then name a file the project does not have.
 */
function makefilesOnDisk(cwd: string): string[] {
    let entries: string[]
    try {
        entries = readdirSync(cwd)
    } catch {
        return []
    }
    const out: string[] = []
    for (const want of MAKEFILE_NAMES) {
        const hit = entries.find(e => e.toLowerCase() === want.toLowerCase())
        if (hit && !out.includes(hit)) out.push(hit)
    }
    return out
}

/**
 * Resolve the manifest the launch contract may be diffed against.
 *
 * A package.json that exists but does not parse resolves to `none`, not to "zero
 * scripts": diffing against a manifest you could not read is exactly the mistake
 * this module exists to stop, and a broken manifest is the static checks' business.
 */
export function readLaunchManifest(cwd: string): LaunchManifest {
    const pkg = path.join(cwd, 'package.json')
    if (existsSync(pkg)) {
        try {
            const j = JSON.parse(readFileSync(pkg, 'utf8')) as {scripts?: Record<string, string>}
            return {kind: 'npm', file: 'package.json', names: Object.keys(j.scripts ?? {})}
        } catch {
            return {kind: 'none', file: '', names: [], why: 'its package.json could not be parsed'}
        }
    }
    for (const name of makefilesOnDisk(cwd)) {
        try {
            return {
                kind: 'make',
                file: name,
                names: makeTargets(readFileSync(path.join(cwd, name), 'utf8'))
            }
        } catch {
            break
        }
    }
    return {kind: 'none', file: '', names: [], why: 'it has no npm manifest and no Makefile'}
}

/**
 * The one line an INERT contract leaves behind. It rides in the gate's UNOBSERVED
 * channel rather than in `warnings` for the reason nexttask 16A gives: a check that
 * silently did nothing must not read later as a check that passed.
 */
export function inertLaunchContractNote(declared: string[], manifest: LaunchManifest): string {
    return (
        `launch contract: ${declared.length} declared script(s) (${declared.join(', ')}) were recorded, `
        + `but this project could not be diffed against a manifest — ${manifest.why ?? 'no manifest'}. `
        + 'The contract was NOT checked here.'
    )
}
