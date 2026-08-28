/**
 * GROUND TRUTH FOR `research:tooling`: is a command the worker emitted actually
 * runnable in the tree it was asked about?
 *
 * WHY THIS AXIS AND NOT A TEXT PROPERTY. worker:tooling's contract is
 * `<category>  <exact command to invoke>` and its prompt says "Use exact
 * commands, not guesses. If a tool isn't present in the repo, omit it — don't
 * invent." So the job has a truth on disk, and it is not a judgement call: a
 * command naming a package.json script that does not exist does not run. That
 * is the same shape as gate's axis (execute the tree's own VERIFY) and the
 * opposite of the four dead `phase` axes, every one of which scored a property
 * of the TEXT.
 *
 * VERIFIED BY EXECUTION, not by reading. `bun run dev` — the single most common
 * entry in this corpus's recorded tooling blocks — was run in an extracted
 * TASK_0010 before-tree and printed `error: Script not found "dev"`, exit 1.
 * The tree's scripts are `lint` and `test` at every commit checked, and there is
 * no `dev` file. The check is right and the recorded answer is wrong.
 *
 * `unknown` IS A FIRST-CLASS ANSWER and is scored neither way. Three of the four
 * shapes below can only ever return `real` or `unknown`: an undeclared binary
 * may still be on PATH, and a bare `bun test` resolves through the runtime, not
 * the manifest. Guessing there would be the loose scorer that is harder to spot
 * than a strict one ([[ab-scorer-must-match-the-real-prompt]]), and a fixed
 * ecosystem allowlist is already a recorded defect here
 * ([[gate-blind-on-non-npm-projects]]). MEASURED over the corpus's 217 recorded
 * commands: 95 unknown-other, 69 real-binary, 24 real-file, 28 run-arg — and
 * ALL 16 inventions are in the run-arg branch. The axis's teeth are there.
 */
import {execFileSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {join as pathJoin} from 'node:path'
import {MX5} from './impl-ab-corpus.js'

export type CmdVerdict = 'real' | 'invented' | 'unknown'

export interface CmdOutcome {
    verdict: CmdVerdict
    why: string
    /** The token the verdict turned on — what a floor test must break. */
    token?: string
}

/** `git show <commit>:<path>`, or undefined. Never throws. */
export function fileAt(commit: string, p: string, cwd: string = MX5): string | undefined {
    try {
        return execFileSync('git', ['show', `${commit}:${p}`], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        })
    } catch {
        return undefined
    }
}

/**
 * Is there an INSTALLED binary by this name?
 *
 * `bun run <name>` does not only look up a package.json script — when no script
 * matches it falls back to `node_modules/.bin`. VERIFIED BY EXECUTION in the
 * corpus tree: `bun run tsc --version` printed `Version 6.0.3` and exited 0,
 * while `bun run dev` printed `error: Script not found "dev"` and exited 1.
 *
 * A checker that did not know this called `bun run tsc --noEmit`,
 * `bun run eslint --fix .` and `bun run playwright test` INVENTED. It cost two
 * trials in the MEDIUM arm of the first live run before the fix; both were
 * recovered by rescoring the stored text, which is what the ledger is for.
 *
 * The install read is the CURRENT one, and for a TRIAL that is the right one:
 * `extractTree` symlinks this same node_modules into every trial tree, so it is
 * literally what the child had.
 *
 * IT IS ANACHRONISTIC ON THE HISTORICAL ROWS — the STEP-0 ceiling and the
 * recorded-answer scoring both run over ~45 commits spanning the project's
 * history, where a binary installed late reads as installed for an early tree.
 * The error is in the LOOSE direction (a real-looking bin that was not there
 * yet), so it can only inflate the ceiling, never manufacture an invention. Not
 * worth a per-commit reinstall; worth knowing before quoting a STEP-0 number.
 */
const binCache = new Map<string, boolean>()
export function hasInstalledBin(name: string, cwd: string = MX5): boolean {
    if (name === '' || name.includes('/')) return false
    const key = `${cwd}\u0000${name}`
    const hit = binCache.get(key)
    if (hit !== undefined) return hit
    const ok = existsSync(pathJoin(cwd, 'node_modules', '.bin', name))
    binCache.set(key, ok)
    return ok
}

