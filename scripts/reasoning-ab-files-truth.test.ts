/**
 * The research quality axis, tested without a corpus and without a GPU.
 *
 * The scorer it replaces was correct and saturated — production's own
 * `hasAnswerContent`, which asks whether the answer LOOKS like a FILES list. A
 * competent model always produces one, so it could not separate two arms. Every
 * case here is a way the replacement could go wrong instead: too strict, and it
 * marks a correct "file to create" entry as invented; too loose, and it lets an
 * invented path through and lands back on a ceiling.
 */
import {describe, expect, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    editedExistingPaths,
    filesAnswered,
    filesGrounded,
    filesPaths,
    groundedPaths,
    ignoredButPresent,
    namedRecall
} from './reasoning-ab-files-truth.js'

/** A tree with two real files and the directories above them. */
const tree = new Set(['src/server/images.ts', 'package.json', 'src', 'src/server'])

describe('filesPaths', () => {
    test('reads the format the FILES prompt specifies', () => {
        // "<path>[:<line>]  <one-line purpose>", two spaces before the purpose.
        expect(
            filesPaths('src/server/images.ts:42  the resize helper\npackage.json  manifest\n')
        ).toEqual(['src/server/images.ts', 'package.json'])
    })

    test('a bare ALL-CAPS heading is not an entry', () => {
        // FILES output carries no header by contract, but a RECORDED section
        // keeps its own, and counting "FILES" as a path would fail every task.
        expect(filesPaths('FILES\npackage.json  manifest\n')).toEqual(['package.json'])
    })

    // THE SECTION SLICE. Measured on the 12-rep research ledger: one `off`
    // trial emitted its own `APIS` heading despite the prompt's "No other
    // sections", and three of the symbols under it — `cn` and two `--*` token
    // lists — were read as invented paths, failing the trial on its own
    // correct FILES block. The harness sliced the RECORDED section this way
    // and the trial did not, which is the same-input rule broken a third time.
    test('entries under a NON-FILES heading are not paths', () => {
        expect(
            filesPaths(
                'src/client/index.css  brand tokens\n'
                    + 'APIS\n'
                    + 'cn  the class-name merge helper\n'
                    + '--font-display / --font-body  Tailwind v4 font tokens\n'
            )
        ).toEqual(['src/client/index.css'])
    })

    test('a FILES heading after another section turns entries back on', () => {
        expect(
            filesPaths('APIS\ncn  helper\nFILES\npackage.json  manifest\n')
        ).toEqual(['package.json'])
    })

    test('a non-numeric colon suffix is left alone, not trimmed into a real path', () => {
        // MEASURED: TASK_0001 emitted `package.json:/workspace`. Trimming that
        // would turn a malformed entry into a passing one and hide the very
        // task the screen exists to drop.
        expect(filesPaths('package.json:/workspace  root manifest')).toEqual([
            'package.json:/workspace'
        ])
    })

    test('blank lines produce no entries', () => {
        expect(filesPaths('\n\n   \n')).toEqual([])
    })

    test('a leaked tool-call tag is not a path', () => {
        // MEASURED, run 2026-08-26 TASK_0002: the answer's 11 paths were ALL
        // real and it scored 11/14, because `</parameter>`, `</function>` and
        // `</tool_call>` trailed the list. Five of the ten `off` trials failed
        // this way and the arm read 2/10 — an instrument reading, not a result.
        expect(
            filesPaths('package.json  manifest\n\n</parameter>\n</function>\n</tool_call>')
        ).toEqual(['package.json'])
    })

    test('a preamble sentence is not a path', () => {
        // Prose carries no two-space gap, and when it carries a spaced dash it
        // ends in `.` or `:`. Both real, from the same run.
        expect(
            filesPaths(
                'Now I have complete context. Here is the FILES section:\n'
                    + 'package.json  manifest\n'
                    + 'The DESIGN spec is silent on the JS/JSX entry — it stays a known-unknown.'
            )
        ).toEqual(['package.json'])
    })

    test('an em-dash entry is still an entry', () => {
        // The prompt asks for two spaces, but models write `path — purpose` and
        // dropping those would lose real paths to the prose filter.
        expect(filesPaths('src/server/images.ts — the resize helper')).toEqual([
            'src/server/images.ts'
        ])
    })

    test('a bulleted entry keeps its path, not its bullet', () => {
        expect(filesPaths('- package.json  manifest')).toEqual(['package.json'])
    })
})

