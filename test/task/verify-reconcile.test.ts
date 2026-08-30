/**
 * verify-reconcile tests — the deterministic plan-contradiction scanner.
 *
 * The fixtures are one VERIFY check that asserts a deliverable is ABSENT, two
 * that assert a style rule is absent and must stay silent, and the sibling task
 * titles and API contracts the scanner reconciles those against.
 */
import {describe, expect, test} from 'bun:test'
import {
    findAbsenceAssertions,
    findAbsenceConflicts,
    absenceProbeText,
    siblingTitlesFromPlanContext,
    type AbsenceConflictContext
} from '../../src/task/verify-reconcile.js'
import {buildScopeFence} from '../../src/task/auto-orchestrator.js'

/** Wrap bash lines as a minimal spec with a VERIFY block. */
function spec(lines: string[]): string {
    return `GOAL\nx\n\nVERIFY:\n\`\`\`bash\n${lines.join('\n')}\n\`\`\`\n`
}

// Check 7 is the defect; checks 5 and 6 are style/scope greps that must stay
// silent.
const RUN11_CHECK_5 = [
    `if grep -rn 'rounded-[0-9]\\{2,\\}' src/client/ --include='*.tsx' --include='*.ts'; then`,
    '  echo "FAIL: Found border-radius > 4px"',
    '  exit 1',
    'fi'
]
const RUN11_CHECK_6 = [
    `if grep -rn 'fetch(' src/client/ --include='*.tsx' --include='*.ts' | grep -v 'node_modules'; then`,
    '  echo "FAIL: Found direct fetch() calls"',
    '  exit 1',
    'fi'
]
const RUN11_CHECK_7 = [
    `if [ -f src/client/pages/admin.tsx ] || grep -rn 'Admin' src/client/pages/ --include='*.tsx' --include='*.ts' | grep -v 'role\\|admin_user\\|isAdmin'; then`,
    '  echo "FAIL: Admin panel page found — scope is purely client-facing user pages only."',
    '  exit 1',
    'fi'
]

// Plan titles in the stamped shape: a head, an em dash, then the detail.
const RUN11_TITLES = [
    'Scaffold project structure — package.json, tsconfig, ESLint, Prettier, docker-compose Postgres 18, Bun SQL connection, migrations runner, admin seed script',
    'Implement authentication layer — argon2id password hashing, cookie sessions in Postgres, login/logout/me routes, session middleware with requireAuth/requireAdmin guards',
    'Implement admin features — user listing with ban/unban toggle, cross-user listing deletion, /admin page with moderation UI',
    'Polish and finalize — empty/error/loading states, responsive layout, branded placeholder for listings without photos, final brand pass'
]
// The last title is THIS task; the first three are its siblings.
const RUN11_SIBLINGS = RUN11_TITLES.slice(0, 3)

const RUN11_CONTRACTS = [
    '"`GET /api/admin/users` → all users (id, phone, display_name, role, is_banned, listing count)" [anchor: 5. API]',
    '"`POST /api/auth/login` `{ phone, password }` → sets session cookie, returns user" [anchor: 5. API]'
].join('\n')

const noDisk: AbsenceConflictContext = {
    fileExists: () => false,
    siblingTitles: [],
    contracts: ''
}

describe('findAbsenceAssertions', () => {
    test('run-11 check #7: if [ -f P ] || grep PAT …; then exit 1 yields both targets', () => {
        const a = findAbsenceAssertions(spec(RUN11_CHECK_7))
        expect(a.map(x => [x.kind, x.target])).toEqual([
            ['path', 'src/client/pages/admin.tsx'],
            ['pattern', 'Admin']
        ])
    })

    test('the piped grep -v filter is never a probe', () => {
        const a = findAbsenceAssertions(spec(RUN11_CHECK_7))
        expect(a.some(x => x.target.includes('admin_user'))).toBe(false)
    })

    test('standalone negated probes assert absence', () => {
        const a = findAbsenceAssertions(
            spec(['[ ! -f dist/legacy.js ] || exit 1', 'test ! -d old/', "! grep -r 'TODO' src/"])
        )
        expect(a.map(x => x.target)).toEqual(['dist/legacy.js', 'old/', 'TODO'])
    })

    test('a NEGATED probe inside if…exit 1 asserts PRESENCE, not absence — silent', () => {
        expect(
            findAbsenceAssertions(
                spec(['if [ ! -f package.json ]; then', '  echo FAIL', '  exit 1', 'fi'])
            )
        ).toEqual([])
    })

    test('positive probes outside an if are presence checks — silent', () => {
        expect(
            findAbsenceAssertions(
                spec(['[ -f package.json ] || exit 1', 'grep -q name package.json'])
            )
        ).toEqual([])
    })

    test('an if block without exit 1 contributes nothing', () => {
        expect(
            findAbsenceAssertions(
                spec(['if [ -f notes.md ]; then', '  echo "notes present"', 'fi'])
            )
        ).toEqual([])
    })

    test('no VERIFY block ⇒ no assertions', () => {
        expect(findAbsenceAssertions('GOAL\nno verify here')).toEqual([])
    })
})

