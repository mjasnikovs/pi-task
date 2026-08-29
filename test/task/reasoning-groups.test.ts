/**
 * THE GUARD THAT MAKES THE GROUP TABLE TRUE.
 *
 * `reasoningGroupForChild` returns undefined for an unmapped name, and
 * `runPhaseChild` treats undefined as `inherit` — a child that reaches the model
 * with today's argv, which is always safe at run time. That safety is exactly
 * what makes the gap invisible: a phase added next year would silently opt out
 * of whatever `default` measures, and nothing at run time would ever say so.
 *
 * So the completeness check lives HERE, at build time, where someone can fix it.
 * It reads the source rather than a registry because the child name is a string
 * literal at the call site and there is no other place it is written down.
 *
 * It covers the four RESEARCH WORKERS too. Their groups used to live in a second
 * table keyed on the section heading, guarded by a second scanner that sliced
 * `phases.ts` between two string offsets — and whose failure mode was a SILENT
 * fallback to `research` rather than a build failure. One roster, one scanner,
 * one failure mode.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {SRC_ROOT, srcPath} from '../test-utils/src-tree.js'
import {
    REASONING_GROUP_BY_CHILD,
    reasoningGroupForChild,
    REASONING_GROUPS
} from '../../src/config/reasoning.js'

const src = (f: string): string => fs.readFileSync(srcPath('task', f), 'utf8')

/** The text of one call, from `name(` to its matching close paren. */
function callSites(source: string, name: string): string[] {
    const out: string[] = []
    const needle = `${name}(`
    for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) {
        let depth = 0
        let j = i + needle.length - 1
        for (; j < source.length; j++) {
            if (source[j] === '(') depth++
            else if (source[j] === ')' && --depth === 0) break
        }
        out.push(source.slice(i, j + 1))
    }
    return out
}

/**
 * The child names a call site passes. Matches both the positional form
 * (`runPhaseChild(deps, 'refine', …)`) and the object form (`name: 'refine'`),
 * because the three spawn paths do not agree on one.
 */
function childNames(call: string): string[] {
    const out: string[] = []
    const positional = /^\w+\(\s*(?:[\w.]+\s*,\s*)?'([a-z][a-z:-]*)'/.exec(call)
    if (positional?.[1]) out.push(positional[1])
    for (const m of call.matchAll(/\bname:\s*'([a-z][a-z:-]*)'/g)) {
        if (m[1]) out.push(m[1])
    }
    return out
}

/** Every literal child name reaching a runner that resolves a reasoning group. */
function discoveredChildNames(): Set<string> {
    const files = [
        'phases.ts',
        'auto-orchestrator.ts',
        'plan-orchestrator.ts',
        'title-label.ts',
        'child-status.ts'
    ]
    const runners = ['runPhaseChild', 'runPlanningChild', 'runWithEmphasisRetry']
    const found = new Set<string>()
    for (const f of files) {
        const source = src(f)
        for (const runner of runners) {
            for (const call of callSites(source, runner)) {
                for (const n of childNames(call)) found.add(n)
            }
        }
        // /task-auto and /task-plan reach the same runner through a local
        // indirection (`deps.runChild(name, …)` / `child(name, …)`), so the
        // literal never appears inside a `runPhaseChild(` call.
        for (const m of source.matchAll(/\b(?:deps\.runChild|child)\(\s*'([a-z][a-z:-]*)'/g)) {
            if (m[1]) found.add(m[1])
        }
        // runGroundedExtraction rows name their child on a `child:` key.
        for (const m of source.matchAll(/\bchild:\s*'([a-z][a-z-]*)'/g)) {
            if (m[1]) found.add(m[1])
        }
        // Research workers name their child on a `label:` key in `workerSpecs`;
        // `runWorker` resolves the group from it exactly as `runPhaseChild` does
        // from a positional name.
        for (const m of source.matchAll(/\blabel:\s*'(worker:[a-z-]+)'/g)) {
            if (m[1]) found.add(m[1])
        }
    }
    return found
}

describe('every named child has a reasoning group', () => {
    test('the table covers every child name found in src/task', () => {
        const discovered = [...discoveredChildNames()].sort()
        // Sanity: if the scanner finds nothing the assertion below is vacuous,
        // which is the one way this test could pass while being broken.
        expect(discovered.length).toBeGreaterThan(10)
        const unmapped = discovered.filter(n => reasoningGroupForChild(n) === undefined)
        expect(unmapped).toEqual([])
    })

    test('the table names no child the source does not spawn', () => {
        // A stale row is not dangerous, but it is a lie about what runs — and it
        // is the shape a rename leaves behind, where the real child then falls
        // through to `inherit` while the table still claims to cover it.
        const discovered = discoveredChildNames()
        const stale = Object.keys(REASONING_GROUP_BY_CHILD).filter(n => !discovered.has(n))
        expect(stale).toEqual([])
    })

    test('every mapped group is a real group', () => {
        for (const [name, group] of Object.entries(REASONING_GROUP_BY_CHILD)) {
            expect(REASONING_GROUPS, `${name} -> ${group}`).toContain(group)
        }
    })

    test('an unknown name inherits rather than throwing', () => {
        // The run-time contract: a missing row costs today's behaviour, never a
        // user's task.
        expect(reasoningGroupForChild('a-phase-invented-next-year')).toBeUndefined()
    })
})

describe('the /no_think soft switch is gone and stays gone', () => {
    /**
     * It was applied to eight prompts and read by none of them: measured live
     * against Qwen3.8-27B, thinking on and `/no_think` still in the prompt gave a
     * median 17k-char trace anyway (n=25). The chat-template kwarg that
     * `--thinking` sets beats it, so the suffix is a dead knob that LOOKS live —
     * the exact thing that stopped anyone wiring the real one for a year.
     *
     * Re-adding it would not fail any behaviour test, because it does nothing.
     * That is why this is asserted against the source.
     */
    test('no source file under src/ carries the suffix or its helpers', () => {
        const root = SRC_ROOT
        const offenders: string[] = []
        const walk = (dir: string): void => {
            for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
                const full = path.join(dir, e.name)
                if (e.isDirectory()) {
                    walk(full)
                    continue
                }
                if (!e.name.endsWith('.ts')) continue
                const text = fs.readFileSync(full, 'utf8')
                // Strip comments: the deletion is explained in several headers,
                // and a doc comment naming the thing it removed is the record,
                // not a regression.
                const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
                if (/appendNoThink|NO_THINK|\/no_think/.test(code)) {
                    offenders.push(path.relative(root, full))
                }
            }
        }
        walk(root)
        expect(offenders).toEqual([])
    })
})
