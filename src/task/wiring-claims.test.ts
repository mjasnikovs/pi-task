import {describe, expect, test} from 'bun:test'
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
    findSynthesizedWiring,
    wiringProbeText,
    wiringDefectText,
    readReferencedDocs
} from './wiring-claims.js'

// The run-8 F3 fixture: the design pins ENDPOINTS (photos span two roots); the spec
// invented a uniform mount table. The registry holds the verbatim pinned facts.
const REGISTRY = [
    '"POST /api/listings/:id/photos" [anchor: Photos]',
    '"GET /api/photos/:id" [anchor: Photos]',
    '"DELETE /api/photos/:id" [anchor: Photos]',
    '"POST /api/auth/login" [anchor: Auth]',
    '"GET /api/listings" [anchor: Listings]',
    '"POST /api/invites" [anchor: Invites]',
    '"GET /api/admin/users" [anchor: Admin]'
].join('\n')

const MOUNT_TABLE = [
    'CONSTRAINTS',
    "- Mount each module with `app.route('/api/<prefix>', <module>)`:",
    '  - `/api/auth` → `authRoutes` from `./routes/auth`',
    '  - `/api/invites` → `invitesRoutes` from `./routes/invites`',
    '  - `/api/listings` → `listingsRoutes` from `./routes/listings`',
    '  - `/api/photos` → `photosRoutes` from `./routes/photos`',
    '  - `/api/admin` → `adminRoutes` from `./routes/admin`'
].join('\n')

describe('findSynthesizedWiring', () => {
    test('empty registry ⇒ no-op (single /task, no shared boundary)', () => {
        expect(findSynthesizedWiring(MOUNT_TABLE, '', '')).toEqual([])
    })

    test('flags every mount mapping in the run-8 assembly table (probe surfaces all 5)', () => {
        const w = findSynthesizedWiring(MOUNT_TABLE, REGISTRY, REGISTRY)
        expect(w.length).toBe(5)
        // includes the actual seam bug
        expect(w.some(c => /\/api\/photos/.test(c.from) && /photosRoutes/.test(c.to))).toBe(true)
    })

    test('does NOT flag internal-flow prose whose operands are not pinned boundaries', () => {
        const spec = ['GOAL', 'Data path: user input → validation → storage → response.'].join('\n')
        expect(findSynthesizedWiring(spec, REGISTRY, REGISTRY)).toEqual([])
    })

    test('treats a mapping quoted verbatim from the design as CITED, not synthesized', () => {
        // The design itself pins this exact wiring line — the spec cites it verbatim.
        const design = 'Wiring: `/api/photos` → `photosRoutes` from `./routes/photos` (pinned).'
        const spec = ['GOAL', '- `/api/photos` → `photosRoutes` from `./routes/photos`'].join('\n')
        // grounding contains the verbatim mapping ⇒ skipped even though it touches a boundary
        expect(findSynthesizedWiring(spec, design + '\n' + REGISTRY, REGISTRY)).toEqual([])
    })

    test('deduplicates a mapping repeated (refined + spec copies)', () => {
        const doubled = [MOUNT_TABLE, '', 'ACCEPTANCE', MOUNT_TABLE].join('\n')
        expect(findSynthesizedWiring(doubled, REGISTRY, REGISTRY).length).toBe(5)
    })

    test('a colon is not an arrow — endpoint params and headers do not match', () => {
        const spec = [
            'GOAL',
            '- `GET /api/photos/:id` streams the image',
            'ACCEPTANCE: the file exists'
        ].join('\n')
        expect(findSynthesizedWiring(spec, REGISTRY, REGISTRY)).toEqual([])
    })

    test('supports -> and => arrow notations', () => {
        const spec = ['- /api/photos -> photosRoutes', '- /api/auth => authRoutes'].join('\n')
        expect(findSynthesizedWiring(spec, REGISTRY, REGISTRY).length).toBe(2)
    })
})

describe('wiringProbeText / wiringDefectText', () => {
    test('empty findings ⇒ empty string', () => {
        expect(wiringProbeText([], REGISTRY)).toBe('')
        expect(wiringDefectText([], REGISTRY)).toBe('')
    })

    test('names the mappings, juxtaposes the pinned facts, and instructs reconciliation', () => {
        const w = findSynthesizedWiring(MOUNT_TABLE, REGISTRY, REGISTRY)
        const probe = wiringProbeText(w, REGISTRY)
        expect(probe).toContain('SYNTHESIZED WIRING')
        expect(probe).toContain('/api/photos')
        expect(probe).toContain('POST /api/listings/:id/photos') // a pinned fact is shown
        expect(probe).toContain('SEAM BUG')
        expect(probe).toContain('KEEP every mapping') // reconcile, do not blanket-delete
    })
})

describe('readReferencedDocs', () => {
    test('reads @-mentioned files and skips unreadable ones', () => {
        const dir = mkdtempSync(join(tmpdir(), 'wiring-'))
        try {
            writeFileSync(join(dir, 'DESIGN.md'), 'pinned: /api/photos/:id')
            const out = readReferencedDocs(dir, 'see @DESIGN.md, and @missing/absent.md.')
            expect(out).toContain('/api/photos/:id')
            expect(out).not.toContain('absent')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    test('no mentions ⇒ empty string', () => {
        expect(readReferencedDocs('/tmp', 'no at-mentions here')).toBe('')
    })
})
