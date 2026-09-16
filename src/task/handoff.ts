/**
 * handoff — what was delivered to the implementer, per attempt.
 *
 * The `## handoff` section used to be one `handoff_at:` timestamp, overwritten on
 * every re-entry, which answered neither of the questions asked of it after a run:
 * how many times was this task's spec delivered, and was the spec that came back
 * the same one that failed? A record per delivery answers both — the spec hash
 * makes a re-delivery that silently changed the spec visible, and the fix summary
 * says which gate decision paid for it.
 *
 * Key-value lines because this section is read by humans as often as by code, and
 * a blank line between records is the only separator the grammar needs.
 */
import {createHash} from 'node:crypto'
import type {FixContext} from './fix-context.js'
import type {Disposition} from './gate-resolution.js'
import type {ProbeFindings, VerifyFailClass} from './verify-work.js'

/** The part of a {@link FixContext} worth keeping after the run that used it. */
export interface HandoffFixSummary {
    /** The rule of the decision table that sent the work back. */
    rule: Disposition['rule']
    failClass?: VerifyFailClass
    /** Which re-run the fix context itself was built for, 1-based. */
    fixAttempt: number
    /** Probe names that found something; the findings live in the gate trail. */
    probes: string[]
    frozenPath?: string
}

export interface HandoffRecord {
    /** Which delivery of this task's spec this is, 1-based. */
    attempt: number
    specHash: string
    delivered: 'fresh' | 'reattempt'
    fixContext?: HandoffFixSummary
    at?: string
}

/** Short content hash of the spec as delivered. */
export function specHash(spec: string): string {
    return createHash('sha256').update(spec).digest('hex').slice(0, 12)
}

export function summariseFixContext(ctx: FixContext): HandoffFixSummary {
    const probes = Object.entries(ctx.probes as ProbeFindings)
        .filter(([, findings]) => Array.isArray(findings) && findings.length > 0)
        .map(([name]) => name)
    return {
        rule: ctx.disposition.rule,
        ...(ctx.outcome.failClass ? {failClass: ctx.outcome.failClass} : {}),
        fixAttempt: ctx.attempt,
        probes,
        ...(ctx.contradiction ? {frozenPath: ctx.contradiction.frozenPath} : {})
    }
}

const FIELD_RE = /^([a-z_]+):\s*(.*)$/

export function formatHandoff(r: HandoffRecord): string {
    const lines = [
        `handoff_at: ${r.at ?? new Date().toISOString()}`,
        `attempt: ${r.attempt}`,
        `spec_hash: ${r.specHash}`,
        `delivered: ${r.delivered}`
    ]
    const f = r.fixContext
    if (f) {
        lines.push(`fix_rule: ${f.rule}`)
        if (f.failClass) lines.push(`fix_class: ${f.failClass}`)
        lines.push(`fix_attempt: ${f.fixAttempt}`)
        if (f.probes.length > 0) lines.push(`fix_probes: ${f.probes.join(', ')}`)
        if (f.frozenPath) lines.push(`fix_frozen_path: ${f.frozenPath}`)
    }
    return lines.join('\n')
}

/**
 * Every record in a `## handoff` body, oldest first. A block without the
 * `attempt` field is one of the single-timestamp sections this grammar replaced:
 * it is still a delivery, so it is returned as attempt 1 with an unknown hash
 * rather than dropped, and the next append counts from it.
 */
export function parseHandoff(body: string | null): HandoffRecord[] {
    const out: HandoffRecord[] = []
    for (const block of (body ?? '').split(/\n\s*\n/)) {
        const fields = new Map<string, string>()
        for (const line of block.split('\n')) {
            const m = FIELD_RE.exec(line.trim())
            if (m) fields.set(m[1], m[2].trim())
        }
        if (fields.size === 0) continue
        const attempt = parseInt(fields.get('attempt') ?? '', 10)
        const delivered = fields.get('delivered')
        const rule = fields.get('fix_rule')
        const probes = fields.get('fix_probes')
        const failClass = fields.get('fix_class')
        const frozenPath = fields.get('fix_frozen_path')
        out.push({
            attempt: Number.isNaN(attempt) ? out.length + 1 : attempt,
            specHash: fields.get('spec_hash') ?? '',
            delivered: delivered === 'reattempt' ? 'reattempt' : 'fresh',
            ...(fields.has('handoff_at') ? {at: fields.get('handoff_at')} : {}),
            ...(rule ?
                {
                    fixContext: {
                        rule: rule as Disposition['rule'],
                        ...(failClass ? {failClass: failClass as VerifyFailClass} : {}),
                        fixAttempt: parseInt(fields.get('fix_attempt') ?? '1', 10) || 1,
                        probes: probes ? probes.split(',').map(p => p.trim()) : [],
                        ...(frozenPath ? {frozenPath} : {})
                    }
                }
            :   {})
        })
    }
    return out
}

/** The section body with `record` appended after everything already in `prev`. */
export function appendHandoff(prev: string | null, record: HandoffRecord): string {
    const before = (prev ?? '').trim()
    const line = formatHandoff(record)
    return before.length === 0 ? line : `${before}\n\n${line}`
}
