/**
 * Zero-FP fixture suite for the docs version banner (nexttask 17B) — the
 * regression net for `buildVersionBanner` / `findDeclaredRange`.
 *
 * The A/B proved the lever on the one corpus that exists: mx5 run 20, npm-shaped,
 * and every one of its 35 movable entries is the SAME shape (`@types/bun` declared
 * as `latest`). One shape is not a class. This suite is where the rest of the
 * class lives — the protocols and wildcards that `isUsableRange` also rejects, and
 * which would otherwise reach a user as "not declared in this project's
 * package.json" the first time someone runs a workspace or a file: dependency.
 *
 * Two things are asserted of every fixture, and they pull in opposite directions:
 *
 *   the SENTENCE must stop calling a declared dependency undeclared
 *   the INSTALL path must not budge — `findDeclaredRange` still returns null for
 *   every one of these values, because none of them is an
 *   `npm install <pkg>@<range>` target. 17B splits the message, not the logic.
 *
 * No model, no network, no evidence tree: fixtures are throwaway package.json
 * files in a temp dir. That is why this one runs in `bun test` rather than as a
 * hand-run script — same reason ab-verdict.test.ts does. A scorer net that only
 * runs when somebody remembers to run it is a net nobody reads.
 */
import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {buildVersionBanner, findDeclaredRange, type AutoInstallPin} from '../src/workers/docs-core.js'

let ROOT = ''
let n = 0

beforeAll(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'version-banner-fp-'))
})
afterAll(() => {
    if (ROOT !== '') fs.rmSync(ROOT, {recursive: true, force: true})
})

/** A throwaway project dir with the given package.json body (raw string). */
function projectDir(body: string | null): string {
    const dir = path.join(ROOT, `p${++n}`)
    fs.mkdirSync(dir, {recursive: true})
    if (body !== null) fs.writeFileSync(path.join(dir, 'package.json'), body, 'utf8')
    return dir
}

const PIN: AutoInstallPin = {source: 'npm-latest', asked: 'bun'}
const banner = (dir: string, resolved = 'bun-types'): string =>
    buildVersionBanner(PIN, resolved, '1.3.14', dir)

describe('declared-but-unpinned — the sentence must say "declared", the install path must not move', () => {
    const unpinned: Array<[string, string, string]> = [
        ['dist-tag on the @types package', '{"devDependencies":{"@types/bun":"latest"}}', 'latest'],
        ['dist-tag on the package itself', '{"dependencies":{"bun":"latest"}}', 'latest'],
        ['workspace protocol', '{"dependencies":{"bun":"workspace:*"}}', 'workspace:*'],
        ['file protocol', '{"dependencies":{"bun":"file:../bun"}}', 'file:../bun'],
        ['link protocol', '{"dependencies":{"bun":"link:../bun"}}', 'link:../bun'],
        ['npm alias', '{"dependencies":{"bun":"npm:other@^1"}}', 'npm:other@^1'],
        ['bare wildcard', '{"dependencies":{"bun":"*"}}', '*'],
        ['x wildcard', '{"dependencies":{"bun":"x"}}', 'x'],
        ['declared on the TERMINAL of the chain', '{"devDependencies":{"bun-types":"latest"}}', 'latest']
    ]

    for (const [label, body, value] of unpinned) {
        test(`${label} — reported as declared, quoting the value`, () => {
            const text = banner(projectDir(body))
            expect(text).toContain("is declared in this project's package.json")
            expect(text).toContain(`\`${value}\``)
            expect(text).not.toContain('is not declared')
        })

        test(`${label} — install path unchanged (findDeclaredRange still null)`, () => {
            expect(findDeclaredRange('bun', projectDir(body))).toBeNull()
        })

        test(`${label} — no "different MAJOR" warning`, () => {
            expect(banner(projectDir(body))).not.toContain('different MAJOR')
        })
    }
})

describe('genuinely undeclared — "not declared" is TRUE here and must survive', () => {
    const undeclared: Array<[string, string | null]> = [
        ['absent from all four dependency maps', '{"dependencies":{"other":"^1.0.0"},"devDependencies":{"more":"^2"}}'],
        ['a package.json that does not parse', '{"dependencies": {'],
        ['no package.json at all', null],
        ['a package.json that is not an object', '"just a string"'],
        ['dependency maps that are not objects', '{"dependencies":"nope","devDependencies":42}']
    ]

    for (const [label, body] of undeclared) {
        test(`${label} — still says "not declared", still warns about the major`, () => {
            const text = banner(projectDir(body))
            expect(text).toContain(`"bun" is not declared in this project's package.json,`)
            expect(text).toContain('different MAJOR')
        })
    }
})

describe('scope boundary — `latest` is the ONLY dist-tag isUsableRange rejects', () => {
    // Found by this suite: `next`, `beta` and `canary` are all accepted as ranges
    // and become `npm install bun@next` — they pin no more of a major than
    // `latest` does. 17B does NOT move that line, because moving it would change
    // WHAT GETS INSTALLED, and this lever changes only the sentence. Asserted here
    // so the inconsistency is recorded behaviour rather than an unexamined gap.
    test('`next` is still treated as an installable range (install path untouched)', () => {
        expect(findDeclaredRange('bun', projectDir('{"dependencies":{"bun":"next"}}'))).toBe('next')
    })

    test('and it reaches the declared-range banner, naming `bun`', () => {
        const dir = projectDir('{"dependencies":{"bun":"next"}}')
        const text = buildVersionBanner({source: 'declared-range', range: 'next', asked: 'bun'}, 'bun-types', '1.3.14', dir)
        expect(text.startsWith('[VERSION] "bun" resolved to this project\'s declared range next')).toBe(true)
    })
})

describe('usable declaration off the asked name — provenance, never a claim the install was pinned', () => {
    test('a real range on @types/bun is cited, but the install is still npm latest', () => {
        const text = banner(projectDir('{"devDependencies":{"@types/bun":"^1.2.0"}}'))
        expect(text).toContain('only its types are, as @types/bun ^1.2.0')
        expect(text).toContain('npm latest (v1.3.14)')
        expect(text).not.toContain('pinned to that version')
    })

    test('and it does not become an install target for `bun`', () => {
        expect(findDeclaredRange('bun', projectDir('{"devDependencies":{"@types/bun":"^1.2.0"}}'))).toBeNull()
    })
})

describe('no pin — an already-installed package gets NO banner, whatever package.json says', () => {
    const cases: Array<[string, string]> = [
        ['undeclared', '{"dependencies":{"other":"^1"}}'],
        ['declared as latest', '{"devDependencies":{"@types/bun":"latest"}}'],
        ['declared with a real range', '{"dependencies":{"bun":"^1.2.0"}}']
    ]

    for (const [label, body] of cases) {
        test(`${label} — empty banner`, () => {
            expect(buildVersionBanner(undefined, 'bun-types', '1.3.14', projectDir(body))).toBe('')
        })
    }
})

describe('naming — the quoted package is always the one asked about', () => {
    const cases: Array<[string, string]> = [
        ['undeclared', '{"dependencies":{"other":"^1"}}'],
        ['declared as latest via @types', '{"devDependencies":{"@types/bun":"latest"}}'],
        ['declared on the terminal only', '{"devDependencies":{"bun-types":"latest"}}']
    ]

    for (const [label, body] of cases) {
        test(`${label} — names "bun"`, () => {
            expect(banner(projectDir(body)).split('"')[1]).toBe('bun')
        })
    }
})
