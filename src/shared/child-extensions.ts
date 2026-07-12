import * as fs from 'node:fs'
import {CHILD_BASE_ARGS} from './child-process.js'
import {getConfig} from '../config/config.js'

/**
 * Extension whitelist → child argv (GitHub issue #4).
 *
 * Child pi sessions run with `--no-extensions`, so a provider registered by a
 * host extension (e.g. pi-lmstudio) doesn't exist in them — the child can't
 * resolve the default model and demands OAuth/API keys. pi's `--no-extensions`
 * explicitly preserves explicit `-e <path>` loads (only discovery is disabled),
 * so injecting the user's whitelisted entry paths restores the provider while
 * keeping every non-whitelisted extension out. Same mechanism pi-task already
 * uses for its own worker-tool extensions (see runWorker's `extensions` input).
 */

/**
 * Map whitelisted entry paths to `-e` argv pairs. Pure given `exists`.
 *
 * A path whose file is gone (extension uninstalled since it was whitelisted)
 * is skipped silently: pi itself would record "Extension path does not exist"
 * as a load ERROR, and a stale toggle must never break every child spawn.
 * Duplicates collapse so a path can't be loaded twice.
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
 * The base argv every child pi invocation starts from: internal worker
 * extensions (verbatim — they always exist, shipped in dist), then the user's
 * whitelisted extensions (existence-filtered, deduped against the internal
 * ones), then CHILD_BASE_ARGS. Computed per spawn, not at module load, so a
 * /task-config toggle takes effect for the next child without a restart.
 */
export function childBaseArgs(internalExtensions: readonly string[] = []): string[] {
    const internal = internalExtensions.flatMap(e => ['-e', e])
    const whitelisted = extensionArgs(
        getConfig().extensionWhitelist.filter(p => !internalExtensions.includes(p))
    )
    return [...internal, ...whitelisted, ...CHILD_BASE_ARGS]
}
