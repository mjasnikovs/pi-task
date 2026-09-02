/**
 * The crash half of the implementation hold.
 *
 * `release()` runs in a `finally`, and a `finally` does not run for SIGKILL, a
 * segfault, or the power going out. An implementation turn is measured in hours.
 * Without this, one of those leaves pi's GLOBAL `defaultModel` pointing at the
 * implementation model — and because children carry no `-m` and resolve that
 * same default, every child of every future run, in every project, quietly
 * follows it until the user notices.
 *
 * So acquire leaves a note on disk and release removes it. A later session
 * finds the note and puts the model back.
 */
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {defaultModelRef} from '../shared/model-endpoint.js'
import {specOf} from '../shared/model-resolve.js'
import {stateFile} from '../shared/data-home.js'
import {liveModelControl, restoreHeldModel} from './implementation-hold.js'

/**
 * Both halves of the switch, as `provider/id` strings.
 *
 * `applied` is what makes the restore safe to run in a second, unrelated
 * session: it is the value we are allowed to overwrite, and nothing else.
 */
export interface StashRecord {
    before: string
    applied: string
}

/** The seam, so the hold's tests never touch a real home directory. */
export interface HoldStash {
    read(): StashRecord | undefined
    write(record: StashRecord): void
    clear(): void
}

const stashPath = (): string => stateFile('model-hold.json')

export function readHoldStash(): StashRecord | undefined {
    try {
        const j = JSON.parse(fs.readFileSync(stashPath(), 'utf8')) as Partial<StashRecord>
        if (typeof j.before !== 'string' || typeof j.applied !== 'string') return undefined
        if (j.before === '' || j.applied === '') return undefined
        return {before: j.before, applied: j.applied}
    } catch {
        return undefined
    }
}

export function writeHoldStash(record: StashRecord): void {
    try {
        const p = stashPath()
        fs.mkdirSync(path.dirname(p), {recursive: true})
        fs.writeFileSync(p, JSON.stringify(record))
    } catch {
        // A stash we cannot write costs us the crash restore, not the turn.
    }
}

export function clearHoldStash(): void {
    try {
        fs.rmSync(stashPath(), {force: true})
    } catch {
        /* already gone */
    }
}

/**
 * Register the crash restore. Runs once per `session_start`, before any task.
 *
 * It reaches for `pi.setModel` rather than writing `settings.json` itself:
 * pi-task has no sanctioned way to write that file, and inventing one would fork
 * the format. Everything it can go wrong on — no registry, a model that has
 * since vanished, a rejected auth check — ends the same way, with the note
 * dropped, because a restore that cannot happen must not re-fire forever.
 */
export function registerModelHoldRestore(pi: ExtensionAPI): void {
    pi.on('session_start', (_event, ctx) => {
        const model = liveModelControl(ctx, handle => pi.setModel(handle))
        // The saved default, read from the file the crash left wrong — not from
        // `ctx.model`, which a `--model` flag or a resumed session can make say
        // something else entirely.
        const saved = (): string | undefined => {
            const ref = defaultModelRef()
            return ref && specOf(ref)
        }
        void restoreHeldModel(model, saved).catch(() => {})
    })
}
