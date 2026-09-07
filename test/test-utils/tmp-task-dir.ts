/**
 * withTmpTaskDir — run a callback with a fresh tmp project root.
 *
 * Creates a unique directory under os.tmpdir(), invokes fn(cwd), and removes
 * the directory in a try/finally. Tests that touch .pi-tasks/ should use this.
 */

import * as fsp from 'node:fs/promises'
import {tmpDir} from './tmp-dir.js'

export async function withTmpTaskDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    // The try/finally below is correct and was not enough: `pi-task-test-` still left
    // 2,237 directories in /tmp. `tmpDir` registers the root with the file's own
    // afterAll, so a throw that escapes this frame — an abort, a failed assertion in
    // a detached callback — is still swept.
    const cwd = tmpDir('pi-task-test-')
    try {
        return await fn(cwd)
    } finally {
        await fsp.rm(cwd, {recursive: true, force: true})
    }
}
