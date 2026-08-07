/**
 * launch-config-gap — a launch script that cannot run because a variable the
 * project's own tracked template DECLARES is absent from this box is an
 * ENVIRONMENT GAP, not a code fault (mx5 run 20).
 *
 * THE EPISODE. Attempt 3 of the final-gate autofix passed every guard, fixed the
 * failing test, and still lost the run:
 *
 *     autofix attempt 3 failed — did not converge: launch script: `bun run seed`
 *     exited 1 — $ bun run src/server/seed.ts  Missing required environment
 *     variable: ADMIN_PHONE  error: script "seed" exited with code 1
 *
 * Single-failure phrasing (final-gate.ts uses a numbered list for ≥2), so the
 * suite was green and this was the only remaining failure. The run failed on
 * exactly this, and it is self-inflicted at the last moment: pre-gate
 * `package.json` had no `seed` script at all, so `if (!present.has(name)) continue`
 * skipped it. Attempt 3 added the script to clear the launch-contract diff — and
 * thereby armed the check that killed the run.
 *
 * The loop was closed by construction. The gate runs every declared non-boot
 * script with `runnerEnv(runner)` = `process.env` plus a PATH prefix and nothing
 * else; "Missing required environment variable" matches neither ENV_GAP_OUTPUT_RE
 * nor INFRA_GAP_OUTPUT_RE, so it is a hard FAIL; and the only way to supply the
 * value is a gitignored `.env`, whose writes nexttask 4 correctly refuses to
 * credit. The static half of this already shipped and WORKED — `.env.example`
 * declares ADMIN_PHONE/ADMIN_PASSWORD, so `findMissingEnvDeclarations` was
 * correctly silent. This is the execution half.
 *
 * FOUR STATIC CONDITIONS, ALL REQUIRED. Deliberately over-constrained: the
 * failure mode of getting this wrong is a gate that excuses real breakage.
 *
 *   1. the script's resolved body names a TRACKED SOURCE FILE
 *      (`bun run src/server/seed.ts` → `src/server/seed.ts`);
 *   2. that file REQUIRES an env var `X` under `scanSource` — i.e. none of its
 *      step-asides (default / compared / assigned / ambient / …) applies;
 *   3. `X` is DECLARED in the tracked template. If it is NOT,
 *      `findMissingEnvDeclarations` has already failed the gate statically and
 *      this path must not fire — otherwise the two checks would cancel out and a
 *      project with no template at all would gain a blanket excuse;
 *   4. `X` is ABSENT from the env the gate spawned the child with.
 *
 * NOTHING IS PARSED FROM THE CHILD'S STDERR. `Missing required environment
 * variable: ADMIN_PHONE` is a string the PROJECT authored; matching on it would
 * be a rule about one project's phrasing, and every other project would phrase it
 * differently or not at all.
 *
 * THE FIFTH CONDITION IS DYNAMIC, AND IT IS WHAT MAKES THE RULE HONEST. The four
 * above cannot tell "exited BECAUSE the variable is absent" from "exited for its
 * own reasons, and also happens to read an absent variable". A script that throws
 * a TypeError on line 1 and also reads ADMIN_PHONE on line 3 satisfies all four.
 * So the script is re-run once with the gap variables supplied as OBVIOUSLY
 * SYNTHETIC placeholders, and the exit code decides:
 *
 *     still non-zero → the absence did not cause it → FAIL, as today
 *     now zero       → the absence did cause it     → skip + UNOBSERVED + debt
 *
 * The probe run is a DIAGNOSTIC, never an observation. Its success is not
 * reported, and the verdict it produces is UNOBSERVED with debt — never a PASS
 * (memory/unobserved-gate-verdict-shipped.md). The placeholder is a fixed
 * harness-authored string; `.env.example`'s own values are never injected,
 * because they are placeholders too (`change-me`) and a green seed run against
 * them would be a fabricated observation.
 */
import {readFileSync} from 'node:fs'
import * as path from 'node:path'
import {scanSource, type EnvRead} from './env-template-closure.js'

/** What a launch script needs that this box does not have. */
export interface LaunchConfigGap {
    /** Declared script name, e.g. `seed`. */
    script: string
    /** The tracked source file the script body runs. */
    file: string
    /** Variables it REQUIRES that the template declares and the env lacks. */
    variables: string[]
    /** First read site per variable, for the debt line. */
    reads: EnvRead[]
}

