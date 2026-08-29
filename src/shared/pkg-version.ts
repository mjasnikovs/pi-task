import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * The installed pi-task version, read from package.json on every call so no
 * build step has to bake it in and nothing needs regenerating on release.
 *
 * Two levels up is right for BOTH trees: `src/<dir>/../..` and `dist/<dir>/../..`
 * each land on the package root, because tsconfig.build.json sets
 * `rootDir: "src"` and tsc therefore reproduces the directory layout under dist.
 * Called from each, both answer the version package.json declares.
 *
 * There are two ways to reach the '0.0.0' fallback and neither throws: an absent
 * or unreadable package.json is caught, and a `version` that is not a string
 * fails the typeof guard. Both were run. Throwing would be wrong for what the
 * two callers do with it — one builds a fetch User-Agent, the other the title on
 * the /task-config settings box. Neither is worth failing a session over.
 */
export function readPkgVersion(): string {
    try {
        const here = dirname(fileURLToPath(import.meta.url))
        const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
            version?: unknown
        }
        return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    } catch {
        return '0.0.0'
    }
}
