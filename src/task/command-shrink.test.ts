/**
 * command-shrink tests — the resolved-body narrowing rules behind the final-gate
 * scope-shrink guard. Every case here is either the measured lead (mx5 run 19),
 * a hand-read corpus hit, or one of the six pre-registered A/B invariants
 * (scripts/command-shrink-ab.ts). Pure: no fs, no git.
 */
import {describe, expect, test} from 'bun:test'
import {
    classifyBodyChange,
    findNarrowedCommands,
    isStrictSubpath,
    looksLikePath,
    makefileRecipe,
    narrowingRejectionText,
    shapeMember,
    splitChainMembers
} from './command-shrink.js'

describe('tokenizing', () => {
    test('chain members split on &&, ||, ;, | and newlines, quotes respected', () => {
        expect(
            splitChainMembers("prettier --write 'src/**/*.{ts,tsx}' && eslint --fix . ; tsc")
        ).toEqual(["prettier --write 'src/**/*.{ts,tsx}'", 'eslint --fix .', 'tsc'])
        expect(splitChainMembers('pytest -q\nruff check .')).toEqual(['pytest -q', 'ruff check .'])
    })

    test('the verb and script-name slots are not path arguments', () => {
        expect(shapeMember('AGENT=1 bun test').paths).toEqual([])
        expect(shapeMember('bun run test').paths).toEqual([])
        expect(shapeMember('bun run test').key).toBe('bun run test')
        expect(shapeMember('AGENT=1 bun test ./test').paths).toEqual(['./test'])
        expect(shapeMember('AGENT=1 bun test ./test').key).toBe('bun test')
    })

    test('a value-taking flag consumes its value, other args stay paths', () => {
        const s = shapeMember("prettier --log-level warn --write 'src/**/*.{ts,tsx}'")
        expect(s.paths).toEqual(['src/**/*.{ts,tsx}'])
        const p = shapeMember('playwright test -c playwright-ct.config.ts')
        expect(p.paths).toEqual([])
        expect(p.flagValues.get('-c')).toBe('playwright-ct.config.ts')
    })

    test('looksLikePath is lexical', () => {
        expect(looksLikePath('.')).toBe(true)
        expect(looksLikePath('./test')).toBe(true)
        expect(looksLikePath('src/**/*.ts')).toBe(true)
        expect(looksLikePath('jest.config.js')).toBe(true)
        expect(looksLikePath('test')).toBe(false)
        expect(looksLikePath('warn')).toBe(false)
        expect(looksLikePath('--noEmit')).toBe(false)
    })

    test('strict subpaths, with globs cut at the first metacharacter', () => {
        expect(isStrictSubpath('src', 'src/server')).toBe(true)
        expect(isStrictSubpath('src/**/*.ts', 'src/server/**/*.ts')).toBe(true)
        expect(isStrictSubpath('src/server', 'src')).toBe(false)
        expect(isStrictSubpath('src', 'src')).toBe(false)
        expect(isStrictSubpath('.', 'test')).toBe(true)
    })
})

