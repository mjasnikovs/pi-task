/**
 * LIVE SMOKE: does each group's resolved level actually reach the CHILD'S ARGV?
 *
 * The unit tests assert the table and the argv builder. Neither can see the
 * thing that goes wrong in the field: a resolution that never reaches a spawn,
 * or a config MODE that silently replaces the whole table. This spawns real pi
 * children through both production spawn paths and reads the argv off the wire.
 *
 * HOW IT SEES THE ARGV. `PI_BIN` is pi-task's own test/dev override for the
 * child binary (pi-invocation.ts), so the smoke points it at a generated shim
 * that appends `"$@"` to a log and then execs the real pi. Nothing in src/ is
 * touched, and the argv recorded is the argv the model server's client saw.
 *
 * BOTH SPAWN PATHS, because they resolve the group differently and a smoke that
 * covers one proves nothing about the other:
 *   runWorker      gate / research / extraction — the group is passed at the
 *                  CALL SITE (gate-deps.ts, phases.ts, docs-core.ts, …)
 *   runPhaseChild  refine / auto-decompose / plan-question — the group is looked
 *                  up from the CHILD NAME (reasoning-groups.ts)
 *
 * IT ABSTAINS WHEN THE TABLE IS NOT LIVE. `resolveReasoning` switches on
 * `reasoningMode` BEFORE it reads the table: `on` forces every group to
 * REASONING_ON_LEVEL, `off` forces every group to `off`, `custom` reads the
 * user's own levels. Only `default` consults the measured table. Found the hard
 * way — the first run of this smoke reported `--thinking medium` for all six
 * groups on a machine whose config said `"reasoningMode": "on"`, which is
 * CORRECT behaviour and looks exactly like a broken table.
 *
 * THE `inherit` CASE is proved by ABSENCE: `plan` must carry no `--thinking` at
 * all, so the child falls through to ~/.pi/agent/settings.json. To watch the
 * ambient actually land, set `defaultThinkingLevel` to `max` there and read the
 * wall clock — measured on "reply OK", plan 2007ms against 484-937ms for the
 * `off` groups. This script never writes that file; restore it byte-for-byte if
 * you do.
 *
 *   bun run scripts/reasoning-wire-smoke.ts
 *   PI_TASK_CONFIG_PATH=/tmp/default-mode.json bun run scripts/reasoning-wire-smoke.ts
 */
import {chmodSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {getConfig} from '../src/config/config.js'
import {groupThinkingArgs} from '../src/config/reasoning-args.js'
import {REASONING_GROUPS, type ReasoningGroup} from '../src/config/reasoning.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'

const PROMPT = 'Reply with exactly the word OK. Nothing else.'
const ABSTAIN = 2

const mode = getConfig().reasoningMode
if (mode !== 'default') {
    console.error(
        `ABSTAIN — reasoningMode is "${mode}", so DEFAULT_REASONING_TABLE is never read.`
            + ` Every group resolves to ${mode === 'custom' ? "the user's own level" : `"${mode}"`}`
            + ' and this smoke would report that as the table. Set /task-config reasoning to'
            + ' `default`, or point PI_TASK_CONFIG_PATH at a config that does.'
    )
    process.exit(ABSTAIN)
}

/** The real pi, resolved the way a user's shell would. */
function realPi(): string {
    try {
        return execFileSync('which', ['pi'], {encoding: 'utf8'}).trim()
    } catch {
        console.error('ABSTAIN — no `pi` on PATH, so there is no child to spawn.')
        process.exit(ABSTAIN)
    }
}

const dir = mkdtempSync(path.join(tmpdir(), 'reasoning-wire-'))
const log = path.join(dir, 'argv.log')
const shim = path.join(dir, 'pi-shim.sh')
writeFileSync(
    shim,
    '#!/usr/bin/env bash\n'
        + `printf '%s\\n' "$(printf '%q ' "$@")" >> ${JSON.stringify(log)}\n`
        + `exec ${JSON.stringify(realPi())} "$@"\n`
)
chmodSync(shim, 0o755)
writeFileSync(log, '')
process.env.PI_BIN = shim

let ambient = '(unreadable)'
try {
    const settings = JSON.parse(
        readFileSync(path.join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8')
    ) as {defaultThinkingLevel?: unknown}
    ambient = String(settings.defaultThinkingLevel)
} catch {
    /* an absent settings.json is a real state — pi has its own default */
}
console.log(`reasoningMode = default   ambient defaultThinkingLevel = ${ambient}\n`)

/** Everything after the constant `childBaseArgs` prefix — the part under test. */
function tail(line: string): string {
    return line
        .replace(
            /^--print --no-skills --no-extensions --no-prompt-templates --no-context-files --no-session /,
            ''
        )
        .trim()
}
function lastArgv(): string {
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    return tail(lines[lines.length - 1] ?? '')
}

interface Row {
    what: string
    want: string
    got: string
    ms: number
    ok: boolean
}
const rows: Row[] = []
async function record(what: string, group: ReasoningGroup, spawn: () => Promise<unknown>) {
    const want = groupThinkingArgs(group).join(' ')
    const t0 = Date.now()
    await spawn()
    const ms = Date.now() - t0
    const got = lastArgv()
    // The fragment must be present AND in the position childArgs puts it —
    // immediately before `--mode`, which is what the model client parses.
    const expected = `${want} --mode json --tools read`.replace(/\s+/g, ' ').trim()
    rows.push({what, want: want === '' ? '(no flag)' : want, got, ms, ok: got === expected})
}

// ── runWorker: the group is passed at the call site ──────────────────────────
for (const group of REASONING_GROUPS) {
    if (group === 'implementation') continue // the HOST turn, not a child
    await record(`runWorker ${group}`, group, () =>
        runWorker({
            prompt: PROMPT,
            profile: 'adhoc', contextWindow: 'unknown',
            override: {
                'worker-timeout': {timeoutMs: 300_000, progressCeilingMs: null, fanout: null}
            },
            cwd: process.cwd(),
            signal: new AbortController().signal,
            thinking: groupThinkingArgs(group),
            tools: 'read',
        })
    )
}

// ── runPhaseChild: the group is looked up from the CHILD NAME ────────────────
const deps = {
    cwd: process.cwd(),
    taskId: 'SMOKE',
    signal: new AbortController().signal,
    contextWindow: 262_144,
    childExtensions: []
} as unknown as PhaseDeps
const BY_NAME: [string, ReasoningGroup][] = [
    ['refine', 'phase'],
    ['auto-decompose', 'planning'],
    ['plan-question', 'plan']
]
for (const [name, group] of BY_NAME) {
    await record(`runPhaseChild ${name}`, group, () =>
        runPhaseChild(deps, name, 'read', PROMPT)
    )
}

let bad = 0
for (const r of rows) {
    if (!r.ok) bad++
    console.log(
        `${r.ok ? 'ok  ' : 'FAIL'} ${r.what.padEnd(26)} want ${r.want.padEnd(18)}`
            + ` ${String(r.ms).padStart(6)}ms  argv: ${r.got}`
    )
}
console.log(
    bad === 0 ?
        `\n${rows.length}/${rows.length} spawns carried their group's resolved level.`
    :   `\n${bad}/${rows.length} spawns did NOT carry their group's resolved level.`
)
process.exit(bad === 0 ? 0 : 1)