describe('filesGrounded', () => {
    test('an answer whose paths all exist scores', () => {
        expect(filesGrounded('src/server/images.ts  the module\npackage.json  manifest', tree))
            .toBe(true)
    })

    test('ONE invented path fails the whole answer', () => {
        // Strict on purpose. A fractional bar would let a run hide one invention
        // per answer, and one invention is what sends an implementation child to
        // a file that is not there.
        expect(
            filesGrounded('src/server/images.ts  real\nsrc/server/ghost.ts  invented', tree)
        ).toBe(false)
    })

    test('a directory entry scores — the prompt asks for them', () => {
        // "list the root directory entry (`src/  one-line purpose`) instead of
        // enumerating every file under it". git lists no directories, so a
        // scorer that only knows blobs would mark compliant output wrong.
        expect(filesGrounded('src/  the whole tree', tree)).toBe(true)
        expect(filesGrounded('src/server  the server half', tree)).toBe(true)
    })

    test('an answer naming NO path does not score', () => {
        // Otherwise the empty answer is vacuously perfect and outranks real work.
        expect(filesGrounded('', tree)).toBe(false)
        expect(filesGrounded('I could not find anything relevant.', tree)).toBe(false)
    })

    test('a file the task CREATES scores, because the tree is the after-tree', () => {
        // This is why the check runs against the after-tree and not the tree the
        // child works in. Checking the before-tree would mark every correct
        // "New file — to create" entry as a hallucination.
        const after = new Set([...tree, 'src/client/components/PhotoUploader.tsx'])
        expect(
            filesGrounded('src/client/components/PhotoUploader.tsx  new component to create', after)
        ).toBe(true)
    })
})

describe('groundedPaths', () => {
    test('reports what is missing, so a log line can name the invention', () => {
        const g = groundedPaths('package.json  ok\nnope.ts  invented\nalso-nope.ts  invented', tree)
        expect(g.total).toBe(3)
        expect(g.present).toBe(1)
        expect(g.missing).toEqual(['nope.ts', 'also-nope.ts'])
    })

    test('a trailing slash does not decide whether a directory is real', () => {
        expect(groundedPaths('src/  tree', tree).missing).toEqual([])
        expect(groundedPaths('src  tree', tree).missing).toEqual([])
    })
})

describe('ignoredButPresent', () => {
    /**
     * A real git repo, because the rule IS git's own ignore resolution and a
     * stub of it would be a second, different rule.
     */
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'files-truth-'))
    execFileSync('git', ['init', '-q'], {cwd: repo})
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nbuilt.txt\n')
    fs.mkdirSync(path.join(repo, 'node_modules', 'zod'), {recursive: true})
    fs.writeFileSync(path.join(repo, 'node_modules', 'zod', 'package.json'), '{}')
    fs.writeFileSync(path.join(repo, 'stray.txt'), 'x')

    test('an ignored file that is really there counts', () => {
        // MEASURED: six research trials named a node_modules file they had just
        // READ — impl-ab-corpus symlinks node_modules into the child's tree —
        // and `git ls-tree` lists only TRACKED files, so all six scored as
        // inventions.
        expect(ignoredButPresent('node_modules/zod/package.json', repo)).toBe(true)
    })

    test('a file that is present but NOT ignored does not count', () => {
        // The narrow half of the rule. Accepting anything on disk would let an
        // untracked stray pass, which is the loose scorer this axis was rebuilt
        // to avoid.
        expect(ignoredButPresent('stray.txt', repo)).toBe(false)
    })

    test('an ignored path that does not exist does not count', () => {
        expect(ignoredButPresent('built.txt', repo)).toBe(false)
    })

    test('an absolute path is never resolved against the corpus', () => {
        expect(ignoredButPresent('/etc/hostname', repo)).toBe(false)
    })
})

describe('namedRecall', () => {
    test('reports which edited files the answer never named', () => {
        const r = namedRecall('package.json  manifest\n', [
            'package.json',
            'src/server/images.ts'
        ])
        expect(r.total).toBe(2)
        expect(r.found).toBe(1)
        expect(r.missing).toEqual(['src/server/images.ts'])
    })

    test('a named DIRECTORY does not cover the files under it', () => {
        // The loose-scorer hole this axis exists to avoid: one `src/` entry
        // would otherwise claim perfect recall over the whole repository.
        // MEASURED over all 38 corpus tasks with truth, ZERO recorded answers
        // need directory coverage to score, so refusing it costs nothing real.
        expect(namedRecall('src/  the tree', ['src/server/images.ts']).found).toBe(0)
    })

    test('a trailing slash on the named path still matches the file', () => {
        expect(namedRecall('package.json/  manifest', ['package.json']).found).toBe(1)
    })
})

