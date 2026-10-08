/**
 * Replay compose → critique on recorded mx5-n tasks with this tree's prompts,
 * and record the ACCEPTANCE bindings each spec declares.
 *
 * Step 0 of the criterion-binding change (criterion-binding.ts): does the new
 * spec name a test for TASK_0039's "never a premature redirect" bullet, does
 * TASK_0040's success bullet name a test that does not stub the reload, and how
 * often is a behaviour tagged `[static]` across a whole run. The specs are written
 * to the ledger for hand reading; this script judges nothing.
 *
 * Each task runs on a clone of the project at the checkpoint it started from,
 * with its recorded refined prompt, research and Q&A.
 *
 * Usage:
 *   PI_BIN=$(command -v pi) bun run scripts/replay-spec-binding.ts <scratch-dir> <mx5-n-repo> <ledger> <reps> TASK_0039 [TASK_0040 …]
 */
import {spawnSync} from 'node:child_process'
import {appendFileSync, existsSync, readFileSync, rmSync, symlinkSync} from 'node:fs'
import * as path from 'node:path'
import {bindingOf} from '../src/task/criterion-binding.js'
import {phaseCompose, phaseCritique} from '../src/task/phases.js'
import {parseSpec} from '../src/task/spec-model.js'
import {readSection, writeTaskFile} from '../src/task/task-io.js'

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8'})
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
}

function checkpointOf(repo: string, rawPrompt: string): string {
    const head = rawPrompt.trim().slice(0, 50)
    const hit = git(repo, 'log', '--format=%H %s')
        .split('\n')
        .find(l => l.includes('chore: checkpoint before "') && l.includes(head))
    if (!hit) throw new Error(`no checkpoint commit for "${head}"`)
    return hit.split(' ')[0]
}

async function main(): Promise<void> {
    const [scratch, repo, ledger, repsArg, ...tasks] = process.argv.slice(2)
    if (!scratch || !repo || !ledger || !repsArg || tasks.length === 0) {
        throw new Error('usage: replay-spec-binding.ts <scratch> <repo> <ledger> <reps> TASK_…')
    }
    if (!process.env.PI_BIN) throw new Error('set PI_BIN to the pi binary')
    const done = new Set(
        existsSync(ledger) ?
            readFileSync(ledger, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(l => {
                    const r = JSON.parse(l) as {task: string; rep: number}
                    return `${r.task}#${r.rep}`
                })
        :   []
    )
    for (let rep = 0; rep < Number(repsArg); rep++) {
        for (const task of tasks) {
            if (done.has(`${task}#${rep}`)) continue
            const refined = (await readSection(repo, task, 'refined prompt')) ?? ''
            const research = (await readSection(repo, task, 'research')) ?? ''
            const qa = (await readSection(repo, task, 'grill Q&A')) ?? ''
            const raw = (await readSection(repo, task, 'raw prompt')) ?? ''
            const dir = path.join(scratch, `${task}-${rep}`)
            rmSync(dir, {recursive: true, force: true})
            git(scratch, 'clone', '-q', repo, dir)
            git(dir, 'checkout', '-q', checkpointOf(repo, raw))
            symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'))
            const now = new Date().toISOString()
            await writeTaskFile(
                dir,
                {id: 'TASK_9001', state: 'in_progress', phase: 'compose', created_at: now, updated_at: now, title: task},
                '\n'
            )
            const deps = {cwd: dir, taskId: 'TASK_9001', signal: new AbortController().signal}
            const draft = await phaseCompose(deps, refined, research, qa)
            let spec = draft
            let critique = 'rewritten'
            try {
                spec = await phaseCritique(deps, draft, refined, qa, undefined, research)
            } catch (err) {
                critique = `fell back to the draft: ${err instanceof Error ? err.message : String(err)}`
            }
            rmSync(dir, {recursive: true, force: true})
            const acceptance = parseSpec(spec).acceptance
            const row = {
                task,
                rep,
                critique,
                bullets: acceptance.map(b => ({bullet: b, binding: bindingOf(b)})),
                spec
            }
            appendFileSync(ledger, `${JSON.stringify(row)}\n`)
            const unbound = row.bullets.filter(b => b.binding === null).length
            const kinds = row.bullets.map(b => b.binding?.kind ?? 'none').join(',')
            console.log(`${task} #${rep}: ${acceptance.length} bullets, ${unbound} unbound [${kinds}] (${critique})`)
        }
    }
}

await main()
