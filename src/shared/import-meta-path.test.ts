import {describe, expect, test} from 'bun:test'
import {readFileSync, readdirSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Windows regression guard (GitHub issue #2).
 *
 * `new URL('../x.js', import.meta.url).pathname` returns `/C:/Users/...` on
 * Windows — a leading-slash + drive-letter string that pi then resolves against
 * the current drive, yielding `C:\C:\Users\...` and a "Failed to load extension"
 * crash in the second phase. `.pathname` also URL-decodes, so a path containing
 * a space breaks on POSIX too. The correct conversion is `fileURLToPath()`.
 *
 * This test scans the whole source tree for the broken idiom so the fix can't
 * silently regress. It is a cross-platform stand-in for actually running on
 * Windows: it catches the specific bug class without a Windows runner.
 */

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))

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
    // Matches `new URL(..., import.meta.url) ... .pathname`, tolerating a newline
    // before `.pathname` (prettier wraps long lines).
    const BROKEN = /new URL\([^)]*import\.meta\.url[^)]*\)\s*\.pathname/

    test('no source file resolves an import.meta.url URL via .pathname', () => {
        const offenders = walk(SRC_DIR).filter(f => BROKEN.test(readFileSync(f, 'utf8')))
        expect(offenders).toEqual([])
    })
})
