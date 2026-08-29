/**
 * The read-only contract for /task-plan.
 *
 * Planning happens BEFORE the work is agreed, so a plan session must leave the
 * project exactly as it found it: no file created, edited, or deleted. Nothing is
 * built yet, so any artifact a plan produced would be an artifact nobody approved
 * — and it would sit in the tree looking like part of the change the user is
 * still deciding whether to make.
 *
 * Two layers, because one of them is somebody else's flag:
 *
 *   PREVENTION — the planning children run with {@link PLAN_TOOLS}, an allowlist
 *   of exactly one tool. pi applies `--tools` to built-in, extension AND custom
 *   tools, so a write tool contributed by a whitelisted extension is excluded
 *   too. This is what actually makes the session read-only.
 *
 *   VERIFICATION — after every child, the working tree is compared against the
 *   snapshot taken before it. `.pi-tasks/` is excluded (that is where the plan
 *   file itself lives — see collectTreeChanges), so what remains is precisely
 *   "did planning touch the project". If it ever fires, prevention has a hole:
 *   it is reported loudly and recorded in the plan file rather than silently
 *   tolerated. It never deletes anything — an unexplained file is a thing to show
 *   the user, not a thing to quietly destroy.
 */

import type {TreeChangeSummary} from './write-guard.js'

/**
 * The tool allowlist every /task-plan child runs under. One tool: `read`.
 *
 * Deliberately a named constant with a test pinning it (plan-readonly.test.ts):
 * widening this string is the single edit that would end the read-only guarantee,
 * and it should never happen by accident. The same value grill and clarify use
 * for their generation children — planning has never needed more.
 */
export const PLAN_TOOLS = 'read'

/**
 * What appeared in `after` that was not already in `before`.
 *
 * A set difference, not an emptiness check: /task-plan runs against whatever the
 * user already has in progress, and a tree that was dirty when planning started
 * is normal — only what planning ADDED is a violation.
 */
export function newTreeChanges(
    before: TreeChangeSummary,
    after: TreeChangeSummary
): TreeChangeSummary {
    const diff = (a: string[], b: string[]): string[] => {
        const seen = new Set(b)
        return a.filter(p => !seen.has(p))
    }
    return {
        modified: diff(after.modified, before.modified),
        added: diff(after.added, before.added),
        deleted: diff(after.deleted, before.deleted)
    }
}

/** True when the summary names nothing at all. */
export function isEmptyChange(c: TreeChangeSummary): boolean {
    return c.modified.length + c.added.length + c.deleted.length === 0
}

/** One line naming what a planning step touched, for the notify and the record. */
export function formatReadOnlyViolation(step: string, c: TreeChangeSummary): string {
    const parts: string[] = []
    if (c.added.length > 0) parts.push(`created ${c.added.join(', ')}`)
    if (c.modified.length > 0) parts.push(`modified ${c.modified.join(', ')}`)
    if (c.deleted.length > 0) parts.push(`deleted ${c.deleted.join(', ')}`)
    return `/task-plan is read-only, but the ${step} step ${parts.join('; ')}`
}
