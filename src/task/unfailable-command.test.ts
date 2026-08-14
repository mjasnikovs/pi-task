import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import {classifyExitStatus, isUnfailableCommand} from './unfailable-command.js'

/** Ask the shell what a command really does — the claim is about a shell. */
function exitStatus(cmd: string, env: Record<string, string> = {}): number | null {
    const r = spawnSync('bash', ['-c', cmd], {
        encoding: 'utf8',
        timeout: 20_000,
        env: {...process.env, ...env}
    })
    return r.status
}

describe('unfailable-command — rule C, the chain whose terminal branches are echoes', () => {
    test('the IAR1 TASK_0003 shape is unfailable, and the shell agrees', () => {
        const cmd = 'test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"'
        expect(classifyExitStatus(cmd)).toMatchObject({cls: 'unfailable'})
        // The library is genuinely absent, and the command still exits 0.
        expect(exitStatus(cmd, {SO_LIB: '/nonexistent/lib.so'})).toBe(0)
    })

    test('printf counts as a pure branch', () => {
        expect(isUnfailableCommand('test -d build && echo ok || printf "%s\\n" "no"')).toBe(true)
    })

    test('a branch that EXITS is not an echo — the command can fail', () => {
        const cmd = 'test -f "$SO_LIB" || { echo "FAIL: not found"; exit 1; }'
        expect(classifyExitStatus(cmd).cls).toBe('can-fail')
        expect(exitStatus(cmd, {SO_LIB: '/nonexistent/lib.so'})).not.toBe(0)
    })

    test('a plain && chain of real commands is untouched', () => {
        expect(isUnfailableCommand('cmake --build build && ctest --test-dir build')).toBe(false)
    })

    test('an echo FIRST does not make the chain unfailable — the LAST branch decides', () => {
        expect(isUnfailableCommand('echo "checking" && test -f dist/index.html')).toBe(false)
    })

    test('a lone echo is not a chain, so rule C does not reach it', () => {
        expect(isUnfailableCommand('echo "PASS"')).toBe(false)
    })

    test('an echo that REDIRECTS can fail on the write, so it is not a pure branch', () => {
        expect(
            isUnfailableCommand('test -f x && echo ok > /root/out.txt || echo no > /root/out.txt')
        ).toBe(false)
    })
})

describe('unfailable-command — rule B, `$?` read after a pipeline', () => {
    test('the mx5 TASK_0025 typecheck shape is unfailable', () => {
        const cmd =
            'npx tsc --noEmit 2>&1 | tail -5; test $? -eq 0 && echo "PASS: typecheck clean" '
            + '|| echo "NOTE: typecheck may need dependencies installed"'
        expect(classifyExitStatus(cmd)).toMatchObject({cls: 'unfailable'})
    })

    test('`$?` after a pipeline holds the FILTER’s status — measured', () => {
        // The left side fails; the pipeline's status is tail's, which is 0.
        expect(exitStatus('false 2>&1 | tail -5; test $? -eq 0')).toBe(0)
    })

    test('`$?` after a NON-pipeline is a real status', () => {
        expect(isUnfailableCommand('test -f x; test $? -eq 0')).toBe(false)
    })
})

describe('unfailable-command — rule A, console.assert', () => {
    test('console.assert never exits non-zero — measured in bun', () => {
        expect(exitStatus(`bun -e "console.assert(1===2,'X'); console.log('end')"`)).toBe(0)
    })

    test('the mx5 TASK_0017 shape is unfailable', () => {
        expect(
            isUnfailableCommand(`bun -e "console.assert(typeof api === 'object', 'shape')"`)
        ).toBe(true)
    })

    test('console.assert alongside a REAL exit path is left alone', () => {
        expect(isUnfailableCommand('bun -e "console.assert(x); if (!x) process.exit(1)"')).toBe(
            false
        )
    })
})

describe('unfailable-command — the boundaries that are not ours', () => {
    test('bare `|| true` stays OUT OF SCOPE (skip-escape.ts:11-19 measured the FPs)', () => {
        expect(isUnfailableCommand('rm -rf build || true')).toBe(false)
    })

    test('a real check with a real status is untouched', () => {
        expect(isUnfailableCommand("grep -q 'hc<AppType>' src/client/api.ts")).toBe(false)
    })

    test('a leading VAR= assignment does not hide the command word', () => {
        expect(isUnfailableCommand('AGENT=1 bun test test/listings.test.ts')).toBe(false)
    })
})

describe('unfailable-command — undecidable is a first-class answer', () => {
    test('`set -e` changes what a non-zero status DOES, so nothing is claimed', () => {
        expect(classifyExitStatus('set -e ; test -f "$SO_LIB" && echo ok').cls).toBe('unknown')
    })

    test('a whole-line command substitution has its status somewhere else', () => {
        expect(classifyExitStatus('$(cat scripts/verify.sh)').cls).toBe('unknown')
    })

    test('an unknown verdict is NOT unfailable — nothing is refused on a guess', () => {
        expect(isUnfailableCommand('set -e ; test -f x && echo ok')).toBe(false)
    })
})

describe('unfailable-command — the splitter respects quoting', () => {
    test('a `;` inside quotes does not split the line', () => {
        expect(isUnfailableCommand('echo "a; b" && test -f x || exit 1')).toBe(false)
    })

    test('a `&&` inside quotes does not split the chain', () => {
        expect(isUnfailableCommand('grep -q "a && b" src/x.ts')).toBe(false)
    })

    test('a braced group is one branch, not two', () => {
        expect(isUnfailableCommand('test -f x || { echo a; echo b; }')).toBe(false)
    })

    test('the empty command is not a claim', () => {
        expect(classifyExitStatus('   ').cls).toBe('can-fail')
    })
})
