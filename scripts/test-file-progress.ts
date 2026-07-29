/**
 * Per-file progress for `bun test`, as a preload plugin.
 *
 * WHY: the CI Test step hangs at random (see the workflow's Test step comment).
 * The 10-min step timeout preserves the log, but the log could not say WHICH
 * file was running: `bun test` prints a file header only for files that write
 * output of their own, so the last header in a hung log names the last file
 * that happened to console.log — not the file that hung. Run 30472844957's log
 * ended on `orientation-replay.test.ts` purely because that file prints a line.
 *
 * An onLoad plugin fires as each test file is loaded, and loading is lazy —
 * verified interleaved with test output, not batched up front — so the LAST
 * `::test-file` line in a hung log is the file that hung.
 *
 * OFF unless PI_TEST_PROGRESS is set (CI sets it): 154 extra lines would drown
 * a local run, and the plugin then costs nothing at all.
 */
import {plugin} from 'bun'
import path from 'node:path'

if (process.env.PI_TEST_PROGRESS) {
    const root = process.cwd()
    plugin({
        name: 'test-file-progress',
        setup(build) {
            build.onLoad({filter: /\.test\.tsx?$/}, async args => {
                // Relative keeps the line short and identical across runners.
                process.stdout.write(`::test-file ${path.relative(root, args.path)}\n`)
                // Hand the source back unchanged; bun transpiles it as usual.
                return {contents: await Bun.file(args.path).text(), loader: 'ts'}
            })
        }
    })
}
