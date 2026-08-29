import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    extensionLabel,
    listInstalledExtensions,
    selfPackageRoot
} from '../../src/config/extension-list.js'

/** Scratch pi home + project cwd so enumeration never touches the real ~/.pi. */
function scratch(): {agentDir: string; cwd: string; cleanup: () => void} {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-extlist-'))
    const agentDir = path.join(root, 'agent')
    const cwd = path.join(root, 'work')
    fs.mkdirSync(path.join(agentDir, 'extensions'), {recursive: true})
    fs.mkdirSync(cwd, {recursive: true})
    return {agentDir, cwd, cleanup: () => fs.rmSync(root, {recursive: true, force: true})}
}

describe('extensionLabel', () => {
    test('package sources keep their package identity', () => {
        expect(
            extensionLabel('/x/node_modules/pi-lmstudio/extensions/a/index.ts', 'npm:pi-lmstudio')
        ).toBe('pi-lmstudio')
    })

    test('loose files read as the file stem; index files as their directory', () => {
        expect(extensionLabel('/home/u/.pi/agent/extensions/omarchy-system-theme.ts', 'auto')).toBe(
            'omarchy-system-theme'
        )
        expect(extensionLabel('/home/u/.pi/agent/extensions/my-ext/index.js', 'auto')).toBe(
            'my-ext'
        )
    })
})

describe('selfPackageRoot', () => {
    test('walks up to the nearest package.json', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-selfroot-'))
        fs.mkdirSync(path.join(dir, 'dist', 'config'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'package.json'), '{}')
        try {
            expect(selfPackageRoot(path.join(dir, 'dist', 'config'))).toBe(dir)
        } finally {
            fs.rmSync(dir, {recursive: true, force: true})
        }
    })

    test('resolves to pi-task itself at runtime (the entry that must be excluded)', () => {
        const root = selfPackageRoot()
        expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true)
    })
})

describe('listInstalledExtensions', () => {
    test('lists dir-discovered extensions with label and origin', async () => {
        const s = scratch()
        try {
            fs.writeFileSync(path.join(s.agentDir, 'extensions', 'my-provider.ts'), '// ext\n')
            const got = await listInstalledExtensions({
                cwd: s.cwd,
                agentDir: s.agentDir,
                selfRoot: path.join(s.agentDir, 'nowhere')
            })
            expect(got).toHaveLength(1)
            expect(got[0]!.label).toBe('my-provider')
            expect(got[0]!.path).toBe(path.join(s.agentDir, 'extensions', 'my-provider.ts'))
            expect(got[0]!.origin).toContain('user')
        } finally {
            s.cleanup()
        }
    })

    test('excludes anything under pi-task itself (never whitelist self into children)', async () => {
        const s = scratch()
        try {
            fs.writeFileSync(path.join(s.agentDir, 'extensions', 'other.ts'), '// ext\n')
            // Treating the whole discovery dir as "self" must empty the list.
            const got = await listInstalledExtensions({
                cwd: s.cwd,
                agentDir: s.agentDir,
                selfRoot: s.agentDir
            })
            expect(got).toEqual([])
        } finally {
            s.cleanup()
        }
    })

    test('a configured package whose install is missing is skipped, not an interactive prompt', async () => {
        const s = scratch()
        try {
            fs.writeFileSync(
                path.join(s.agentDir, 'settings.json'),
                JSON.stringify({packages: ['npm:this-is-not-installed-anywhere']})
            )
            fs.writeFileSync(path.join(s.agentDir, 'extensions', 'present.ts'), '// ext\n')
            const got = await listInstalledExtensions({
                cwd: s.cwd,
                agentDir: s.agentDir,
                selfRoot: path.join(s.agentDir, 'nowhere')
            })
            expect(got.map(e => e.label)).toEqual(['present'])
        } finally {
            s.cleanup()
        }
    })
})