/**
 * The value the probe run supplies. Obviously synthetic and obviously ours, so a
 * seeded row or a log line carrying it is recognisable as harness residue rather
 * than mistaken for real configuration.
 */
export const CONFIG_GAP_PROBE_VALUE = 'pi-task-config-gap-probe'

/** Shell operators that separate commands inside a script body. */
const SEPARATORS = /[\s;|&()<>]+/

/**
 * The tracked source files a script body runs. Purely lexical and deliberately
 * so: every whitespace/operator-separated token, normalised, that the tracked set
 * contains. A token that is not a tracked file (a flag, the runner, a bare word)
 * cannot match, and a body that names no tracked file yields nothing — which
 * fails condition 1 and ends the check.
 */
export function bodySourceFiles(body: string, tracked: ReadonlySet<string>): string[] {
    const out: string[] = []
    for (const raw of body.split(SEPARATORS)) {
        const tok = raw
            .trim()
            .replace(/^["']|["']$/g, '')
            .replace(/^\.\//, '')
        if (tok.length === 0) continue
        if (tracked.has(tok) && !out.includes(tok)) out.push(tok)
    }
    return out
}

/**
 * The static half: conditions 1–4. Returns null when ANY of them fails, which is
 * the common case and means "behave exactly as before".
 *
 * `declared` is the union of every tracked template's variables. When it is empty
 * the tree has no template, condition 3 can never hold, and this always returns
 * null — a project with no template gains no excuse.
 */
export function findLaunchConfigGap(args: {
    cwd: string
    script: string
    /** Resolved script body (`packageScripts(cwd)[name]`), or null. */
    body: string | null
    /** Tracked files, repo-relative (`trackedFiles(cwd)`). */
    tracked: readonly string[]
    /** Variables the tracked env template(s) declare. */
    declared: ReadonlySet<string>
    /** The env the gate spawned (or would spawn) the child with. */
    env: Record<string, string | undefined>
}): LaunchConfigGap | null {
    if (!args.body || args.declared.size === 0) return null
    const trackedSet = new Set(args.tracked)
    const files = bodySourceFiles(args.body, trackedSet)
    if (files.length === 0) return null // condition 1

    const variables: string[] = []
    const reads: EnvRead[] = []
    let file: string | null = null
    for (const f of files) {
        let text: string
        try {
            text = readFileSync(path.join(args.cwd, f), 'utf8')
        } catch {
            continue
        }
        for (const r of scanSource(f, text)) {
            if (r.stepAside !== null) continue // condition 2: REQUIRED only
            if (!args.declared.has(r.name)) continue // condition 3: template declares it
            if (args.env[r.name] !== undefined) continue // condition 4: absent here
            if (variables.includes(r.name)) continue
            variables.push(r.name)
            reads.push(r)
            file ??= f
        }
    }
    if (variables.length === 0 || file === null) return null
    return {script: args.script, file, variables, reads}
}

/** The env for the probe re-run: the gate's own env plus a synthetic value per
 *  gap variable. Nothing else changes, so a second non-zero exit is the script's
 *  own fault and not the harness's. */
export function probeEnv(
    base: Record<string, string | undefined>,
    gap: LaunchConfigGap
): Record<string, string | undefined> {
    const out = {...base}
    for (const v of gap.variables) out[v] = CONFIG_GAP_PROBE_VALUE
    return out
}

/** The UNOBSERVED warning: names the script and every variable, so a human can
 *  supply them and re-run by hand. */
export function configGapUnobservedNote(gap: LaunchConfigGap): string {
    const site = gap.reads[0]
    return (
        `launch script \`${gap.script}\` could not run here — ${gap.file}`
        + `${site ? `:${site.line}` : ''} requires ${gap.variables.map(v => `\`${v}\``).join(', ')}, `
        + `which the tracked env template DECLARES but this environment does not supply. `
        + `Re-running it with the value(s) present exits 0, so the failure is a CONFIG GAP, not a `
        + `code fault — UNOBSERVED: the launch surface was not exercised here. Supply `
        + `${gap.variables.join(', ')} and run \`bun run ${gap.script}\` to observe it.`
    )
}