describe('findAbsenceConflicts (the plan-contradiction lever)', () => {
    test('run-11 regression: check #7 conflicts on disk, sibling title, and contract', () => {
        const conflicts = findAbsenceConflicts(spec(RUN11_CHECK_7), {
            fileExists: p => p === 'src/client/pages/admin.tsx',
            siblingTitles: RUN11_SIBLINGS,
            contracts: RUN11_CONTRACTS
        })
        const kinds = conflicts.map(c => `${c.assertion.target}:${c.against}`)
        expect(kinds).toContain('src/client/pages/admin.tsx:disk')
        expect(kinds).toContain('src/client/pages/admin.tsx:sibling')
        expect(kinds).toContain('Admin:sibling')
        expect(kinds).toContain('src/client/pages/admin.tsx:contract')
    })

    test('run-11 checks #5/#6 (style/scope greps) are silent against the same plan', () => {
        expect(
            findAbsenceConflicts(spec([...RUN11_CHECK_5, ...RUN11_CHECK_6]), {
                fileExists: () => false,
                siblingTitles: RUN11_SIBLINGS,
                contracts: RUN11_CONTRACTS
            })
        ).toEqual([])
    })

    test('a phantom-module grep is NOT a conflict with a "Bun SQL connection" sibling (substring, not all-words)', () => {
        const s = spec([
            "if grep -rn 'bun:sql' src/; then",
            '  echo "FAIL: bun:sql is not a module"',
            '  exit 1',
            'fi'
        ])
        expect(
            findAbsenceConflicts(s, {
                fileExists: () => false,
                siblingTitles: RUN11_SIBLINGS,
                contracts: RUN11_CONTRACTS
            })
        ).toEqual([])
    })

    test('an absence target nothing pins is silent (delete-task shape without collisions)', () => {
        expect(
            findAbsenceConflicts(spec(['[ ! -f src/legacy/old-parser.ts ] || exit 1']), noDisk)
        ).toEqual([])
    })

    test('disk existence alone fires (a prior task shipped the file)', () => {
        const conflicts = findAbsenceConflicts(spec(['[ ! -f src/shared/schema.ts ] || exit 1']), {
            ...noDisk,
            fileExists: p => p === 'src/shared/schema.ts'
        })
        expect(conflicts).toHaveLength(1)
        expect(conflicts[0].against).toBe('disk')
    })

    test('basename word-bounding: admin does not match administrative', () => {
        const conflicts = findAbsenceConflicts(spec(['[ ! -f pages/admin.tsx ] || exit 1']), {
            ...noDisk,
            siblingTitles: ['Build the administrative reporting export']
        })
        expect(conflicts).toEqual([])
    })
})

describe('absenceProbeText', () => {
    test('names the target, the collision, and the delete-task escape hatch', () => {
        const conflicts = findAbsenceConflicts(spec(RUN11_CHECK_7), {
            fileExists: () => false,
            siblingTitles: RUN11_SIBLINGS,
            contracts: ''
        })
        const text = absenceProbeText(conflicts)
        expect(text).toContain('src/client/pages/admin.tsx')
        expect(text).toContain("SIBLING task's deliverable")
        expect(text).toContain('explicitly deletes')
        expect(text).toContain('overrides a CLEAN triage')
    })
})

describe('siblingTitlesFromPlanContext', () => {
    test('parses buildScopeFence output, excluding THIS STEP', () => {
        const fence = buildScopeFence(
            ['Implement admin features — /admin page', 'Polish and finalize — brand pass'],
            1
        )
        expect(siblingTitlesFromPlanContext(fence)).toEqual([
            'Implement admin features — /admin page'
        ])
    })

    test('no plan context (bare /task) ⇒ no siblings', () => {
        expect(siblingTitlesFromPlanContext(undefined)).toEqual([])
        expect(siblingTitlesFromPlanContext('')).toEqual([])
    })
})
