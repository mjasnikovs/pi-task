import * as fs from 'node:fs'
import {CHILD_BASE_ARGS} from './child-process.js'
import {getConfig} from '../config/config.js'

/**
 * Extension whitelist → child argv.
 *
 * Child pi sessions run with `--no-extensions` (see CHILD_BASE_ARGS). That flag
 * disables extension DISCOVERY only: pi still loads every explicit `-e <path>`.
 * An extension can be the sole source of a model provider — pi's `ExtensionAPI`
 * exposes `registerProvider` — and with discovery off such an extension never
 * runs in the child, so the provider it would register is absent there.
 * Injecting the user's whitelisted entry paths loads exactly those back and
 * leaves every non-whitelisted extension out.
 *
 * Same mechanism `runWorker` uses for the internal worker-tool extensions, via
 * its `extensions` input.
 */

/**
 * Map whitelisted entry paths to `-e` argv pairs. Pure given `exists`.
 *
 * The existence filter is load-bearing. A missing `-e` path is fatal to pi, not
 * a warning: it prints `Extension path does not exist: <path>` and exits 1
 * without reaching the model. So a whitelist entry left pointing at an
 * uninstalled extension would kill every child spawn, and is dropped here
 * instead. Blank and duplicate entries are dropped for the same reason — a
 * hand-edited config must not be able to shape the argv into a failure.
 */
export function extensionArgs(
    paths: readonly string[],
    exists: (p: string) => boolean = fs.existsSync
): string[] {
    const seen = new Set<string>()
    const args: string[] = []
    for (const p of paths) {
        if (typeof p !== 'string' || p.trim().length === 0 || seen.has(p)) continue
        seen.add(p)
        if (!exists(p)) continue
        args.push('-e', p)
    }
    return args
}

/**
 * The base argv every child pi invocation starts from: all three argv builders
 * (`childArgs`, `focusedChildArgs`, `runWorker`) begin here.
 *
 * Order: internal worker extensions, then the user's whitelisted extensions
 * (existence-filtered, and deduped against the internal ones), then
 * CHILD_BASE_ARGS. Internal paths go in verbatim with no existence check
 * because every one of them is resolved against `import.meta.url`, so it names
 * a sibling of the module that asked for it and ships wherever that ships.
 *
 * The config is read on every call rather than at module load, so a
 * `/task-config` toggle reaches the next child: the toggle saves through
 * `saveConfig`, which replaces the object `getConfig` hands back.
 */
export function childBaseArgs(internalExtensions: readonly string[] = []): string[] {
    const internal = internalExtensions.flatMap(e => ['-e', e])
    const whitelisted = extensionArgs(
        getConfig().extensionWhitelist.filter(p => !internalExtensions.includes(p))
    )
    return [...internal, ...whitelisted, ...CHILD_BASE_ARGS]
}
