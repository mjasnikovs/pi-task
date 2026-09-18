/**
 * Live A/B for the GREEN-SUITE CHECK in GRILL_AUTO_ANSWER_PROMPT.
 *
 * Stimulus: the recorded mx5-n TASK_0004 grill inputs (refined prompt, research,
 * Q1) — the exact call whose auto-answer deferred a broken test to "the test
 * owner". Arm A is the prompt without the check, arm B the production prompt.
 * Both arms run the same child pi runs in production (read tool, thinking off),
 * against a copy of the repo at the checkpoint before TASK_0004.
 *
 * Outcome per trial, from the production parser and the production guard:
 *   deferral  the decision text hands the breakage to a nonexistent owner
 *   green     the decision names the test file as part of this change
 *   other     anything else (untagged, timed out, unrelated)
 *
 * Order: one discarded warm-up, then ABBA blocks, so each arm holds early and late
 * slots. Ledger is append-only JSONL holding the OUTPUT TEXT, keyed by
 * (fingerprint, arm, reps, index), so a scorer change is a rescore, not a re-run.
 *
 * Verdict: ABSTAIN (exit 2) when arm A never deferred — the lever was not
 * exercised. PASS (exit 0) when B's deferral count is a strict reduction with
 * one-sided Fisher p < 0.05, or B reached zero from a non-zero A. FAIL (exit 1)
 * otherwise.
 *
 * Usage:
 *   bun run scripts/ab-green-suite.ts <task-file> <repo-copy> <ledger.jsonl> [reps=8] [--rescore]
 */
