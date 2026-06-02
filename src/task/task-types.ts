/**
 * Task file types and constants.
 *
 * Declares the core types used across the pi-task pipeline: task states,
 * phase names, front matter, and ordering constants.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type TaskState = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export type PhaseName = 'refine' | 'research' | 'grill' | 'compose' | 'critique' | 'done'

export interface TaskFrontMatter {
    id: string
    state: TaskState
    phase: PhaseName
    created_at: string
    updated_at: string
    title: string
    reason?: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const PHASE_ORDER: PhaseName[] = ['refine', 'research', 'grill', 'compose', 'critique']

export const PHASE_INDEX: Record<PhaseName, number> = {
    refine: 0,
    research: 1,
    grill: 2,
    compose: 3,
    critique: 4,
    done: 5
}

export const TASKS_DIR_NAME = '.pi-tasks'

export const RESUMABLE_STATES: TaskState[] = ['in_progress', 'pending', 'cancelled', 'failed']
