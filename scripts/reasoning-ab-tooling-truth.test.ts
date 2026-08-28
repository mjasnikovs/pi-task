/**
 * THE COMMAND CHECKER'S OWN CONTRACT.
 *
 * This checker decided the `research:tooling` cell, and its first two versions
 * were both wrong in the same direction — they called REAL commands invented:
 *
 *   1. `bun run <file.ts>` is a file invocation, not a script lookup. Four of
 *      the twelve failures the first screen reported were this bug.
 *   2. `bun run <installed-bin>` falls back to `node_modules/.bin`. VERIFIED BY
 *      EXECUTION in the corpus tree: `bun run tsc --version` printed
 *      `Version 6.0.3`, exit 0; `bun run dev` printed
 *      `error: Script not found "dev"`, exit 1. This one cost two MEDIUM-arm
 *      trials in the live run before it was caught.
 *   3. A runner flag can sit where the target was expected
 *      (`npm run --silent lint`).
 *
 * A strict checker marks correct work wrong; a loose one cannot separate the
 * arms at all. Both are fatal, so both directions are pinned here against a
 * synthetic tree rather than the corpus — these assertions must hold on any
 * machine, with or without ~/hub.
 */
import {describe, expect, test, beforeAll, afterAll} from 'bun:test'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    classifyCommand,
    toolingCommands,
    toolingRunnable,
    type CmdVerdict
} from './reasoning-ab-tooling-truth.js'

let repo: string
let head: string

beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tooling-truth-'))
    const git = (...a: string[]): void => {
        execFileSync('git', a, {cwd: repo, stdio: 'ignore'})
    }
    git('init', '-q')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    fs.writeFileSync(
        path.join(repo, 'package.json'),
        JSON.stringify({scripts: {lint: 'eslint .'}, devDependencies: {typescript: '^5'}})
    )
    fs.writeFileSync(path.join(repo, 'build.ts'), '// build\n')
    fs.writeFileSync(path.join(repo, 'docker-compose.dev.yml'), 'services: {}\n')
    // The installed binary the `bun run` fallback resolves. Not tracked by git
    // on purpose: node_modules never is, and the checker must read the DISK.
    fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), {recursive: true})
    fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'tsc'), '#!/bin/sh\n')
    git('add', '-A')
    git('commit', '-qm', 'x')
    head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8'}).trim()
})

afterAll(() => {
    fs.rmSync(repo, {recursive: true, force: true})
})

describe('classifyCommand says REAL only when the command resolves', () => {
    const cases: Array<[string, CmdVerdict]> = [
        ['bun run lint', 'real'],
        ['npm run lint', 'real'],
        // A runner flag before the target.
        ['npm run --silent lint', 'real'],
        // A file target, not a script name.
        ['bun run build.ts', 'real'],
        ['bun run ./build.ts', 'real'],
        // The node_modules/.bin fallback — the bug that cost two live trials.
        ['bun run tsc --noEmit', 'real'],
        ['bunx tsc --noEmit', 'real'],
        // A file argument that exists.
        ['docker compose -f docker-compose.dev.yml up -d', 'real'],
        // `-f` AS A PLAIN FLAG. Read as a bare token anywhere on the line, the
        // checker called both of these invented paths — `http://…` and `-d` are
        // not files in the tree. Both are ordinary TOOLING entries.
        ['curl -f http://localhost:3000/health', 'unknown'],
        ['git clean -f -d', 'unknown'],
        // ...but a compose token anywhere ahead of `-f` still anchors it. A
        // TOOLING entry is routinely labelled with a single TAB, which is not
        // the two-space gap, so the label rides along on the command.
        ['container\tdocker compose -f docker-compose.dev.yml up', 'real'],
        ['- container: `docker compose -f docker-compose.prod.yml up`', 'invented'],
        // Every `run` on a compound line, not the first. `dev` has no script,
        // and hiding it behind a real `lint` is the one failure class the
        // research:tooling cell was decided on.
        ['bun run lint && bun run dev', 'invented'],
        ['npm run lint || npm run build', 'invented'],
        ['bun run lint; bun run lint', 'real'],
        // And the inventions.
        ['bun run dev', 'invented'],
        ['bun run build', 'invented'],
        ['bun run --watch src/server/index.ts', 'invented'],
        ['docker compose -f docker-compose.prod.yml up', 'invented'],
        // Shapes with no checkable truth. `bun test` resolves through the
        // runtime, not the manifest, and guessing either way would be a scorer
        // nobody can defend.
        ['bun test', 'unknown'],
        ['bun run --', 'unknown'],
        ['make check', 'unknown']
    ]
    for (const [cmd, want] of cases) {
        test(`${cmd} → ${want}`, () => {
            expect(classifyCommand(cmd, head, repo).verdict).toBe(want)
        })
    }
})

describe('toolingCommands reads production’s own entry shape', () => {
    test('a subshell command survives; only the two placeholders are dropped', () => {
        // Dropping every line that opens with `(` also dropped a real command.
        // Production drops `(none —` and `(degraded:` and nothing else.
        expect(
            toolingCommands(
                [
                    '(cd server && bun test)',
                    '(none — the TOOLING worker ran out of turns)',
                    '(degraded: no manifest)'
                ].join('\n')
            )
        ).toEqual(['(cd server && bun test)'])
    })

    test('takes the tail after a two-space gap, and the whole line otherwise', () => {
        expect(
            toolingCommands(['lint  bun run lint', '  bunx tsc --noEmit', '(none — nothing found)'].join('\n'))
        ).toEqual(['bun run lint', 'bunx tsc --noEmit'])
    })
})

describe('toolingRunnable', () => {
    test('true only when something was adjudicated and nothing was invented', () => {
        expect(toolingRunnable('lint  bun run lint', head, repo)).toBe(true)
        expect(toolingRunnable('lint  bun run lint\ndev  bun run dev', head, repo)).toBe(false)
    })

    test('an answer with nothing checkable is FALSE, not vacuously true', () => {
        // Otherwise "emit only unadjudicable lines" is the highest-scoring
        // strategy, which is the hole filesGrounded closes by rejecting an
        // answer that names no path.
        expect(toolingRunnable('test  bun test', head, repo)).toBe(false)
        expect(toolingRunnable('', head, repo)).toBe(false)
    })
})