describe('filesAnswered', () => {
    const truth = ['package.json']

    test('both halves right', () => {
        expect(filesAnswered('package.json  manifest\nsrc  tree', tree, truth)).toBe(true)
    })

    test('perfect recall does not excuse an invented path', () => {
        // Precision is still half the axis: an implementation child sent to a
        // path that is not there is the failure that matters downstream.
        expect(filesAnswered('package.json  manifest\nnope.ts  invented', tree, truth)).toBe(
            false
        )
    })

    test('perfect precision does not excuse a missed edited file', () => {
        // The half that was missing. `off` named 119 real paths to `medium`'s
        // 70 and the precision-only axis called that a tie.
        expect(filesAnswered('src  tree', tree, truth)).toBe(false)
    })

    test('no truth at all scores FALSE, never vacuously true', () => {
        // Seven of the ten tasks in the first research ledger edit no
        // pre-existing file. A vacuous pass there would have made the
        // greenfield tasks the highest-scoring stimuli in the corpus.
        expect(filesAnswered('package.json  manifest', tree, [])).toBe(false)
    })
})

describe('editedExistingPaths', () => {
    /**
     * A real git repo, because the truth IS git's own diff and a stub of it
     * would be a second, different rule. Four statuses in one commit pair:
     * modified, added, deleted, and a generated artefact.
     */
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'edited-truth-'))
    const git = (...args: string[]): string =>
        execFileSync('git', args, {cwd: repo, encoding: 'utf8'})
    git('init', '-q')
    git('config', 'user.email', 'a@b.c')
    git('config', 'user.name', 't')
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'a')
    fs.writeFileSync(path.join(repo, 'gone.ts'), 'a')
    fs.writeFileSync(path.join(repo, 'bun.lock'), 'a')
    fs.mkdirSync(path.join(repo, '.pi-tasks'))
    fs.writeFileSync(path.join(repo, '.pi-tasks', 'TASK_0001.md'), 'a')
    git('add', '-A')
    git('commit', '-qm', 'before')
    const pre = git('rev-parse', 'HEAD').trim()
    fs.writeFileSync(path.join(repo, 'keep.ts'), 'b')
    fs.writeFileSync(path.join(repo, 'bun.lock'), 'b')
    fs.writeFileSync(path.join(repo, '.pi-tasks', 'TASK_0001.md'), 'b')
    fs.rmSync(path.join(repo, 'gone.ts'))
    fs.writeFileSync(path.join(repo, 'new.ts'), 'a')
    git('add', '-A')
    git('commit', '-qm', 'after')
    const post = git('rev-parse', 'HEAD').trim()

    test('a modified file is truth and an added one is not', () => {
        // MEASURED over the whole corpus: counting created files drops the
        // recorded answers to 49.0% recall, 26/55 tasks perfect — the CHECK
        // loses. Naming a file that does not exist yet is a prediction of a
        // filename nothing fixes, not the located-it-on-disk job.
        const t = editedExistingPaths(pre, post, repo)
        expect(t).toContain('keep.ts')
        expect(t).not.toContain('new.ts')
    })

    test('a deleted file is truth — it existed and the task had to find it', () => {
        expect(editedExistingPaths(pre, post, repo)).toContain('gone.ts')
    })

    test('lock files and the run\'s own state are not truth', () => {
        const t = editedExistingPaths(pre, post, repo)
        expect(t).not.toContain('bun.lock')
        expect(t).not.toContain('.pi-tasks/TASK_0001.md')
    })

    test('a rename contributes its OLD path, which is the one that existed', () => {
        const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'edited-rename-'))
        const g2 = (...a: string[]): string =>
            execFileSync('git', a, {cwd: r2, encoding: 'utf8'})
        g2('init', '-q')
        g2('config', 'user.email', 'a@b.c')
        g2('config', 'user.name', 't')
        fs.writeFileSync(path.join(r2, 'old.ts'), 'x'.repeat(200))
        g2('add', '-A')
        g2('commit', '-qm', 'before')
        const p1 = g2('rev-parse', 'HEAD').trim()
        fs.renameSync(path.join(r2, 'old.ts'), path.join(r2, 'newname.ts'))
        g2('add', '-A')
        g2('commit', '-qm', 'after')
        const p2 = g2('rev-parse', 'HEAD').trim()
        // -z makes rename records three fields instead of two; a fixed stride
        // would desynchronise every path after the first rename.
        const t = editedExistingPaths(p1, p2, r2)
        expect(t).toEqual(['old.ts'])
    })
})
