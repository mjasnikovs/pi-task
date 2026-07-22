/**
 * ASSERTED STRING SURGERY over a private copy of `dist/`, so both arms of PROMPT 4's A/B run
 * in ONE process against genuinely different code.
 *
 * WHY A DIST COPY AND NOT AN INJECTION HOOK. nexxtasks is explicit: "baseline = shipped
 * worker:apis, spec-URL extraction stripped by ASSERTED string surgery, verified absent at
 * runtime, not assumed." An `if (opts.leverOff)` parameter would be a different thing — the
 * baseline would then be exercising a code path that does not exist in production, and the
 * lever's absence would be something the harness *configured* rather than something it
 * *removed*. phaseResearch is not parameterised and ESM imports cannot be monkey-patched, so
 * the surgery has to happen on the module text before it is loaded. Copying dist/ into a
 * scratch tree inside the repo keeps node_modules resolution working (resolution walks up to
 * the repo root) and lets both variants be `import()`ed side by side in the same process.
 *
 * THE ASSERTIONS ARE THE POINT. A string replacement that silently matches nothing produces a
 * baseline arm identical to the treatment arm and an A/B that can only report "no effect" —
 * the most expensive possible failure mode, because it looks like a result. So every edit
 * asserts its anchor occurs EXACTLY ONCE before replacing, and the caller additionally
 * verifies the effect at runtime against the loaded module.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const DIST = path.join(REPO, 'dist')
/** Inside the repo so `import()`ed modules still resolve node_modules by walking up. */
const SCRATCH = path.join(REPO, '.ab-dist')

export interface Surgery {
    /** dist-relative file, e.g. `task/phases.js`. */
    file: string
    /** Must occur EXACTLY ONCE in that file, or the surgery throws. */
    find: string
    replace: string
    /** Printed in the banner so a run's arms are self-describing. */
    label: string
}

/**
 * Copy `dist/` to `.ab-dist/<name>/`, apply every surgery, and return the copy's root.
 * Throws — never warns — when an anchor is missing or ambiguous.
 */
export function buildPatchedDist(name: string, surgeries: Surgery[]): string {
    if (!fs.existsSync(DIST)) {
        throw new Error(`dist/ not built — run \`bun run build\` first (${DIST})`)
    }
    const root = path.join(SCRATCH, name)
    fs.rmSync(root, {recursive: true, force: true})
    fs.mkdirSync(SCRATCH, {recursive: true})
    fs.cpSync(DIST, root, {recursive: true})

    for (const s of surgeries) {
        const target = path.join(root, s.file)
        if (!fs.existsSync(target)) {
            throw new Error(`surgery "${s.label}": ${s.file} does not exist in dist/`)
        }
        const before = fs.readFileSync(target, 'utf8')
        const occurrences = before.split(s.find).length - 1
        if (occurrences !== 1) {
            throw new Error(
                `surgery "${s.label}": anchor occurs ${occurrences} time(s) in ${s.file}, `
                    + `expected exactly 1. A silent no-op here makes both arms identical and the `
                    + `A/B unreadable, so this is fatal.\n  anchor: ${s.find.slice(0, 200)}`
            )
        }
        fs.writeFileSync(target, before.replace(s.find, s.replace), 'utf8')
    }
    return root
}

/** Remove every patched copy. Safe to call when none exist. */
export function cleanPatchedDists(): void {
    fs.rmSync(SCRATCH, {recursive: true, force: true})
}

/**
 * Redirect the APIS worker's search/fetch extension to the offline stub. Applied to BOTH
 * arms identically, so it cannot bias the comparison — it only takes the live network out.
 *
 * The anchor is the expression phases.ts uses to locate the shipped extension. tsc emits it
 * essentially verbatim; if a future build changes the emit, the exactly-once assertion fires
 * rather than the run quietly measuring a live-network baseline against a stubbed treatment.
 */
export function stubSearchExtension(stubPath: string): Surgery {
    return {
        file: 'task/phases.js',
        find: `fileURLToPath(new URL('../workers/search-extension.js', import.meta.url))`,
        replace: JSON.stringify(stubPath),
        label: 'search/fetch extension -> offline stub'
    }
}

export {DIST, REPO, SCRATCH}