describe('classifyBodyChange', () => {
    test('THE LEAD (mx5 run 19): a path argument added where there was none', () => {
        const c = classifyBodyChange('AGENT=1 bun test', 'AGENT=1 bun test ./test')
        expect(c.cls).toBe('narrow')
        expect(c.kinds).toEqual(['path-added'])
        expect(c.reasons[0]).toContain('./test')
    })

    test('inv-widening-allowed: dropping the path argument again is NOT a narrowing', () => {
        expect(classifyBodyChange('AGENT=1 bun test ./test', 'AGENT=1 bun test').cls).toBe('widen')
    })

    test('an existing path replaced by a strict subpath', () => {
        expect(classifyBodyChange('bun test src', 'bun test src/server').cls).toBe('narrow')
        expect(classifyBodyChange('bun test src/server', 'bun test src').cls).toBe('widen')
    })

    test('a BARE filter argument is a path too — `bun test test` must not dodge the lead', () => {
        expect(classifyBodyChange('AGENT=1 bun test', 'AGENT=1 bun test test').kinds).toEqual([
            'path-added'
        ])
        // …but a flag's bare VALUE is not a path.
        expect(classifyBodyChange('jest', 'jest --maxWorkers 2').cls).toBe('neutral')
    })

    test('KNOWN GAP: a single bare argument sits in the verb slot and is invisible', () => {
        // `eslint src` → `eslint src/server` changes the alignment key, so the
        // rules see two different members rather than a narrowed one. Reported
        // as an observation, never rejected. Closing it needs fs existence,
        // which this module deliberately does not have.
        const c = classifyBodyChange('eslint src', 'eslint src/server')
        expect(c.cls).toBe('neutral')
        expect(c.notes).toEqual([
            'member-removed: `eslint src`',
            'member-added: `eslint src/server`'
        ])
    })

    test('inv-env-and-flags-allowed: env vars, non-restricting flags, reordering', () => {
        expect(classifyBodyChange('bun test', 'AGENT=1 bun test').cls).toBe('neutral')
        expect(classifyBodyChange('bun test', 'bun test --bail --reporter junit').cls).toBe(
            'neutral'
        )
        expect(classifyBodyChange('eslint . && tsc --noEmit', 'tsc --noEmit && eslint .').cls).toBe(
            'neutral'
        )
    })

    test('an exclusion flag added is a narrowing', () => {
        const c = classifyBodyChange('bun test', "bun test --path-ignore-patterns '**/*.spec.tsx'")
        expect(c.cls).toBe('narrow')
        expect(c.kinds).toEqual(['exclusion-added'])
        expect(classifyBodyChange('jest', 'jest --testPathIgnorePatterns e2e').cls).toBe('narrow')
        // removing one widens
        expect(classifyBodyChange('jest --ignore e2e', 'jest').cls).toBe('widen')
    })

    test('mx5@a9c6145: an exclusion is EXCUSED when the pass relocates the input to another gate command', () => {
        const before = 'AGENT=1 bun test'
        const after =
            "AGENT=1 bun test --path-ignore-patterns '**/*.spec.tsx' && playwright test -c playwright-ct.config.ts"
        expect(
            classifyBodyChange(before, after, {
                siblingBodies: ['playwright test -c playwright-ct.config.ts']
            }).cls
        ).toBe('neutral')
        // …but only for a VERBATIM sibling: a near-copy is not a relocation.
        expect(
            classifyBodyChange(before, after, {
                siblingBodies: ['playwright test -c playwright.config.ts']
            }).cls
        ).toBe('narrow')
        // …and `&& echo ok` never excuses anything.
        expect(
            classifyBodyChange(before, `AGENT=1 bun test --ignore x && echo ok`, {
                siblingBodies: ['playwright test -c playwright-ct.config.ts']
            }).cls
        ).toBe('narrow')
    })

    test('rule 4 fires only with provenance: the config file was created by this pass', () => {
        const before = 'playwright test -c playwright.config.ts'
        const after = 'playwright test -c playwright.smoke.ts'
        expect(classifyBodyChange(before, after).cls).toBe('neutral')
        expect(
            classifyBodyChange(before, after, {createdByFix: p => p === 'playwright.smoke.ts'}).cls
        ).toBe('narrow')
    })

    test('a removed chain member is an observation, never a rejection', () => {
        const c = classifyBodyChange('eslint . && tsc --noEmit', 'eslint .')
        expect(c.cls).toBe('neutral')
        expect(c.notes).toEqual(['member-removed: `tsc --noEmit`'])
    })

    test('an unchanged body classifies neutral without parsing', () => {
        expect(classifyBodyChange('bun test', 'bun test ').cls).toBe('neutral')
    })

    test('BYPASS: the `--flag=value` form of an exclusion counts the same', () => {
        const c = classifyBodyChange('jest', 'jest --ignore=e2e')
        expect(c.kinds).toEqual(['exclusion-added'])
        expect(c.reasons[0]).toContain('--ignore')
        // …and the short form.
        expect(classifyBodyChange('mocha', 'mocha -x slow').kinds).toEqual(['exclusion-added'])
    })

    test('BYPASS: a separator inside quotes does not split the body', () => {
        expect(splitChainMembers("bun test -t 'a && b'")).toEqual(["bun test -t 'a && b'"])
        expect(splitChainMembers('a || b | c')).toEqual(['a', 'b', 'c'])
        // A quoted `&&` must not look like a whole new chain member.
        expect(classifyBodyChange('bun test', "bun test -t 'a && b'").notes).toEqual([])
    })

    test('duplicate member keys align in declaration order', () => {
        const c = classifyBodyChange('bun test a && bun test b', 'bun test a && bun test b/sub')
        expect(c.kinds).toEqual(['path-narrowed'])
        expect(c.reasons[0]).toContain('b/sub')
        expect(c.notes).toEqual([])
    })

    test('a config flag ADDED (not swapped) counts when the pass created the file', () => {
        const c = classifyBodyChange('playwright test', 'playwright test -c smoke.ts', {
            createdByFix: p => p === 'smoke.ts'
        })
        expect(c.kinds).toEqual(['config-swapped'])
    })
})

