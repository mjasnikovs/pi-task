import {describe, expect, test} from 'bun:test'
import {
    SELF_BOUNDED_TOOLS,
    listGuardableTools,
    toGuardableTools
} from '../../src/config/tool-list.js'

/**
 * The two `sourceInfo` fields this module reads, with the `source` values pi
 * actually emits — `builtin`, `cli`, `auto`. pi's own `SourceInfo` carries
 * `scope`, `origin` and an optional `baseDir` as well; nothing here looks at them,
 * so the sample stops at what the grouping is a function of.
 */
const LIVE_SAMPLE = [
    {name: 'read', sourceInfo: {source: 'builtin', path: '<builtin:read>'}},
    {name: 'bash', sourceInfo: {source: 'builtin', path: '<builtin:bash>'}},
    {name: 'fake_durable_loop', sourceInfo: {source: 'cli', path: '/tmp/probe-tools.ts'}},
    {name: 'pi-worker-docs', sourceInfo: {source: 'auto', path: '/home/e/pi-task/dist/index.js'}}
]

describe('toGuardableTools', () => {
    test('keeps pi built-ins first, then extension-owned tools', () => {
        expect(toGuardableTools(LIVE_SAMPLE).map(t => t.name)).toEqual([
            'read',
            'bash',
            'fake_durable_loop',
            'pi-worker-docs'
        ])
    })

    test('names the owning extension, so a discovered tool is not just "auto"', () => {
        const byName = new Map(toGuardableTools(LIVE_SAMPLE).map(t => [t.name, t.origin]))
        expect(byName.get('bash')).toBe('built in')
        expect(byName.get('pi-worker-docs')).toBe('discovered (/home/e/pi-task/dist/index.js)')
        expect(byName.get('fake_durable_loop')).toBe('-e flag (/tmp/probe-tools.ts)')
    })

    test('an unrecognised source still names its path rather than dropping the tool', () => {
        expect(
            toGuardableTools([{name: 't', sourceInfo: {source: 'npm:pi-fable', path: '/x/f.js'}}])
        ).toEqual([{name: 't', origin: 'npm:pi-fable (/x/f.js)'}])
    })

    test('a duplicate tool name yields one row — the watchdog only sees the name', () => {
        const dup = [
            {name: 'dup', sourceInfo: {source: 'builtin', path: '<builtin:dup>'}},
            {name: 'dup', sourceInfo: {source: 'auto', path: '/other.js'}}
        ]
        expect(toGuardableTools(dup)).toEqual([{name: 'dup', origin: 'built in'}])
    })

    test('an empty session yields no rows', () => {
        expect(toGuardableTools([])).toEqual([])
    })

    test('a self-bounded tool is never offered a row — its guard is not a choice', () => {
        const withWorker = [
            ...LIVE_SAMPLE,
            {name: 'pi-worker', sourceInfo: {source: 'auto', path: '/home/e/pi-task/dist/index.js'}}
        ]
        expect(SELF_BOUNDED_TOOLS.has('pi-worker')).toBe(true)
        expect(toGuardableTools(withWorker).map(t => t.name)).not.toContain('pi-worker')
    })
})

describe('listGuardableTools', () => {
    test('a throwing getAllTools costs the tool rows, not the settings menu', () => {
        // Not hypothetical: pi's own extension loader throws
        // "Extension runtime not initialized. Action methods cannot be called
        // during extension loading." — and /task-config can be reached from a
        // boot hook while that is still true.
        const pi = {
            getAllTools: () => {
                throw new Error('Extension runtime not initialized')
            }
        }
        expect(listGuardableTools(pi as never)).toEqual([])
    })

    test('passes the live list through', () => {
        const pi = {getAllTools: () => LIVE_SAMPLE}
        expect(listGuardableTools(pi as never).map(t => t.name)).toContain('bash')
    })
})
