/**
 * Custody of the task dir while a model can write to it.
 *
 * Every markdown file in `.pi-tasks/` is host state. A model reaches it through
 * edit, write or bash, and pi rewrites a path before it writes (`@x`, `file://`),
 * so a rule on the tool call sees only some of the writers. The host snapshots
 * the files before the model runs and puts back whatever changed. MEASURED: an
 * mx5 implementer wrote its report over TASK_AUTO_0001.md, and the run died on
 * its front matter.
 *
 * Only markdown is held: pi-task's own tools write research-cache.json mid-turn.
 * A file created in the window is kept, because a run started meanwhile
 * allocates its own.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {notifyRun} from '../remote/bridge.js'
import {recoveryTurnPending} from './recovery-turn.js'
import {tasksDir} from './task-io.js'
import {TASKS_DIR_NAME} from './task-types.js'

/** File name → bytes, for the held files only. */
export type TaskDirSnapshot = ReadonlyMap<string, Buffer>

export async function snapshotTaskDir(cwd: string): Promise<TaskDirSnapshot> {
    const dir = tasksDir(cwd)
    const out = new Map<string, Buffer>()
    const entries = await fsp.readdir(dir, {withFileTypes: true}).catch(() => [])
    for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue
        const bytes = await fsp.readFile(path.join(dir, e.name)).catch(() => null)
        if (bytes) out.set(e.name, bytes)
    }
    return out
}

/** Rewrite every snapshotted file that changed or is gone. Never throws.
 *  Returns the names it put back, sorted. */
export async function restoreTaskDir(cwd: string, snapshot: TaskDirSnapshot): Promise<string[]> {
    const dir = tasksDir(cwd)
    const restored: string[] = []
    for (const [name, bytes] of snapshot) {
        const file = path.join(dir, name)
        const now = await fsp.readFile(file).catch(() => null)
        if (now?.equals(bytes)) continue
        try {
            await fsp.mkdir(dir, {recursive: true})
            await fsp.writeFile(file, bytes)
            restored.push(name)
        } catch {
            // The host's next read of this file reports what is still wrong.
        }
    }
    return restored.sort()
}

export function taskDirRestoredNotice(who: string, names: readonly string[]): string {
    const list = names.map(n => `${TASKS_DIR_NAME}/${n}`).join(', ')
    return `${who} changed ${list}, which only pi-task writes. Restored.`
}

interface Custody {
    cwd: string
    snapshot: TaskDirSnapshot
    oneShot: boolean
}

/** The implementation turn's custody. One slot: one task runs at a time. */
let held: Custody | null = null

async function release(custody: Custody): Promise<string[]> {
    if (held !== custody) return []
    held = null
    return restoreTaskDir(custody.cwd, custody.snapshot)
}

/**
 * Snapshot before the turn can start, replacing any custody still held.
 * `oneShot` means the settle ends it; otherwise the returned release does, and
 * it never releases a custody taken since.
 */
export async function takeTaskDirCustody(
    cwd: string,
    opts: {oneShot: boolean}
): Promise<() => Promise<string[]>> {
    const custody: Custody = {cwd, snapshot: await snapshotTaskDir(cwd), oneShot: opts.oneShot}
    held = custody
    return () => release(custody)
}

export function releaseTaskDirCustody(): Promise<string[]> {
    return held ? release(held) : Promise.resolve([])
}

/** @internal Test seam: is a turn's task dir held? */
export function taskDirCustodyHeld(): boolean {
    return held !== null
}

/**
 * pi awaits these handlers before it wakes a command waiting for idle, so a
 * one-shot restore finishes before the next run writes anything.
 */
export function registerTaskDirCustody(pi: ExtensionAPI): void {
    pi.on('agent_settled', async (_event, ctx) => {
        if (!held?.oneShot || recoveryTurnPending()) return
        const restored = await releaseTaskDirCustody()
        if (restored.length === 0) return
        notifyRun(ctx, taskDirRestoredNotice('The implementation turn', restored), 'warning')
    })
    // Dropped, not restored: a snapshot this old would revert the next run's writes.
    pi.on('session_shutdown', () => {
        held = null
    })
}
