import {describe, expect, test} from 'bun:test'
import {readFileSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {SRC_ROOT} from '../test-utils/src-tree.js'

/**
 * `new URL(..., import.meta.url).pathname` is NOT a filesystem path.
 *
 * It is the URL's path component, still percent-encoded: a file under
 * `/tmp/a b/` comes back as `/tmp/a%20b/`, which no `fs` call can open.
 * `fileURLToPath()` is the conversion that decodes it, and it is also the only
 * one that handles a drive-lettered file URL correctly.
 *
 * This test scans the whole source tree for the broken idiom, so a reintroduction
 * fails here rather than at load time on someone's machine.
 */

const ROOTS = [SRC_ROOT, path.resolve(import.meta.dir, '..')]

function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue
            out.push(...walk(full))
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            out.push(full)
        }
    }
    return out
}

describe('import.meta.url path resolution (Windows guard)', () => {
    // Matches `new URL(..., import.meta.url).pathname`, tolerating whitespace or a
    // newline before `.pathname` because prettier wraps long lines. It does not
    // match `fileURLToPath(new URL(..., import.meta.url))` or a `.href` read.
    const BROKEN = /new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/

    test('no source file resolves an import.meta.url URL via .pathname', () => {
        const offenders = ROOTS.flatMap(walk).filter(f => BROKEN.test(readFileSync(f, 'utf8')))
        expect(offenders).toEqual([])
    })
})
