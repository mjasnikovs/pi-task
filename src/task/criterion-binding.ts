/**
 * Each ACCEPTANCE bullet names, at spec time, what will observe it:
 *   `[test: <path> "<title>"]`  behaviour, observed by that test
 *   `[cmd: <command>]`          an exit status
 *   `[static]`                  structure that exists without running anything
 *
 * Bound before any code exists, so neither the implementer nor the verifier can
 * pick an observation after the fact. mx5-n 0.42.47 TASK_0039 shipped "guarded
 * routes … never a premature redirect" with no test; the verifier passed it, and
 * the sign-in bounce reached the final gate 13 tasks later.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {parseSpec} from './spec-model.js'

export type CriterionBinding =
    {kind: 'test'; path: string; title: string} | {kind: 'cmd'; command: string} | {kind: 'static'}

const TEST_TAG_RE = /\[test:\s*(\S+)\s+"([^"]+)"\s*\]/
const CMD_TAG_RE = /\[cmd:\s*([^\]]+?)\s*\]/
const STATIC_TAG_RE = /\[static\]/

/** The binding a bullet declares, or null when it declares none. */
export function bindingOf(bullet: string): CriterionBinding | null {
    const t = TEST_TAG_RE.exec(bullet)
    if (t) return {kind: 'test', path: t[1], title: t[2]}
    const c = CMD_TAG_RE.exec(bullet)
    if (c) return {kind: 'cmd', command: c[1]}
    return STATIC_TAG_RE.test(bullet) ? {kind: 'static'} : null
}

/** The ACCEPTANCE bullets that declare no binding. */
export function unboundAcceptance(spec: string): string[] {
    return parseSpec(spec).acceptance.filter(b => bindingOf(b) === null)
}

/** The forced critique defect for bullets that declare no binding. */
export function unboundAcceptanceDefectText(bullets: readonly string[]): string {
    return [
        'ACCEPTANCE: these criteria name nothing that will observe them. End each with exactly one tag:',
        '`[test: <path> "<title>"]` for behaviour (the test this task writes, which fails when the behaviour breaks),',
        '`[cmd: <command>]` for an exit status, `[static]` for structure only.',
        ...bullets.map(b => `  - ${b.split('\n')[0]}`)
    ].join('\n')
}

export interface MissingTest {
    bullet: string
    path: string
    title: string
    why: 'no file' | 'no title'
}

/**
 * The declared tests the tree does not hold. The title is matched as a literal,
 * which every test runner's source carries. Whether the test PASSES is the
 * project suite's job, already run by the health gate; this asks only whether
 * the observation the spec promised was written.
 */
export function missingDeclaredTests(spec: string, cwd: string): MissingTest[] {
    const root = path.resolve(cwd)
    const out: MissingTest[] = []
    for (const bullet of parseSpec(spec).acceptance) {
        const b = bindingOf(bullet)
        if (b?.kind !== 'test') continue
        const file = path.resolve(root, b.path)
        let source: string | null = null
        if (file.startsWith(`${root}${path.sep}`)) {
            try {
                source = fs.readFileSync(file, 'utf8')
            } catch {
                source = null
            }
        }
        if (source === null) out.push({bullet, path: b.path, title: b.title, why: 'no file'})
        else if (!source.includes(b.title))
            out.push({bullet, path: b.path, title: b.title, why: 'no title'})
    }
    return out
}
