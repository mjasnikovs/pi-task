/**
 * env-template-closure tests — the six mechanical rules that decide REQUIRED, each
 * pinned by the real read that demanded it during STEP 0 (see
 * `scripts/env-template-closure-baserate.ts` for the corpus numbers).
 */
import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    findMissingEnvDeclarations,
    isAmbient,
    parseTemplate,
    scanEnvTemplateClosure,
    scanSource,
    envGateFailureText
} from './env-template-closure.js'

const required = (text: string, file = 'src/a.ts'): string[] =>
    scanSource(file, text)
        .filter(r => r.stepAside === null)
        .map(r => r.name)

const asideOf = (text: string, name: string, file = 'src/a.ts'): string | null | undefined =>
    scanSource(file, text).find(r => r.name === name)?.stepAside

describe('parseTemplate', () => {
    test('a bare `X=` line declares X; comments and blanks do not', () => {
        expect(parseTemplate('DATABASE_URL=postgres://x\n# ADMIN_PHONE=\n\nAPP_URL=\n')).toEqual([
            'DATABASE_URL',
            'APP_URL'
        ])
        expect(parseTemplate('export SECRET=1\n')).toEqual(['SECRET'])
    })
})

describe('required reads', () => {
    test('a bare consumption is required', () => {
        expect(required('const s = new SQL(process.env.DATABASE_URL)')).toEqual(['DATABASE_URL'])
        expect(required("const s = process.env['DATABASE_URL']")).toEqual(['DATABASE_URL'])
        expect(required('const s = Bun.env.DATABASE_URL')).toEqual(['DATABASE_URL'])
    })

    test('THE LEAD: assign, then a negated guard that STOPS (mx5 seed.ts)', () => {
        const src = [
            'const phone = process.env.ADMIN_PHONE',
            'const password = process.env.ADMIN_PASSWORD',
            "const displayName = process.env.ADMIN_DISPLAY_NAME ?? 'Admin'",
            '',
            "if (!phone) throw new Error('ADMIN_PHONE environment variable is required')",
            "if (!password) throw new Error('ADMIN_PASSWORD environment variable is required')"
        ].join('\n')
        expect(required(src)).toEqual(['ADMIN_PHONE', 'ADMIN_PASSWORD'])
    })

    test('non-JS ecosystems read the same way', () => {
        expect(required('db = os.environ["DATABASE_URL"]', 'app/main.py')).toEqual(['DATABASE_URL'])
        expect(required('k = os.environ.get("MODE")', 'app/main.py')).toEqual(['MODE'])
        expect(required('dsn := os.Getenv("DATABASE_URL")', 'main.go')).toEqual(['DATABASE_URL'])
    })
})

