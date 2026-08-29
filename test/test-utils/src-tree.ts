import * as path from 'node:path'

/**
 * Tests live under `test/`, mirroring `src/`. A test that READS or WALKS the
 * source tree must resolve it explicitly: `import.meta.dir` now points inside
 * `test/`, where a source scan finds nothing and the assertion passes
 * vacuously. That is a silent failure, so the source root is named here once.
 */
export const SRC_ROOT = path.resolve(import.meta.dir, '..', '..', 'src')

/** A path inside `src/`, e.g. `srcPath('task', 'gate-deps.ts')`. */
export function srcPath(...parts: string[]): string {
    return path.join(SRC_ROOT, ...parts)
}
