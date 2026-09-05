import {test, expect} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {writeGitignore} from '../../scripts/docs-live-seed.js'

// `autoCommit` is on in the runner, so whatever is untracked at seed time gets
// committed by the first task. In the 2026-09-06 re-run that was 1397 files under
// `node_modules/` in ts, `target/` in rs and `dist-newstyle/` in hs — after which
// every `cargo build` a child ran dirtied tracked state and the git-state guard
// discarded its verify. rs TASK_0003 spent a turn recovering from it.
const BUILD_DIR: Record<string, string> = {
    npm: 'node_modules',
    cargo: 'target',
    hackage: 'dist-newstyle'
}

for (const [ecosystem, dir] of Object.entries(BUILD_DIR)) {
    test(`a seeded ${ecosystem} project does not track ${dir}/`, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-gitignore-'))
        try {
            fs.mkdirSync(path.join(root, dir), {recursive: true})
            fs.writeFileSync(path.join(root, dir, 'artifact'), 'built\n')
            fs.writeFileSync(path.join(root, 'kept.txt'), 'source\n')
            writeGitignore(root, ecosystem)
            for (const args of [
                ['init', '-q'],
                ['config', 'user.email', 'live@example.com'],
                ['config', 'user.name', 'docs live'],
                ['add', '-A'],
                ['commit', '-q', '-m', 'seed']
            ]) {
                execFileSync('git', args, {cwd: root, stdio: 'ignore'})
            }
            const tracked = execFileSync('git', ['ls-files'], {
                cwd: root,
                encoding: 'utf8'
            })
            expect(tracked).toContain('kept.txt')
            expect(tracked).not.toContain(`${dir}/`)
        } finally {
            fs.rmSync(root, {recursive: true, force: true})
        }
    })
}