/** Bin names whose package is not the bin name. */
const BIN_PKG: Record<string, string> = {tsc: 'typescript', eslint: 'eslint'}

/**
 * One shell line split at its command separators, so every command on a
 * compound line is adjudicated instead of only the first.
 *
 * Deliberately crude — `&&`, `||`, `;`, `|` as whole tokens, plus the same
 * operators glued to a neighbour, which is how they are actually typed. It does
 * not parse quotes, and it does not need to: the only caller looks for the
 * literal token `run` after a known package runner.
 */
function splitSegments(tok: string[]): string[][] {
    const out: string[][] = [[]]
    for (const raw of tok) {
        const parts = raw.split(/(?:&&|\|\||;|\|)/)
        parts.forEach((part, i) => {
            if (i > 0) out.push([])
            if (part !== '') out.at(-1)!.push(part)
        })
    }
    return out.filter(seg => seg.length > 0)
}

export function classifyCommand(cmd: string, commit: string, cwd: string = MX5): CmdOutcome {
    const c = cmd.trim().replace(/^[-*]\s*/, '')
    if (c === '') return {verdict: 'unknown', why: 'blank'}
    const tok = c.split(/\s+/)
    let scripts: Record<string, string> = {}
    let deps: Record<string, string> = {}
    const pkgRaw = fileAt(commit, 'package.json', cwd)
    if (pkgRaw) {
        try {
            const j = JSON.parse(pkgRaw) as Record<string, Record<string, string> | undefined>
            scripts = j.scripts ?? {}
            deps = {...(j.dependencies ?? {}), ...(j.devDependencies ?? {})}
        } catch {
            /* a malformed manifest is an unknown, not an invention */
        }
    }
    // `<runner> run <arg>` — the one shape with an exact, checkable truth, and
    // the only one that ever returns `invented`.
    //
    // EVERY `run` ON THE LINE, not the first. A TOOLING entry is routinely a
    // compound — `bun run lint && bun run dev` — and reading only the first
    // `run` scored that line `real` on `scripts.lint` while `dev` (the exact
    // failure class the research:tooling cell was decided on: seven arms naming
    // a dev-server script the manifest does not have) went unadjudicated. A
    // loose scorer is the harder-to-spot half of [[ab-scorer-must-match-the-real-prompt]],
    // so any invented segment condemns the line and the first one wins the `why`.
    let lastRun: CmdOutcome | undefined
    for (const seg of splitSegments(tok)) {
        const runIdx = seg.findIndex(t => t === 'run')
        if (runIdx <= 0 || !['npm', 'bun', 'pnpm', 'yarn'].includes(seg[0]!)) continue
        // SKIP THE RUNNER'S OWN FLAGS: `npm run --silent lint` puts one exactly
        // where the naive reader looked for the target.
        let a = runIdx + 1
        while (seg[a]?.startsWith('-')) a += 1
        const arg = seg[a]
        const outcome: CmdOutcome =
            arg === undefined ? {verdict: 'unknown', why: 'no target after run'}
            : arg in scripts ? {verdict: 'real', why: `scripts.${arg}`, token: arg}
                // `bun run <file.ts>` is a FILE invocation, not a script lookup.
                // The first version of this checker called every one of them
                // invented, and four of its twelve reported failures were its
                // own bug.
            : fileAt(commit, arg.replace(/^\.\//, ''), cwd) !== undefined ?
                {verdict: 'real', why: `${arg} is a file`, token: arg}
            : hasInstalledBin(arg, cwd) ?
                {verdict: 'real', why: `node_modules/.bin/${arg}`, token: arg}
            :   {verdict: 'invented', why: `no scripts.${arg}, no file, no installed bin`}
        if (outcome.verdict === 'invented') return outcome
        lastRun = lastRun ?? outcome
    }
    if (lastRun) return lastRun
    const xIdx =
        tok[0] === 'bunx' || tok[0] === 'npx' ? 0
        : tok[0] === 'bun' && tok[1] === 'x' ? 1
        : -1
    if (xIdx >= 0 && tok[xIdx + 1]) {
        const bin = tok[xIdx + 1]!
        const pkg = BIN_PKG[bin] ?? bin
        if (pkg in deps) return {verdict: 'real', why: `dependency ${pkg}`, token: bin}
        if (hasInstalledBin(bin, cwd)) {
            return {verdict: 'real', why: `node_modules/.bin/${bin}`, token: bin}
        }
        return {verdict: 'unknown', why: `binary ${bin} is neither declared nor installed`}
    }
    // `-f <path>` IS A COMPOSE FILE ONLY WHEN A COMPOSE TOKEN PRECEDES IT. Read
    // as a bare token anywhere on the line it is just a flag, and the checker
    // called `curl -f http://localhost:3000/health` an invented path (`http://…`
    // is not in the tree) and `git clean -f -d` an invented path (`-d` is not in
    // the tree). Both are entirely plausible TOOLING entries, and both were
    // scored as inventions against whichever arm emitted them — the strict
    // direction of the same bug this file has now fixed three times.
    //
    // ANCHORED ON `compose`, NOT ON `tok[0]`. The first attempt at this fix
    // required the line to START with the runner and lost five real rows: a
    // TOOLING entry is routinely `container<TAB>docker compose -f …` (a single
    // tab is not the two-space gap, so the label stays on the command) or a
    // prose bullet quoting the command. Both still name a compose file; neither
    // starts with `docker`.
    const composeIdx = tok.findIndex(t => t === 'compose' || t === 'docker-compose')
    const fIdx = composeIdx >= 0 ? tok.indexOf('-f', composeIdx) : -1
    if (fIdx >= 0 && tok[fIdx + 1]) {
        const f = tok[fIdx + 1]!
        return fileAt(commit, f, cwd) !== undefined ?
                {verdict: 'real', why: `${f} exists`, token: f}
            :   {verdict: 'invented', why: `${f} not in tree`}
    }
    if (tok[0]!.startsWith('./') || tok[0]!.startsWith('scripts/')) {
        const f = tok[0]!.replace(/^\.\//, '')
        return fileAt(commit, f, cwd) !== undefined ?
                {verdict: 'real', why: `${f} exists`, token: tok[0]!}
            :   {verdict: 'invented', why: `${tok[0]} not in tree`}
    }
    return {verdict: 'unknown', why: 'not a checkable shape'}
}

/**
 * The commands in a TOOLING block.
 *
 * Production's own rule (`extractToolingCommands`, phases.ts): the tail after a
 * two-space gap when there is one, the whole line otherwise, and a `(none — …)`
 * placeholder is not a command.
 */
export function toolingCommands(block: string): string[] {
    const out: string[] = []
    for (const raw of block.split('\n')) {
        const line = raw.trim()
        // PRODUCTION'S RULE, character for character: only the two placeholder
        // markers are dropped. `startsWith('(')` also swallowed a real command
        // in a subshell — `(cd server && bun test)` — which production hands
        // straight to the verify-tooling child.
        if (line === '' || /^\((?:none —|degraded:)/.test(line)) continue
        const m = /^\S.*?\s{2,}(.+)$/.exec(line)
        out.push((m?.[1] ?? line).trim())
    }
    return out
}

export interface ToolingScore {
    /** Commands the checker could adjudicate either way. */
    checkable: number
    invented: string[]
    unknown: number
}

export function scoreTooling(text: string, commit: string, cwd: string = MX5): ToolingScore {
    const cmds = toolingCommands(text)
    const scored = cmds.map(c => ({c, v: classifyCommand(c, commit, cwd)}))
    return {
        checkable: scored.filter(s => s.v.verdict !== 'unknown').length,
        invented: scored.filter(s => s.v.verdict === 'invented').map(s => s.c),
        unknown: scored.filter(s => s.v.verdict === 'unknown').length
    }
}

/**
 * THE AXIS: the worker named at least one command the checker can adjudicate,
 * and none of the adjudicable ones is an invention.
 *
 * Requiring one checkable command is not a shape check sneaking back in. An
 * answer of only unadjudicable lines is one this axis cannot see, and scoring it
 * TRUE would make "emit nothing checkable" the highest-scoring strategy — the
 * same vacuous-truth hole `filesGrounded` closes by rejecting an answer that
 * names no path.
 */
export function toolingRunnable(text: string, commit: string, cwd: string = MX5): boolean {
    const s = scoreTooling(text, commit, cwd)
    return s.checkable > 0 && s.invented.length === 0
}

export interface ToolingStimulus {
    id: string
    /** The tree the worker inspects — the same tree the real worker inspected. */
    beforeCommit: string
    /** The `## refined prompt` the real TOOLING worker's goal was scoped from. */
    refined: string
    /** What the RECORDED answer scored, carried for the screen's report only. */
    recorded: {checkable: number; invented: number}
}

export interface ToolingScreenOutcome {
    id: string
    usable: boolean
    detail: string
}

/**
 * Which tasks can be a tooling stimulus.
 *
 * THE SCREEN IS ON THE TREE, NOT ON THE RECORDED ANSWER, and that is deliberate.
 * `filesStimuli` keeps only tasks whose own recorded FILES section scores 100%,
 * because there the answer varies with the task and a task whose known-good
 * answer misses would score correct work wrong. Tooling is the opposite: the
 * repo's scripts are the same in every task, so an invented `bun run dev` is a
 * property of the MODEL, not of the task. Screening on the recorded answer would
 * drop exactly the tasks where the failure mode appears — selecting for a
 * ceiling. MEASURED: 13 of 45 recorded blocks carry an invention, all of them
 * `bun run dev` / `bun run build`, and `bun run dev` was executed in an
 * extracted TASK_0010 tree and printed `error: Script not found "dev"`.
 *
 * What the tree must supply is the ability to EXHIBIT the axis: a package.json
 * with at least one script, so a `<runner> run <arg>` command is adjudicable
 * either way. A tree without one leaves the axis blind and the trial vacuous.
 */
export function toolingStimuli(opts: {
    tasks: ReadonlyArray<{id: string; preCommit: string}>
    refinedPrompt: (id: string) => string | undefined
    recordedTooling: (id: string) => string | undefined
    limitTasks?: number
    cwd?: string
}): {stimuli: ToolingStimulus[]; screened: ToolingScreenOutcome[]} {
    const cwd = opts.cwd ?? MX5
    const screened: ToolingScreenOutcome[] = []
    const stimuli: ToolingStimulus[] = []
    for (const t of opts.tasks) {
        if (opts.limitTasks !== undefined && stimuli.length >= opts.limitTasks) break
        const refined = opts.refinedPrompt(t.id)?.trim()
        if (!refined) {
            screened.push({id: t.id, usable: false, detail: 'no recorded refined prompt'})
            continue
        }
        const pkgRaw = fileAt(t.preCommit, 'package.json', cwd)
        let scriptCount: number
        try {
            const j = JSON.parse(pkgRaw ?? '{}') as {scripts?: Record<string, string>}
            scriptCount = Object.keys(j.scripts ?? {}).length
        } catch {
            scriptCount = 0
        }
        if (scriptCount === 0) {
            screened.push({
                id: t.id,
                usable: false,
                detail: 'before-tree has no package.json scripts — the axis cannot be exhibited'
            })
            continue
        }
        const block = opts.recordedTooling(t.id)
        const rec = block ? scoreTooling(block, t.preCommit, cwd) : undefined
        screened.push({
            id: t.id,
            usable: true,
            detail:
                `${scriptCount} script(s) in the before-tree; recorded answer `
                + (rec ?
                    `${rec.checkable - rec.invented.length}/${rec.checkable} runnable`
                    + (rec.invented.length > 0 ? ` — ${rec.invented.join(', ')}` : '')
                :   'not recorded')
        })
        stimuli.push({
            id: t.id,
            beforeCommit: t.preCommit,
            refined,
            recorded: {checkable: rec?.checkable ?? 0, invented: rec?.invented.length ?? 0}
        })
    }
    return {stimuli, screened}
}
