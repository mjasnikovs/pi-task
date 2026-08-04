import {describe, expect, test} from 'bun:test'
import {listGuardableTools, toGuardableTools} from './tool-list.js'

/**
 * Shapes copied verbatim from a live `pi.getAllTools()` dump (pi 0.83.0) so the
 * grouping is exercised against what pi actually reports, not a guess at it.
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
})

describe('listGuardableTools', () => {
    test('a throwing getAllTools costs the tool rows, not the settings menu', () => {
        // MEASURED: pi throws "Extension runtime not initialized" from
        // getAllTools() during extension loading, so this path is real.
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
