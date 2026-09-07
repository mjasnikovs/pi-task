import {test, expect} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {cargoManifest, writeGitignore} from '../../scripts/docs-live-seed.js'

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
        const root = tmpDir('seed-gitignore-')
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

// Re-runs 4 and 6 both HARD FAILed on `cargo test` with
// `trait Service ... is implemented but not in scope`, and re-run 6's own test file
// explains why: it avoided `tower::ServiceExt::oneshot` because tower was not a
// direct dependency, then hand-rolled poll_ready/call and hit the same missing
// trait. The feature's third obligation had no correct answer.
test('the rs seed declares the crate its tests cannot be written without', () => {
    const manifest = cargoManifest({axum: '0.8.9', tokio: '1.53.1', serde_json: '1.0.151'})
    expect(manifest).toContain('[dev-dependencies]')
    expect(manifest).toMatch(/^tower = .*"util"/m)
})

test('tower is a dev-dependency, not a runtime one', () => {
    const manifest = cargoManifest({axum: '0.8.9', tokio: '1.53.1', serde_json: '1.0.151'})
    const runtime = manifest.slice(
        manifest.indexOf('[dependencies]'),
        manifest.indexOf('[dev-dependencies]')
    )
    expect(runtime).not.toContain('tower')
})