describe('makefileRecipe (inv-makefile-parity)', () => {
    const mk = 'lint:\n\truff check .\n\ntest: deps\n\t@pytest -q \\\n\t\t--maxfail=1\n\nother:\n'

    test('recipe lines are extracted, continuations folded, prefixes kept out of the verb', () => {
        expect(makefileRecipe(mk, 'lint')).toBe('ruff check .')
        expect(makefileRecipe(mk, 'test')).toBe('@pytest -q  --maxfail=1')
        expect(makefileRecipe(mk, 'other')).toBeNull()
        expect(makefileRecipe(mk, 'missing')).toBeNull()
        expect(shapeMember('@pytest -q').key).toBe('pytest')
    })

    test('a Makefile target gaining a directory argument narrows identically', () => {
        const before = makefileRecipe('test:\n\tpytest -q\n', 'test')!
        const after = makefileRecipe('test:\n\tpytest -q tests/unit\n', 'test')!
        expect(classifyBodyChange(before, after).kinds).toEqual(['path-added'])
    })
})

describe('findNarrowedCommands', () => {
    test('only labels present on BOTH sides are compared (vanished labels are the label guard’s)', () => {
        const before = {'bun run test': 'bun test', 'bun run lint': 'eslint .'}
        const after = {'bun run test': 'bun test ./test'}
        const n = findNarrowedCommands(before, after)
        expect(n.map(x => x.label)).toEqual(['bun run test'])
        expect(narrowingRejectionText(n)).toContain('bun run test')
        expect(narrowingRejectionText(n)).toContain('AGENT=1'.slice(0, 0) + 'bun test ./test')
    })

    test('every narrowed label is reported; the rejection text names the first and counts the rest', () => {
        const before = {'bun run test': 'bun test', 'bun run lint': 'eslint .'}
        const after = {'bun run test': 'bun test ./test', 'bun run lint': 'eslint . --ignore dist'}
        const n = findNarrowedCommands(before, after)
        expect(n.map(x => x.label)).toEqual(['bun run test', 'bun run lint'])
        expect(narrowingRejectionText(n)).toContain('(+1 more)')
    })

    test('sibling bodies come from the post-fix map, so a relocation excuses itself', () => {
        const before = {'bun run test': 'bun test', 'bun run test:ct': 'playwright test -c ct.ts'}
        const after = {
            'bun run test':
                "bun test --path-ignore-patterns '**/*.spec.tsx' && playwright test -c ct.ts",
            'bun run test:ct': 'playwright test -c ct.ts'
        }
        expect(findNarrowedCommands(before, after)).toEqual([])
    })
})