import {spawn} from 'node:child_process'
import {appendFileSync, existsSync, readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {GRILL_AUTO_ANSWER_PROMPT, GRILL_GREEN_SUITE_CHECK} from '../src/task/prompts.js'
import {parseAutoAnswer} from '../src/task/parsers.js'
import {defersBreakage} from '../src/task/deferred-breakage.js'

type Arm = 'A' | 'B'
type Outcome = 'deferral' | 'green' | 'other'

interface Row {
    fingerprint: string
    arm: Arm
    reps: number
    index: number
    slot: number
    promptHash: string
    kind: string
    decision: string
    output: string
    ms: number
    error?: string
}

const MODEL = process.env.AB_MODEL ?? 'local/Qwen3.8-27B-UD-Q4_K_XL.gguf'
const PROPS_URL = process.env.AB_PROPS_URL ?? 'http://127.0.0.1:8080/props'
const CHILD_TIMEOUT_MS = 15 * 60_000

function section(md: string, name: string): string {
    const re = new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |\\Z)`, 'm')
    const m = re.exec(md + '\n## end\n')
    if (!m) throw new Error(`section not found: ${name}`)
    return m[1].trim()
}

function question(md: string): string {
    const qa = section(md, 'grill Q&A')
    const m = /^Q1:\s*(.+)$/m.exec(qa)
    if (!m) throw new Error('Q1 not found')
    return m[1].trim()
}

/** Arm A: the production prompt with the check removed and the numbering restored. */
function baselinePrompt(refined: string, research: string, q: string): string {
    const p = GRILL_AUTO_ANSWER_PROMPT(refined, research, q)
    const out = p
        .replace(`${GRILL_GREEN_SUITE_CHECK}\n\n2. ALREADY-DECIDED`, '1. ALREADY-DECIDED')
        .replace('\n3. FUNCTIONAL-REQUIREMENT', '\n2. FUNCTIONAL-REQUIREMENT')
        .replace(
            '4. PREFERENCE — only if no check fires',
            '3. PREFERENCE — only if neither check fires'
        )
    if (out.includes('GREEN-SUITE') || !out.includes('\n1. ALREADY-DECIDED')) {
        throw new Error('baseline prompt did not reduce to the pre-change text')
    }
    return out
}

async function fingerprint(): Promise<string> {
    const r = await fetch(PROPS_URL)
    if (!r.ok) throw new Error(`props ${r.status}`)
    const j = (await r.json()) as Record<string, unknown>
    const gen = j.default_generation_settings as Record<string, unknown> | undefined
    const tpl = typeof j.chat_template === 'string' ? j.chat_template.length : 0
    return [j.model_path, j.build_info, gen?.n_ctx ?? j.n_ctx, tpl].join('|')
}

function lastAssistantText(jsonl: string): string {
    let text = ''
    for (const line of jsonl.split('\n')) {
        let e: {type?: string; messages?: unknown[]} | undefined
        try {
            e = JSON.parse(line)
        } catch {
            continue
        }
        if (e?.type !== 'agent_end' || !Array.isArray(e.messages)) continue
        for (const m of e.messages as Array<{role?: string; content?: unknown}>) {
            if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
            text = (m.content as Array<{type?: string; text?: string}>)
                .filter(b => b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text)
                .join('\n')
        }
    }
    return text
}

function runChild(cwd: string, prompt: string): Promise<{out: string; ms: number; error?: string}> {
    const args = [
        '--print',
        '--mode',
        'json',
        '--no-session',
        '--no-context-files',
        '--no-skills',
        '--no-extensions',
        '--tools',
        'read',
        '--thinking',
        'off',
        '--model',
        MODEL,
        '-p',
        prompt
    ]
    const t0 = Date.now()
    return new Promise(resolve => {
        const child = spawn('pi', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']})
        let out = ''
        let err = ''
        child.stdout.on('data', d => (out += d))
        child.stderr.on('data', d => (err += d))
        const timer = setTimeout(() => child.kill('SIGKILL'), CHILD_TIMEOUT_MS)
        child.on('close', code => {
            clearTimeout(timer)
            const ms = Date.now() - t0
            if (code !== 0) resolve({out, ms, error: `exit ${code}: ${err.slice(0, 300)}`})
            else resolve({out, ms})
        })
    })
}

function score(output: string): {kind: string; decision: string; outcome: Outcome} {
    const parsed = parseAutoAnswer(output)
    const decision = parsed.kind === 'answered' ? parsed.text : (parsed.suggested ?? '')
    if (decision.length === 0) return {kind: parsed.kind, decision, outcome: 'other'}
    if (defersBreakage(decision)) return {kind: parsed.kind, decision, outcome: 'deferral'}
    const green =
        /migrate\.test\.ts/i.test(decision)
        || /\b(update|fix|adjust|amend|edit|change|revise)\b[^.]{0,60}\btests?\b/i.test(decision)
    return {kind: parsed.kind, decision, outcome: green ? 'green' : 'other'}
}

/** One-sided Fisher exact: P(A deferrals >= observed | margins), i.e. is B lower than chance. */
function fisherOneSided(aHit: number, aN: number, bHit: number, bN: number): number {
    const lf = (n: number): number => {
        let s = 0
        for (let i = 2; i <= n; i++) s += Math.log(i)
        return s
    }
    const lchoose = (n: number, k: number): number => lf(n) - lf(k) - lf(n - k)
    const hits = aHit + bHit
    const total = aN + bN
    const denom = lchoose(total, hits)
    let p = 0
    for (let k = aHit; k <= Math.min(hits, aN); k++) {
        if (hits - k > bN) continue
        p += Math.exp(lchoose(aN, k) + lchoose(bN, hits - k) - denom)
    }
    return Math.min(1, p)
}

function loadLedger(path: string, fp: string, reps: number): Row[] {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as Row)
        .filter(r => r.fingerprint === fp && r.reps === reps)
}

function report(rows: Row[], reps: number): number {
    const arms: Record<Arm, Row[]> = {A: [], B: []}
    for (const r of rows) arms[r.arm].push(r)
    const count = (arm: Arm, o: Outcome): number =>
        arms[arm].filter(r => score(r.output).outcome === o).length
    const line = (arm: Arm): string =>
        `${arm}  deferral ${count(arm, 'deferral')}/${arms[arm].length}  green ${count(arm, 'green')}  other ${count(arm, 'other')}`
    console.log(
        `\n=== GREEN-SUITE CHECK A/B  (${rows.length}/${reps * 2} trials, ABBA, warm-up discarded)`
    )
    console.log(line('A'))
    console.log(line('B'))
    console.log(
        'slots: '
            + [...rows]
                .sort((x, y) => x.slot - y.slot)
                .map(r => `${r.arm}:${score(r.output).outcome[0]}`)
                .join(' ')
    )
    const aD = count('A', 'deferral')
    const bD = count('B', 'deferral')
    if (arms.A.length < reps || arms.B.length < reps) {
        console.log('INCOMPLETE — resume to finish the run')
        return 2
    }
    if (aD === 0) {
        console.log('ABSTAIN — arm A never deferred, so the lever was not exercised')
        return 2
    }
    const p = fisherOneSided(aD, arms.A.length, bD, arms.B.length)
    console.log(`fisher one-sided p = ${p.toFixed(4)}`)
    if (bD < aD && (bD === 0 || p < 0.05)) {
        console.log('PASS — the check removed the deferral')
        return 0
    }
    console.log('FAIL — the check did not remove the deferral')
    return 1
}

async function main(): Promise<void> {
    const [taskFile, repoCopy, ledger, repsArg] = process.argv.slice(2)
    if (!taskFile || !repoCopy || !ledger) {
        console.error(
            'usage: ab-green-suite.ts <task-file> <repo-copy> <ledger.jsonl> [reps] [--rescore]'
        )
        process.exit(2)
    }
    const reps = repsArg && !repsArg.startsWith('--') ? Number(repsArg) : 8
    const rescore = process.argv.includes('--rescore')
    const md = readFileSync(taskFile, 'utf8')
    const refined = section(md, 'refined prompt')
    const research = section(md, 'research')
    const q = question(md)
    const prompts: Record<Arm, string> = {
        A: baselinePrompt(refined, research, q),
        B: GRILL_AUTO_ANSWER_PROMPT(refined, research, q)
    }
    const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 12)
    console.log(
        `prompt A ${hash(prompts.A)} (${prompts.A.length} chars)  prompt B ${hash(prompts.B)} (${prompts.B.length} chars)`
    )

    const fp = rescore ? (loadLedger(ledger, '', reps)[0]?.fingerprint ?? '') : await fingerprint()
    const rows =
        rescore ?
            readFileSync(ledger, 'utf8')
                .split('\n')
                .filter(l => l.trim())
                .map(l => JSON.parse(l) as Row)
                .filter(r => r.reps === reps)
        :   loadLedger(ledger, fp, reps)
    if (rescore) {
        process.exit(report(rows, reps))
    }
    console.log(`model fingerprint: ${fp}`)
    console.log(`resuming with ${rows.length} recorded trials`)

    // Warm-up: one arm-A call, discarded, only when nothing is recorded yet.
    if (rows.length === 0) {
        console.log('warm-up (discarded)…')
        const w = await runChild(repoCopy, prompts.A)
        console.log(
            `warm-up ${w.ms} ms ${w.error ?? ''} → ${lastAssistantText(w.out).slice(0, 120).replace(/\s+/g, ' ')}`
        )
    }

    // ABBA schedule over 2*reps slots.
    const schedule: Array<{arm: Arm; index: number; slot: number}> = []
    const seen: Record<Arm, number> = {A: 0, B: 0}
    for (let slot = 0; slot < reps * 2; slot++) {
        const arm: Arm = slot % 4 === 0 || slot % 4 === 3 ? 'A' : 'B'
        schedule.push({arm, index: seen[arm]++, slot})
    }
    for (const s of schedule) {
        if (rows.some(r => r.arm === s.arm && r.index === s.index)) continue
        const fpNow = await fingerprint()
        if (fpNow !== fp) {
            console.log(`ABSTAIN — model changed under the run: ${fpNow}`)
            process.exit(2)
        }
        const r = await runChild(repoCopy, prompts[s.arm])
        const output = lastAssistantText(r.out)
        const sc = score(output)
        const row: Row = {
            fingerprint: fp,
            arm: s.arm,
            reps,
            index: s.index,
            slot: s.slot,
            promptHash: hash(prompts[s.arm]),
            kind: sc.kind,
            decision: sc.decision,
            output,
            ms: r.ms,
            ...(r.error && {error: r.error})
        }
        appendFileSync(ledger, JSON.stringify(row) + '\n')
        rows.push(row)
        console.log(
            `slot ${s.slot} ${s.arm}#${s.index} ${sc.outcome.padEnd(8)} ${Math.round(r.ms / 1000)}s ${sc.kind} → ${sc.decision.slice(0, 110).replace(/\s+/g, ' ')}${r.error ? '  ERR ' + r.error : ''}`
        )
    }
    process.exit(report(rows, reps))
}

await main()
