/**
 * Zero-FP fixture suite for the docs version banner (nexttask 17B) — run before
 * wiring, and any time the wording or `findDeclaration` changes.
 *
 * The A/B proves the lever on the one corpus that exists: mx5 run 20, npm-shaped,
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
 * files in a temp dir.
 *
 * Run: bun run scripts/version-banner-fp-suite.ts     (exit 0 = PASS)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {buildVersionBanner, findDeclaredRange, type AutoInstallPin} from '../src/workers/docs-core.js'

let failures = 0

function check(label: string, ok: boolean, detail: string): void {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n          ${detail}`}`)
    if (!ok) failures++
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'version-banner-fp-'))
let n = 0

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

// ── declared, but not with an installable range: must NOT say "not declared" ──
console.log('\nDECLARED-BUT-UNPINNED — the sentence must say "declared", the install path must not move')

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
    const dir = projectDir(body)
    const text = banner(dir)
    check(
        `${label} — reported as declared`,
        text.includes("is declared in this project's package.json")
            && text.includes(`\`${value}\``)
            && !text.includes('is not declared'),
        text.trim()
    )
    check(
        `${label} — install path unchanged (findDeclaredRange still null)`,
        findDeclaredRange('bun', dir) === null,
        `findDeclaredRange returned ${String(findDeclaredRange('bun', dir))}`
    )
    check(
        `${label} — no "different MAJOR" warning`,
        !text.includes('different MAJOR'),
        text.trim()
    )
}

// ── genuinely undeclared: the original sentence is the feature, keep it ───────
console.log('\nGENUINELY UNDECLARED — "not declared" is TRUE here and must survive')

const undeclared: Array<[string, string | null]> = [
    ['absent from all four dependency maps', '{"dependencies":{"other":"^1.0.0"},"devDependencies":{"more":"^2"}}'],
    ['a package.json that does not parse', '{"dependencies": {'],
    ['no package.json at all', null],
    ['a package.json that is not an object', '"just a string"'],
    ['dependency maps that are not objects', '{"dependencies":"nope","devDependencies":42}']
]

for (const [label, body] of undeclared) {
    const dir = projectDir(body)
    const text = banner(dir)
    check(
        `${label} — still says "not declared", still warns about the major`,
        text.includes(`"bun" is not declared in this project's package.json,`)
            && text.includes('different MAJOR'),
        text.trim()
    )
}

// ── the shipped predicate's scope boundary, asserted rather than assumed ──────
console.log('\nSCOPE BOUNDARY — `latest` is the ONLY dist-tag isUsableRange rejects')
{
    // Found by this suite: `next`, `beta` and `canary` are all accepted as ranges
    // and become `npm install bun@next` — they pin no more of a major than
    // `latest` does. 17B does NOT move that line, because moving it would change
    // WHAT GETS INSTALLED, and this lever changes only the sentence. Asserted here
    // so the inconsistency is recorded behaviour rather than an unexamined gap.
    const dir = projectDir('{"dependencies":{"bun":"next"}}')
    check(
        '`next` is still treated as an installable range (install path untouched)',
        findDeclaredRange('bun', dir) === 'next',
        `findDeclaredRange returned ${String(findDeclaredRange('bun', dir))}`
    )
    const text = buildVersionBanner({source: 'declared-range', range: 'next', asked: 'bun'}, 'bun-types', '1.3.14', dir)
    check(
        'and it reaches the declared-range banner, naming `bun`',
        text.startsWith('[VERSION] "bun" resolved to this project\'s declared range next'),
        text.trim()
    )
}

// ── a declaration that IS usable, on a package nobody asked to install ────────
console.log('\nUSABLE DECLARATION OFF THE ASKED NAME — provenance, never a claim the install was pinned')
{
    const dir = projectDir('{"devDependencies":{"@types/bun":"^1.2.0"}}')
    const text = banner(dir)
    check(
        'a real range on @types/bun is cited, but the install is still npm latest',
        text.includes('only its types are, as @types/bun ^1.2.0')
            && text.includes('npm latest (v1.3.14)')
            && !text.includes('pinned to that version'),
        text.trim()
    )
    check(
        'and it does not become an install target for `bun`',
        findDeclaredRange('bun', dir) === null,
        `findDeclaredRange returned ${String(findDeclaredRange('bun', dir))}`
    )
}

// ── the no-banner case ───────────────────────────────────────────────────────
console.log('\nNO PIN — an already-installed package gets NO banner, whatever package.json says')
for (const [label, body] of [
    ['undeclared', '{"dependencies":{"other":"^1"}}'],
    ['declared as latest', '{"devDependencies":{"@types/bun":"latest"}}'],
    ['declared with a real range', '{"dependencies":{"bun":"^1.2.0"}}']
] as Array<[string, string]>) {
    const dir = projectDir(body)
    const text = buildVersionBanner(undefined, 'bun-types', '1.3.14', dir)
    check(`${label} — empty banner`, text === '', JSON.stringify(text))
}

// ── the banner never reports on a package the caller did not ask about ───────
console.log('\nNAMING — the quoted package is always the one asked about')
for (const [label, body] of [
    ['undeclared', '{"dependencies":{"other":"^1"}}'],
    ['declared as latest via @types', '{"devDependencies":{"@types/bun":"latest"}}'],
    ['declared on the terminal only', '{"devDependencies":{"bun-types":"latest"}}']
] as Array<[string, string]>) {
    const dir = projectDir(body)
    const named = banner(dir).split('"')[1]
    check(`${label} — names "bun"`, named === 'bun', `named "${named}"`)
}

fs.rmSync(ROOT, {recursive: true, force: true})
console.log(failures === 0 ? '\nFP SUITE: PASS' : `\nFP SUITE: FAIL (${failures})`)
process.exitCode = failures === 0 ? 0 : 1