describe('the step-aside rules', () => {
    test('rule 1 — a default, in every shape STEP 0 met', () => {
        expect(asideOf("const u = process.env.APP_URL || 'http://x'", 'APP_URL')).toBe('default')
        expect(asideOf("const u = process.env.APP_URL ?? 'http://x'", 'APP_URL')).toBe('default')
        // wrapped in a call — `Number(process.env.X) || 32` (gofer-rag)
        expect(asideOf('const n = Number(process.env.RAG_BATCH) || 32', 'RAG_BATCH')).toBe(
            'default'
        )
        // behind an accessor chain — `process.env.X?.trim() || '…'` (push.ts)
        expect(asideOf("const p = process.env.PUSH_LOG?.trim() || '/tmp/x'", 'PUSH_LOG')).toBe(
            'default'
        )
        // the read IS the fallback — `A ?? process.env.B` (brave-warning.ts)
        expect(
            asideOf(
                'const k = process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY',
                'BRAVE_API_KEY'
            )
        ).toBe('default')
        // a ternary names both outcomes (gofer-rag `npm_execpath`)
        expect(asideOf("const c = process.env.PY ? [process.env.PY] : ['python3']", 'PY')).toBe(
            'default'
        )
        // continuation line
        expect(asideOf("const u =\n    process.env.APP_URL\n    ?? 'http://x'", 'APP_URL')).toBe(
            'default'
        )
        // two-argument getenv
        expect(asideOf('r = os.getenv("AWS_REGION", "eu-north-1")', 'AWS_REGION')).toBe('default')
    })

    test('rule 2 — compared, not consumed', () => {
        expect(asideOf("if (process.env.MODE === 'production') x()", 'MODE')).toBe('compared')
        expect(asideOf("if ('production' === process.env.MODE) x()", 'MODE')).toBe('compared')
        // Go's defaulting idiom, past the call's closing paren
        expect(asideOf('if os.Getenv("FEATURE_X") == "" { }', 'FEATURE_X', 'main.go')).toBe(
            'compared'
        )
    })

    test('rule 3 — a write, not a read (assignment, delete, save/restore)', () => {
        expect(asideOf("process.env.DATABASE_URL = 'postgres://test'", 'DATABASE_URL')).toBe(
            'assigned'
        )
        expect(asideOf('delete process.env.GOFER_GDFORMAT', 'GOFER_GDFORMAT')).toBe('assigned')
        // the test save/restore idiom: the file writes it, so its reads are not
        // requirements (push.test.ts)
        const saveRestore = [
            'let prev',
            'beforeEach(() => { prev = process.env.PUSH_SUBJECT })',
            'afterEach(() => { process.env.PUSH_SUBJECT = prev })'
        ].join('\n')
        expect(asideOf(saveRestore, 'PUSH_SUBJECT')).toBe('assigned')
    })

    test('rule 4 — ambient, by name and by platform prefix', () => {
        expect(isAmbient('NODE_ENV')).toBe(true)
        expect(isAmbient('LOCALAPPDATA')).toBe(true)
        expect(isAmbient('npm_execpath')).toBe(true)
        expect(isAmbient('GITHUB_ENV')).toBe(true)
        expect(isAmbient('XDG_CACHE_HOME')).toBe(true)
        expect(isAmbient('ADMIN_PHONE')).toBe(false)
        expect(isAmbient('DATABASE_URL')).toBe(false)
    })

    test('rule 5 — a presence probe, and the sign of the guard that separates it from the lead', () => {
        // positive guard ⇒ an override (pi-invocation.ts), including the
        // consuming read inside the guarded branch
        const probe = 'if (process.env.PI_BIN) {\n    return {command: process.env.PI_BIN}\n}'
        expect(asideOf(probe, 'PI_BIN')).toBe('probe')
        // negated guard that only RETURNS ⇒ an optional flag (push.ts)
        expect(asideOf('if (!process.env.PUSH_DEBUG) return', 'PUSH_DEBUG')).toBe('probe')
        // negated guard that THROWS ⇒ required (gofer's wdio journey)
        expect(
            asideOf(
                "if (!process.env.GODOT_BIN) {\n    throw new Error('required')\n}",
                'GODOT_BIN'
            )
        ).toBeNull()
        // assign-then-positive-guard ⇒ an override (render-check.ts CHROME_BIN)
        expect(asideOf('const c = process.env.CHROME_BIN\nif (c) return c', 'CHROME_BIN')).toBe(
            'probe'
        )
    })

    test('opaque forms step aside entirely', () => {
        expect(required('const {DATABASE_URL} = process.env')).toEqual([])
        expect(required('const v = process.env[key]')).toEqual([])
        expect(required('// process.env.ADMIN_PHONE is required')).toEqual([])
    })
})

// ── tree-level ────────────────────────────────────────────────────────────────

function makeRepo(files: Record<string, string>, untracked: Record<string, string> = {}): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-closure-'))
    const write = (rel: string, body: string): void => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
        fs.writeFileSync(path.join(dir, rel), body)
    }
    for (const [rel, body] of Object.entries(files)) write(rel, body)
    spawnSync('git', ['init', '-q'], {cwd: dir})
    spawnSync('git', ['add', '-A'], {cwd: dir})
    spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], {
        cwd: dir
    })
    for (const [rel, body] of Object.entries(untracked)) write(rel, body)
    return dir
}

