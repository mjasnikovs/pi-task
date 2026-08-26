/**
 * The gate screen, tested with real trees and real scripts but no corpus and no
 * GPU.
 *
 * `screenTask` is the only thing standing between "the tree makes this verdict
 * correct" and "we assumed it did". Every case here is a way the assumption
 * fails, and two of them are MEASURED on the mx5 corpus: a VERIFY that passes on
 * the before-tree (three of the first twelve tasks) and a VERIFY that fails on
 * the shipped tree (thirty-one of fifty-one).
 *
 * It builds git repos in a temp dir rather than mocking `extractTree`, because
 * the thing worth testing is that a script's outcome really does differ between
 * two commits — which a mock would assert rather than demonstrate.
 */
import {describe, expect, test, beforeAll, afterAll} from 'bun:test'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-truth-test-'))
const repo = path.join(root, 'corpus')
const trees = path.join(root, 'trees')

/** Commit hashes of the two trees every case picks from. */
let preCommit = ''
let postCommit = ''

const git = (...args: string[]): string =>
    execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim()

beforeAll(async () => {
    fs.mkdirSync(repo, {recursive: true})
    fs.mkdirSync(trees, {recursive: true})
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'ab@example.invalid')
    git('config', 'user.name', 'ab')
    // The recorded task doc, in the two commit subjects commitPairs() parses.
    // Written before the checkpoint so BOTH trees carry it — a verify child is
    // handed the spec, and a tree missing .pi-tasks is not the corpus shape.
    fs.mkdirSync(path.join(repo, '.pi-tasks'), {recursive: true})
    fs.writeFileSync(
        path.join(repo, '.pi-tasks', 'TASK_0001.md'),
        '## spec\n\nGOAL\nadd the feature\n\n'
            + 'VERIFY\n```sh\ntest -f feature.txt\n```\n'
    )
    // BEFORE: the feature file is absent.
    fs.writeFileSync(path.join(repo, 'README'), 'nothing yet\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'chore: checkpoint before "add feature"')
    preCommit = git('rev-parse', 'HEAD')
    // AFTER: the feature file exists.
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'shipped\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'task: add feature (TASK_0001)')
    postCommit = git('rev-parse', 'HEAD')

    // impl-ab-corpus reads its corpus root from AB_CORPUS at MODULE LOAD, so it
    // has to be set before the import, not before the call.
    process.env.AB_CORPUS = repo
})

afterAll(() => fs.rmSync(root, {recursive: true, force: true}))

/** Imported lazily so AB_CORPUS is already pointing at the fixture repo. */
const loadScreen = async () => (await import('./reasoning-ab-gate-truth.js')).screenTask

const task = (verify: string) => ({
    id: 'TASK_0001',
    title: 'add feature',
    preCommit,
    postCommit,
    spec: 'GOAL\nadd the feature\n',
    verify
})

describe('screenTask', () => {
    test('a VERIFY that requires the work is USABLE', async () => {
        const screenTask = await loadScreen()
        const o = screenTask(task('test -f feature.txt'), trees, 30_000)
        expect(o.usable).toBe(true)
        expect(o.detail).toContain('after pass')
    })

    test('a VERIFY that passes on the BEFORE tree is rejected', async () => {
        // MEASURED on mx5: three of the first twelve tasks scored PASS before the
        // model wrote anything. A trial built on one of those scores the child
        // against a script that never required the work.
        const screenTask = await loadScreen()
        const o = screenTask(task('test -f README'), trees, 30_000)
        expect(o.usable).toBe(false)
        expect(o.detail).toContain('BEFORE')
    })

    test('a VERIFY that fails on the SHIPPED tree is rejected as a broken scorer', async () => {
        // The turn is not what failed here — thirty-one of fifty-one mx5 tasks
        // land in this bucket. Scoring against it would mark a correct PASS wrong.
        const screenTask = await loadScreen()
        const o = screenTask(task('test -f never-existed'), trees, 30_000)
        expect(o.usable).toBe(false)
        expect(o.detail).toContain('SHIPPED')
    })

    test('a VERIFY that crashes is a FAIL, not a throw', async () => {
        // runVerify never throws; a crash on the shipped tree is still a broken
        // scorer, and the screen must say so rather than end the run.
        const screenTask = await loadScreen()
        const o = screenTask(task('exit 127'), trees, 30_000)
        expect(o.usable).toBe(false)
        expect(o.detail).toContain('SHIPPED')
    })

    test('the trees it extracted are cleaned up, pass or fail', async () => {
        // One corpus checkout per trial fills a disk. A screen that leaks them
        // fills it 51 times faster.
        const screenTask = await loadScreen()
        screenTask(task('test -f feature.txt'), trees, 30_000)
        screenTask(task('test -f never-existed'), trees, 30_000)
        expect(fs.readdirSync(trees)).toEqual([])
    })
})

describe('gateStimuli', () => {
    test('a screened task becomes exactly two stimuli, one per tree', async () => {
        const {gateStimuli} = await import('./reasoning-ab-gate-truth.js')
        const {stimuli, screened} = gateStimuli({
            treeRoot: trees,
            verifyTimeoutMs: 30_000,
            log: () => {}
        })
        expect(screened.map(o => o.id)).toEqual(['TASK_0001'])
        expect(stimuli.map(x => `${x.id}/${x.condition}=${x.truth}`)).toEqual([
            'TASK_0001/before=FAIL',
            'TASK_0001/after=PASS'
        ])
        // The commit each condition extracts must be the matching tree, or the
        // truth is attached to the wrong bytes and every row is scored backwards.
        expect(stimuli[0]!.commit).toBe(preCommit)
        expect(stimuli[1]!.commit).toBe(postCommit)
    })

    test('the base rate is 50/50 by construction', async () => {
        const {gateStimuli} = await import('./reasoning-ab-gate-truth.js')
        const {stimuli} = gateStimuli({treeRoot: trees, verifyTimeoutMs: 30_000, log: () => {}})
        const pass = stimuli.filter(s => s.truth === 'PASS').length
        const fail = stimuli.filter(s => s.truth === 'FAIL').length
        // Equal counts are what make always-PASS and always-FAIL both score 50%.
        expect(pass).toBe(fail)
        expect(pass).toBeGreaterThan(0)
    })
})
