/**
 * Per-file progress for `bun test`, as a preload plugin.
 *
 * WHY: the CI Test step can hang (see the workflow's Test step comment). Its
 * step timeout preserves the log, but the log could not say WHICH file was
 * running: `bun test` prints a file header only for files that write output of
 * their own, so the last header in a hung log names the last file that happened
 * to console.log — not the file that hung.
 *
 * An onLoad plugin fires as each test file is loaded, and under `--isolate` a
 * file is loaded, run, and finished before the next one loads — so the LAST
 * `::test-file` line in a hung log is the file that hung.
 *
 * OFF unless PI_TEST_PROGRESS is set (CI sets it): one extra line per test file
 * would drown a local run, and the plugin then costs nothing at all.
 */
import {plugin} from 'bun'
import path from 'node:path'

if (process.env.PI_TEST_PROGRESS) {
    const root = process.cwd()
    plugin({
        name: 'test-file-progress',
        setup(build) {
            build.onLoad({filter: /\.test\.tsx?$/}, async args => {
                // Relative keeps the line short and free of the checkout path.
                process.stdout.write(`::test-file ${path.relative(root, args.path)}\n`)
                return {contents: await Bun.file(args.path).text(), loader: 'ts'}
            })
        }
    })
}