describe('scanEnvTemplateClosure', () => {
    test('the lead: a required read the template never declares', () => {
        const dir = makeRepo({
            '.env.example': 'DATABASE_URL=postgres://x\n',
            'src/seed.ts': 'const p = process.env.ADMIN_PHONE\nif (!p) throw new Error("x")\n'
        })
        const {missing, templates} = findMissingEnvDeclarations(dir)
        expect(templates).toEqual(['.env.example'])
        expect(missing.map(m => m.name)).toEqual(['ADMIN_PHONE'])
        expect(envGateFailureText(missing[0], templates)).toContain('src/seed.ts:1')
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('inv-no-template-no-finding — no tracked template ⇒ inert', () => {
        const dir = makeRepo({
            'src/seed.ts': 'const p = process.env.ADMIN_PHONE\nif (!p) throw new Error("x")\n'
        })
        expect(scanEnvTemplateClosure(dir).missing).toHaveLength(0)
        expect(scanEnvTemplateClosure(dir).templates).toHaveLength(0)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('inv-declared-silent — a declared variable is silent however it is read', () => {
        const dir = makeRepo({
            '.env.example': 'ADMIN_PHONE=\n',
            'src/seed.ts': 'const p = process.env.ADMIN_PHONE\nif (!p) throw new Error("x")\n'
        })
        expect(scanEnvTemplateClosure(dir).missing).toHaveLength(0)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('inv-untracked-invisible — untracked reads and untracked templates are both invisible', () => {
        const dir = makeRepo(
            {'.env.example': 'DATABASE_URL=\n', '.gitignore': 'scratch.ts\n.env\n'},
            {
                'scratch.ts':
                    'const k = process.env.IGNORED_SECRET\nif (!k) throw new Error("x")\n',
                'untracked.ts':
                    'const k = process.env.OTHER_SECRET\nif (!k) throw new Error("x")\n',
                '.env.sample': '# untracked template\n',
                '.env': 'DATABASE_URL=postgres://local\n'
            }
        )
        const c = scanEnvTemplateClosure(dir)
        expect(c.templates).toEqual(['.env.example'])
        expect(c.missing).toHaveLength(0)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('inv-idempotent — two scans, same findings', () => {
        const dir = makeRepo({
            '.env.example': 'DATABASE_URL=\n',
            'src/seed.ts': 'const p = process.env.ADMIN_PHONE\nif (!p) throw new Error("x")\n'
        })
        const key = (): string =>
            scanEnvTemplateClosure(dir)
                .missing.map(m => `${m.name}@${m.file}:${m.line}`)
                .join('|')
        expect(key()).toBe(key())
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('one finding per VARIABLE, not per read site', () => {
        const dir = makeRepo({
            '.env.example': 'DATABASE_URL=\n',
            'src/a.ts': 'const p = process.env.ADMIN_PHONE\nif (!p) throw new Error("x")\n',
            'src/b.ts': 'const q = process.env.ADMIN_PHONE\nif (!q) throw new Error("x")\n'
        })
        expect(scanEnvTemplateClosure(dir).missing).toHaveLength(2)
        expect(findMissingEnvDeclarations(dir).missing.map(m => m.name)).toEqual(['ADMIN_PHONE'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('not a git work tree ⇒ inert (never guesses at tracked state)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-closure-bare-'))
        fs.writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=\n')
        fs.writeFileSync(path.join(dir, 'seed.ts'), 'const p = process.env.ADMIN_PHONE\n')
        expect(scanEnvTemplateClosure(dir).missing).toHaveLength(0)
        fs.rmSync(dir, {recursive: true, force: true})
    })
})
