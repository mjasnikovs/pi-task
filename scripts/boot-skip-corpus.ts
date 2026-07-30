/**
 * Shared corpus + isolation layer for the boot-skip verdict work (nexttask 1).
 *
 * WHAT IT ISOLATES, AND WHY. Both harnesses here run the REAL final gate, which
 * executes the project's own `lint` (`prettier --write` + `eslint --fix`), `build`
 * and `migrate`/`seed` scripts. Those WRITE. The corpus is evidence and must stay
 * byte-identical, so nothing ever runs in a source tree: each entry is
 * materialised into a throwaway copy first (`cp -a --reflink=auto` — the corpus
 * lives on btrfs, so a 241 MB mx5 copy including node_modules is a near-free CoW
 * clone) and the gate is pointed at the copy.
 *
 * THE DOCKER SHIM, DISCLOSED LOUDLY. mx5 run 18's boot skipped because its `dev`
 * script starts `docker compose` and the gate sandbox (/workspace) had no docker.
 * THIS box has docker 29.6.2 running, so an unmodified replay would BOOT mx5 for
 * real — starting containers on the user's machine and measuring an environment
 * that is not the one the defect happened in. So the harness prepends a shim dir
 * holding a `docker`/`docker-compose` that exits 127 with a command-not-found
 * message, reproducing the recorded sandbox exactly (127 inside the script chain
 * is the same env-gap branch run 18 took) and touching no real containers. The
 * mx5 Postgres container that IS up stays up — run 18's tests also ran against a
 * reachable database, so leaving it is the faithful condition, not a favour.
 *
 * FIXTURES. The four synthetic trees pin each invariant deterministically and
 * cost milliseconds: a real tree can drift (a dependency updates, a suite goes
 * flaky) and take the lever's only baseline hit with it. They are a supplement to
 * the real trees, never a replacement — generality is argued from the real ones.
 */
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync} from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type {FinalGateOutcome} from '../src/task/final-gate.js'

export const HUB = path.join(os.homedir(), 'hub')
export const REPO = path.resolve(import.meta.dir, '..')

/**
 * A scratch root on the SAME filesystem as the corpus. Deliberately not
 * os.tmpdir(): /tmp here is a 16 GB tmpfs, so cloning gofer (1.5 GB of
 * node_modules) and mx5 there would spend real RAM and silently lose the
 * `--reflink` fast path, which only works within one btrfs volume.
 */
export function makeWorkRoot(prefix: string): string {
    const base = path.join(os.homedir(), '.cache', 'pi-task-boot-skip')
    mkdirSync(base, {recursive: true})
    return mkdtempSync(path.join(base, `${prefix}-`))
}

/** How the gate's boot section ended for a tree. `none` = nothing to boot. */
export type BootClass = 'none' | 'pass' | 'fail' | 'skip' | 'orphan-port'

export interface CorpusEntry {
    label: string
    /** A real repo to clone, or a fixture built from scratch. */
    kind: 'repo' | 'fixture'
    /** kind 'repo': absolute source dir. kind 'fixture': the builder's key. */
    source: string
    /** kind 'repo': check the clone out at this commit (untracked files survive). */
    commit?: string
    /** Per-command ceiling. Lower on trees whose suites are LLM/network harnesses
     *  that would otherwise burn the wall clock; identical across both A/B arms, so
     *  it can shift a tree's verdict but never the DIFFERENCE the A/B measures. */
    timeoutMs?: number
    /**
     * A command run IN THE CLONE before the gate, to strip a known environment
     * artifact that has nothing to do with the boot check. Every use is disclosed in
     * the report and must be justified in `note` — this is the one place the harness
     * can lie to itself, so it stays visible rather than convenient.
     */
    prepare?: {argv: string[]; why: string}
    /** One line for the report — what this tree is here to prove. */
    note: string
}

/**
 * Real local trees. mx5 twice (post-autofix HEAD = the shipped defect, and the
 * pre-autofix commit = the same tree while the gate was still FAILing), then the
 * non-mx5 repos that carry the zero-FP burden.
 */
