/**
 * launch-config-gap tests — the four static conditions, one per test, plus the
 * shapes that must NOT fire. The dynamic fifth condition (the probe re-run) is
 * exercised end-to-end in scripts/launch-config-gap-ab.ts, where a real child
 * process is the only honest arbiter of "did the absence cause the exit".
 */
import {expect, test, describe} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    bodySourceFiles,
    findLaunchConfigGap,
    probeEnv,
    configGapUnobservedNote,
    CONFIG_GAP_PROBE_VALUE
} from '../../src/task/launch-config-gap.js'

/** mx5's real seed.ts, trimmed to the part that decides the classification. */
const SEED = `const phone = process.env.ADMIN_PHONE;
const password = process.env.ADMIN_PASSWORD;
if (!phone) {
    console.error('Missing required environment variable: ADMIN_PHONE');
    process.exit(1);
}
if (!password) {
    console.error('Missing required environment variable: ADMIN_PASSWORD');
    process.exit(1);
}
`

function withTree(files: Record<string, string>, fn: (cwd: string) => void): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-config-gap-'))
    try {
        for (const [rel, body] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
            fs.writeFileSync(path.join(dir, rel), body)
        }
        fn(dir)
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

describe('bodySourceFiles', () => {
    const tracked = new Set(['src/server/seed.ts', 'src/server/migrate.ts', 'build.ts'])

    test("mx5's shape: `bun run src/server/seed.ts` names the file", () => {
        expect(bodySourceFiles('bun run src/server/seed.ts', tracked)).toEqual([
            'src/server/seed.ts'
        ])
    })

    test('a chained body names every tracked file it runs', () => {
        expect(
            bodySourceFiles('bun run src/server/migrate.ts && bun run src/server/seed.ts', tracked)
        ).toEqual(['src/server/migrate.ts', 'src/server/seed.ts'])
    })

    test('`./` prefixes and quotes are normalised away', () => {
        expect(bodySourceFiles('bun run "./build.ts" --watch', tracked)).toEqual(['build.ts'])
    })

    test('a body naming no tracked file yields nothing — condition 1 ends the check', () => {
        expect(bodySourceFiles('prettier --write . && eslint --fix .', tracked)).toEqual([])
        expect(bodySourceFiles('bun run src/server/unknown.ts', tracked)).toEqual([])
    })
})

describe('findLaunchConfigGap — all four conditions must hold', () => {
    const base = {
        script: 'seed',
        body: 'bun run src/server/seed.ts',
        tracked: ['src/server/seed.ts', '.env.example'],
        declared: new Set(['ADMIN_PHONE', 'ADMIN_PASSWORD', 'DATABASE_URL'])
    }

    test('the mx5 run-20 case: all four hold → a gap naming both variables', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            const gap = findLaunchConfigGap({...base, cwd, env: {}})
            expect(gap).not.toBeNull()
            expect(gap?.script).toBe('seed')
            expect(gap?.file).toBe('src/server/seed.ts')
            expect(gap?.variables).toEqual(['ADMIN_PHONE', 'ADMIN_PASSWORD'])
        })
    })

    test('condition 1: a body naming no tracked source file → null', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            expect(
                findLaunchConfigGap({...base, cwd, body: 'psql -f seed.sql', env: {}})
            ).toBeNull()
        })
    })

    test('condition 2: a DEFAULTED read is not required → null', () => {
        withTree({'src/server/seed.ts': "const p = process.env.ADMIN_PHONE || '+1000';\n"}, cwd => {
            expect(findLaunchConfigGap({...base, cwd, env: {}})).toBeNull()
        })
    })

    test('condition 3: an UNDECLARED variable → null (env-template-closure already failed the gate)', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            expect(
                findLaunchConfigGap({...base, cwd, declared: new Set(['DATABASE_URL']), env: {}})
            ).toBeNull()
        })
    })

    test('condition 3: no template at all → null, so a template-less project gains no excuse', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            expect(findLaunchConfigGap({...base, cwd, declared: new Set(), env: {}})).toBeNull()
        })
    })

    test('condition 4: the variable IS in the env → null', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            const env = {ADMIN_PHONE: '+15550001111', ADMIN_PASSWORD: 'hunter2'}
            expect(findLaunchConfigGap({...base, cwd, env})).toBeNull()
        })
    })

    test('condition 4 is per-variable: one present, one absent → the absent one only', () => {
        withTree({'src/server/seed.ts': SEED}, cwd => {
            const gap = findLaunchConfigGap({...base, cwd, env: {ADMIN_PHONE: '+15550001111'}})
            expect(gap?.variables).toEqual(['ADMIN_PASSWORD'])
        })
    })

    test('an unreadable file is skipped rather than throwing', () => {
        withTree({}, cwd => {
            expect(findLaunchConfigGap({...base, cwd, env: {}})).toBeNull()
        })
    })
})

describe('probeEnv', () => {
    test('supplies a synthetic value per gap variable and touches nothing else', () => {
        const gap = {
            script: 'seed',
            file: 'src/server/seed.ts',
            variables: ['ADMIN_PHONE'],
            reads: []
        }
        const out = probeEnv({PATH: '/usr/bin', HOME: '/home/x'}, gap)
        expect(out).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/x',
            ADMIN_PHONE: CONFIG_GAP_PROBE_VALUE
        })
    })

    test("the value is never .env.example's — that would be a fabricated observation", () => {
        expect(CONFIG_GAP_PROBE_VALUE).not.toBe('change-me')
        expect(CONFIG_GAP_PROBE_VALUE).toContain('pi-task')
    })
})

describe('the record it leaves', () => {
    const gap = {
        script: 'seed',
        file: 'src/server/seed.ts',
        variables: ['ADMIN_PHONE', 'ADMIN_PASSWORD'],
        reads: [
            {
                name: 'ADMIN_PHONE',
                file: 'src/server/seed.ts',
                line: 3,
                construct: 'process.env',
                stepAside: null
            }
        ]
    }

    test('the UNOBSERVED note names the script, the file:line, and every variable', () => {
        const n = configGapUnobservedNote(gap)
        expect(n).toContain('`seed`')
        expect(n).toContain('src/server/seed.ts:3')
        expect(n).toContain('ADMIN_PHONE')
        expect(n).toContain('ADMIN_PASSWORD')
        expect(n).toContain('UNOBSERVED')
        // Never a PASS, and it says what a human should do next.
        expect(n).toContain('bun run seed')
    })
})
