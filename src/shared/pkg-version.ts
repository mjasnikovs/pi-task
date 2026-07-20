import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * The installed pi-task version, read from package.json at runtime so nothing
 * has to be regenerated on release. Two levels up holds for both src/<dir>
 * (tests) and dist/<dir> (build), since tsc preserves the layout under rootDir.
 * Falls back to '0.0.0' rather than throwing: every caller here is cosmetic
 * (a User-Agent, a title bar) and none is worth failing over.
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
