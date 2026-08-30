/**
 * Phase timing data — captures how long each pipeline phase took so we can
 * spot regressions and target future speed improvements.
 *
 * Top-level entries are the five phases of PHASE_ORDER (refine, research, grill,
 * compose, critique). Each phase may attach optional sub-step children, recorded
 * through `deps.recordSubStep`: research reports `workers` and `verify-tooling`,
 * grill `gen` and `auto-answer`, critique `triage` and `rewrite`, and every phase
 * child reports its own `<name> wait` / `<name> work` split.
 *
 * `formatTimings` produces the human-readable block we write to the
 * `## phase timings` section of the TASK_NNNN.md file.
 */

export interface TimingEntry {
    label: string
    ms: number
    children: TimingEntry[]
}

const TOP_LABEL_WIDTH = 18
const SUB_LABEL_WIDTH = 20
const MS_COLUMN_WIDTH = 8

export function formatMs(ms: number): string {
    if (ms < 0) ms = 0
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
}

export function formatTimings(entries: ReadonlyArray<TimingEntry>): string {
    if (entries.length === 0) return '(no phases recorded)'
    const lines: string[] = []
    let total = 0
    for (const e of entries) {
        total += e.ms
        lines.push(`${e.label.padEnd(TOP_LABEL_WIDTH)}${formatMs(e.ms).padStart(MS_COLUMN_WIDTH)}`)
        for (const c of e.children) {
            lines.push(
                `  ${c.label.padEnd(SUB_LABEL_WIDTH)}${formatMs(c.ms).padStart(MS_COLUMN_WIDTH)}`
            )
        }
    }
    lines.push(`${'total'.padEnd(TOP_LABEL_WIDTH)}${formatMs(total).padStart(MS_COLUMN_WIDTH)}`)
    return lines.join('\n')
}
