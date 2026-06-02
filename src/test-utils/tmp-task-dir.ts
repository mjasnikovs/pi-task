/**
 * withTmpTaskDir — run a callback with a fresh tmp project root.
 *
 * Creates a unique directory under os.tmpdir(), invokes fn(cwd), and removes
 * the directory in a try/finally. Tests that touch .pi-tasks/ should use this.
 */

import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export async function withTmpTaskDir<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'pi-task-test-'))
    try {
        return await fn(cwd)
    } finally {
        await fsp.rm(cwd, {recursive: true, force: true})
    }
}