export const REPO_CORPUS: CorpusEntry[] = [
    {
        label: 'mx5@a9c6145 (run 18, post-autofix — the defect)',
        kind: 'repo',
        source: path.join(HUB, 'mx5'),
        note: 'boot `bun run dev` discovered, docker-less ⇒ skip; every other command passes'
    },
    {
        label: 'mx5@a9c6145 +ct-baselines (run 18, environment-normalised)',
        kind: 'repo',
        source: path.join(HUB, 'mx5'),
        prepare: {
            argv: ['bunx', 'playwright', 'test', '-c', 'playwright-ct.config.ts', '-u'],
            why: 'run 18 recorded its CT screenshot baselines in its own container; this box '
                + 'renders those pages 3px taller (1845 vs 1848), so 8 of 51 CT tests fail on '
                + 'font metrics alone. Re-capturing the baselines IN THE CLONE removes that '
                + 'environment difference and nothing else — no source file is touched, and '
                + 'the boot section is not involved either way.'
        },
        note: 'THE DEFECT, reproduced end to end: boot skips, everything else passes, gate PASSes'
    },
    {
        label: 'mx5@4880e79 (run 18, pre-autofix)',
        kind: 'repo',
        source: path.join(HUB, 'mx5'),
        commit: '4880e79',
        note: 'same boot skip, but the gate was still FAILing on 4 other findings'
    },
    {
        label: 'pi-task (self)',
        kind: 'repo',
        source: REPO,
        note: 'server-framework dep (ws) but NO start/dev script ⇒ nothing to boot'
    },
    {
        label: 'aiz-server',
        kind: 'repo',
        source: path.join(HUB, 'aiz-server'),
        timeoutMs: 180_000,
        note: 'express/ws ⇒ served app, boot `bun run start`'
    },
    {
        label: 'aiz-client',
        kind: 'repo',
        source: path.join(HUB, 'aiz-client'),
        timeoutMs: 180_000,
        note: 'boot `bun run dev` discovered but NO server dep ⇒ expectServer false'
    },
    {
        label: 'gofer',
        kind: 'repo',
        source: path.join(HUB, 'gofer'),
        timeoutMs: 60_000,
        note: 'no start/dev script ⇒ nothing to boot; test scripts are LLM evals'
    }
]

/** Trees whose gate is a no-op (nothing discoverable / nothing installed) but whose
 *  boot DISCOVERY still carries FP signal. Read-only, never executed. */
export const DISCOVERY_ONLY: Array<{label: string; dir: string; note: string}> = [
    {
        label: 'IAR1',
        dir: path.join(HUB, 'IAR1'),
        note: 'C++/CMake, no package.json ⇒ no boot command exists'
    },
    {
        label: 'godot-engine',
        dir: path.join(HUB, 'godot-engine'),
        note: 'package.json whose only script is `verify` ⇒ no boot command exists'
    }
]

/** The four fixtures, keyed by `source`. Each isolates ONE decision the lever makes. */
export const FIXTURE_CORPUS: CorpusEntry[] = [
    {
        label: 'fixture:served-boot-skip',
        kind: 'fixture',
        source: 'served-boot-skip',
        note: 'THE TARGET SHAPE — served app, boot discovered, boot skips, all else passes'
    },
    {
        label: 'fixture:served-boot-pass',
        kind: 'fixture',
        source: 'served-boot-pass',
        note: 'inv-boot-pass-untouched — served app whose boot really listens'
    },
    {
        label: 'fixture:cli-boot-skip',
        kind: 'fixture',
        source: 'cli-boot-skip',
        note: 'inv-cli-unaffected — boot discovered and skipped, but expectServer false'
    },
    {
        label: 'fixture:nothing-to-boot',
        kind: 'fixture',
        source: 'nothing-to-boot',
        note: 'inv-nothing-to-boot — served app with no start/dev script at all'
    }
]

/**
 * A `docker`/`docker-compose` that exits 127 like a missing binary, prepended to
 * PATH for this process and therefore for every gate child (runnerEnv derives the
 * child env from the live process.env). Reproduces run 18's sandbox; see the file
 * header for why this is the faithful environment rather than a convenience.
 */
