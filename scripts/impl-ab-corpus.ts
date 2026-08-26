/**
 * The implementation-turn A/B's corpus: which recorded mx5 tasks can actually
 * serve as a trial, and what their pre/post trees are.
 *
 * Kept separate from the harness so the SELECTION can be inspected — and
 * pre-flighted — without spending a second of GPU. Every function here is
 * deterministic and model-free.
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// The repo's own section reader, not a second one. A hand-rolled copy of this
// returned undefined for every task and silently produced a 0-task corpus.
import {readSection} from './ab-corpus.js'

export const MX5 = process.env.AB_CORPUS ?? path.join(os.homedir(), 'hub', 'mx5')

export interface ImplTask {
    id: string
    /** The decompose title, as the commits record it. */
    title: string
    /** `chore: checkpoint before "<title>"` — the tree the turn STARTED from. */
    preCommit: string
    /** `task: <title> (id)` — the tree the real turn PRODUCED. */
    postCommit: string
    /** The `## spec` the turn was handed. */
    spec: string
    /** The task's own VERIFY script, extracted from its refined prompt. */
    verify: string
}

/** `git log` once, parsed into the two commit families that bracket a turn. */
function commitPairs(): Map<string, {pre: string; post: string; title: string}> {
    const log = execFileSync('git', ['log', '--format=%H\t%s'], {
        cwd: MX5,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    })
    const checkpoints = new Map<string, string>()
    const completions = new Map<string, {hash: string; title: string}>()
    for (const line of log.split('\n')) {
        const tab = line.indexOf('\t')
        if (tab < 0) continue
        const hash = line.slice(0, tab)
        const subject = line.slice(tab + 1)
        const c = /^chore: checkpoint before "(.*)"$/.exec(subject)
        // `log` is newest-first and a title can repeat across retries; keep the
        // FIRST seen, which pairs a completion with its own checkpoint.
        if (c?.[1] && !checkpoints.has(c[1])) checkpoints.set(c[1], hash)
        const d = /^task: (.*) \((TASK_\d+)\)$/.exec(subject)
        if (d?.[1] && d[2] && !completions.has(d[2])) {
            completions.set(d[2], {hash, title: d[1]})
        }
    }
    const out = new Map<string, {pre: string; post: string; title: string}>()
    for (const [id, {hash, title}] of completions) {
        const pre = checkpoints.get(title)
        // A completion with no checkpoint has no defined starting tree, so it
        // cannot be a trial. Dropped rather than started from something near it.
        if (pre) out.set(id, {pre, post: hash, title})
    }
    return out
}

/**
 * The executable VERIFY script, or undefined.
 *
 * 56 of 57 recorded tasks carry a `VERIFY:` heading followed by a shell fence;
 * the one without simply cannot be scored and is dropped. Never synthesise one —
 * a scorer nobody wrote is a scorer nobody can trust.
 */
export function verifyScript(doc: string): string | undefined {
    const m = /VERIFY[^\n]*\n+```(?:sh|bash)\n([\s\S]*?)```/.exec(doc)
    return m?.[1]?.trim() || undefined
}

/** Every recorded task that has both trees and a runnable scorer. */
export function implTasks(): ImplTask[] {
    const pairs = commitPairs()
    const dir = path.join(MX5, '.pi-tasks')
    const out: ImplTask[] = []
    for (const file of fs.readdirSync(dir).sort()) {
        const id = /^(TASK_\d+)\.md$/.exec(file)?.[1]
        if (!id) continue
        const pair = pairs.get(id)
        if (!pair) continue
        const doc = fs.readFileSync(path.join(dir, file), 'utf8')
        const spec = readSection(doc, 'spec')
        const verify = verifyScript(doc)
        if (!spec || !verify) continue
        out.push({id, title: pair.title, preCommit: pair.pre, postCommit: pair.post, spec, verify})
    }
    return out
}

/** Extract one commit's tree into `dir`, with node_modules linked in. */
export function extractTree(commit: string, dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    const tar = execFileSync('git', ['archive', '--format=tar', commit], {
        cwd: MX5,
        maxBuffer: 512 * 1024 * 1024
    })
    execFileSync('tar', ['-x', '-C', dir], {input: tar, maxBuffer: 512 * 1024 * 1024})
    // A read-only view of the real install: re-installing per trial would cost
    // more than the model turn and would not be the same tree twice.
    const nm = path.join(dir, 'node_modules')
    if (!fs.existsSync(nm) && fs.existsSync(path.join(MX5, 'node_modules'))) {
        fs.symlinkSync(path.join(MX5, 'node_modules'), nm, 'dir')
    }
}

export interface VerifyOutcome {
    pass: boolean
    exitCode: number
    output: string
}

/** Run a task's VERIFY script in a tree. Never throws; a crash is a FAIL. */
export function runVerify(script: string, cwd: string, timeoutMs = 180_000): VerifyOutcome {
    const file = path.join(cwd, '.ab-verify.sh')
    fs.writeFileSync(file, script, 'utf8')
    try {
        const out = execFileSync('bash', [file], {
            cwd,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        return {pass: true, exitCode: 0, output: out.slice(-2000)}
    } catch (e) {
        const err = e as {status?: number; stdout?: string; stderr?: string; message?: string}
        return {
            pass: false,
            exitCode: err.status ?? -1,
            output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.slice(-2000)
        }
    } finally {
        fs.rmSync(file, {force: true})
    }
}