export function installDockerlessShim(root: string): string {
    const dir = path.join(root, 'shim-bin')
    mkdirSync(dir, {recursive: true})
    for (const name of ['docker', 'docker-compose']) {
        const p = path.join(dir, name)
        writeFileSync(p, `#!/bin/sh\necho "${name}: command not found" >&2\nexit 127\n`)
        chmodSync(p, 0o755)
    }
    process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`
    return dir
}

/** Clone a real tree (CoW where the filesystem allows) or build a fixture. */
export function materialise(entry: CorpusEntry, dest: string): string {
    rmSync(dest, {recursive: true, force: true})
    mkdirSync(path.dirname(dest), {recursive: true})
    if (entry.kind === 'fixture') {
        buildFixture(entry.source, dest)
        return dest
    }
    const cp = spawnSync('cp', ['-a', '--reflink=auto', entry.source, dest], {encoding: 'utf8'})
    if (cp.status !== 0) throw new Error(`cp failed for ${entry.label}: ${cp.stderr}`)
    if (entry.commit) {
        // --force resets TRACKED files to the commit and leaves untracked ones
        // (.env, node_modules, playwright caches) in place — the pre-autofix tree
        // as the gate would have seen it, not a bare checkout.
        const co = spawnSync(
            'git',
            ['-c', 'advice.detachedHead=false', 'checkout', '--force', entry.commit],
            {cwd: dest, encoding: 'utf8'}
        )
        if (co.status !== 0) {
            throw new Error(`git checkout ${entry.commit} failed for ${entry.label}: ${co.stderr}`)
        }
    }
    if (entry.prepare) {
        console.log(`  PREPARE ${entry.prepare.argv.join(' ')}`)
        console.log(`    why: ${entry.prepare.why}`)
        const [bin, ...argv] = entry.prepare.argv
        const r = spawnSync(bin, argv, {cwd: dest, encoding: 'utf8', timeout: 600_000})
        console.log(`    exit ${r.status ?? 'null'}`)
    }
    return dest
}

/** A script that invokes a binary nothing on this box has → 127 inside the chain →
 *  the gate's env-gap branch, which is exactly how run 18's boot skipped. */
const MISSING_BIN_CMD = 'pi-task-no-such-binary-9f3c up && echo started'

function writeFixture(dir: string, pkg: unknown, extra: Record<string, string> = {}): void {
    mkdirSync(dir, {recursive: true})
    writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 4)}\n`)
    for (const [rel, body] of Object.entries(extra)) {
        writeFileSync(path.join(dir, rel), body)
    }
}

function buildFixture(key: string, dir: string): void {
    // `hono` in dependencies is what detectsServedApp reads — no install needed,
    // it is a manifest fact. No tsconfig/lint script, so the statics half reports
    // "nothing to check" and the fixtures isolate the dynamic half.
    const served = {hono: '4.12.27'}
    if (key === 'served-boot-skip') {
        writeFixture(dir, {
            name: 'fx-served-boot-skip',
            private: true,
            dependencies: served,
            scripts: {test: 'echo ok', build: 'echo built', dev: MISSING_BIN_CMD}
        })
        return
    }
    if (key === 'served-boot-pass') {
        writeFixture(
            dir,
            {
                name: 'fx-served-boot-pass',
                private: true,
                dependencies: served,
                scripts: {test: 'echo ok', build: 'echo built', start: 'bun run serve.ts'}
            },
            {
                // Honours PORT so the gate's private-port ownership probe can see it,
                // and stays up past the grace window like a real server.
                'serve.ts':
                    'const port = Number(process.env.PORT ?? 0)\n'
                    + 'Bun.serve({port, fetch: () => new Response("<h1>fixture</h1>", '
                    + '{headers: {"content-type": "text/html"}})})\n'
                    + 'setInterval(() => {}, 1000)\n'
            }
        )
        return
    }
    if (key === 'cli-boot-skip') {
        writeFixture(dir, {
            name: 'fx-cli-boot-skip',
            private: true,
            scripts: {test: 'echo ok', build: 'echo built', dev: MISSING_BIN_CMD}
        })
        return
    }
    if (key === 'nothing-to-boot') {
        writeFixture(dir, {
            name: 'fx-nothing-to-boot',
            private: true,
            dependencies: served,
            scripts: {test: 'echo ok', build: 'echo built'}
        })
        return
    }
    throw new Error(`unknown fixture: ${key}`)
}

/** Backticked command labels in a gate reason/failure line. */
function backticked(s: string): string[] {
    return [...s.matchAll(/`([^`]+)`/g)].map(m => m[1])
}

/**
 * How many NON-BOOT dynamic commands the gate actually observed — the counter that
 * suppressed run 18's full-skip guard. Derived from the outcome the gate already
 * publishes (the PASS reason names every command that ran; a FAIL names each
 * command that ran and exited non-zero), because the gate does not export the
 * counter itself and adding a field for measurement would change the very surface
 * the A/B compares. Mechanical, no judgement.
 */
export function deriveNonBootObserved(out: FinalGateOutcome, bootLabel: string | null): number {
    const labels = new Set<string>()
    const passList = /statics \+ (.*?) passed/.exec(out.reason)
    if (passList) for (const l of backticked(passList[1])) labels.add(l)
    for (const f of out.failures ?? []) {
        if (f.startsWith('boot check:')) continue
        for (const l of backticked(f)) labels.add(l)
    }
    if (bootLabel) labels.delete(bootLabel)
    return labels.size
}

/** PASS | UNOBSERVED | FAIL — the three-way verdict as the orchestrator reads it. */
export function verdictOf(out: FinalGateOutcome): 'PASS' | 'UNOBSERVED' | 'FAIL' {
    if (!out.ok) return 'FAIL'
    return out.unobserved ? 'UNOBSERVED' : 'PASS'
}
