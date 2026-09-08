import {describe, expect, test} from 'bun:test'
import {deflateRawSync, crc32} from 'node:zlib'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {
    readZip,
    readEntry,
    extractZip,
    readRemoteZip,
    readRemoteEntries,
    isUnsafeEntryName,
    findCentralDirectory,
    parseCentralDirectory,
    inflateEntry,
    type RangeFetch
} from '../../src/shared/zip.js'

interface Member {
    name: string
    body: string
    /** Store the entry uncompressed, the way a zip writer does for tiny files. */
    stored?: boolean
}

/**
 * A zip built the way Go's own writer builds one: deflate, the data-descriptor
 * flag set, and zeroed sizes and CRC in every LOCAL header. A reader that trusts
 * a local header reads nothing at all out of this, which is the point.
 */
function buildZip(members: readonly Member[], comment = ''): Buffer {
    const locals: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const m of members) {
        const raw = Buffer.from(m.body, 'utf8')
        const data = m.stored ? raw : deflateRawSync(raw)
        const name = Buffer.from(m.name, 'utf8')
        const method = m.stored ? 0 : 8

        const local = Buffer.alloc(30 + name.length)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(0x08, 6)
        local.writeUInt16LE(method, 8)
        local.writeUInt16LE(name.length, 26)
        local.writeUInt16LE(0, 28)
        name.copy(local, 30)

        const descriptor = Buffer.alloc(16)
        descriptor.writeUInt32LE(0x08074b50, 0)
        descriptor.writeUInt32LE(crc32(raw), 4)
        descriptor.writeUInt32LE(data.length, 8)
        descriptor.writeUInt32LE(raw.length, 12)

        locals.push(local, data, descriptor)

        const cdfh = Buffer.alloc(46 + name.length)
        cdfh.writeUInt32LE(0x02014b50, 0)
        cdfh.writeUInt16LE(0x08, 8)
        cdfh.writeUInt16LE(method, 10)
        cdfh.writeUInt32LE(crc32(raw), 16)
        cdfh.writeUInt32LE(data.length, 20)
        cdfh.writeUInt32LE(raw.length, 24)
        cdfh.writeUInt16LE(name.length, 28)
        cdfh.writeUInt32LE(offset, 42)
        name.copy(cdfh, 46)
        central.push(cdfh)

        offset += local.length + data.length + descriptor.length
    }

    const cd = Buffer.concat(central)
    const tail = Buffer.from(comment, 'utf8')
    const eocd = Buffer.alloc(22 + tail.length)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(members.length, 8)
    eocd.writeUInt16LE(members.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(tail.length, 20)
    tail.copy(eocd, 22)

    return Buffer.concat([...locals, cd, eocd])
}

const MODULE = [
    {name: 'example.com/m@v1.0.0/go.mod', body: 'module example.com/m\n\ngo 1.22\n'},
    {name: 'example.com/m@v1.0.0/a.go', body: 'package m\n\nfunc A() {}\n'},
    {name: 'example.com/m@v1.0.0/pkg/b.go', body: 'package pkg\n\nfunc B() {}\n'}
] as const

describe('readZip', () => {
    test('reads every entry through a zeroed local header', () => {
        const entries = readZip(buildZip(MODULE))
        expect(entries.map(e => e.name)).toEqual(MODULE.map(m => m.name))
        expect(entries.every(e => e.compressedSize > 0)).toBe(true)
    })

    test('decompresses deflate and store alike', () => {
        const archive = buildZip([
            {name: 'deflated.txt', body: 'x'.repeat(500)},
            {name: 'stored.txt', body: 'tiny', stored: true}
        ])
        const entries = readZip(archive)
        expect(readEntry(archive, entries[0]).toString()).toBe('x'.repeat(500))
        expect(readEntry(archive, entries[1]).toString()).toBe('tiny')
    })

    test('finds the record behind a long archive comment', () => {
        const archive = buildZip(MODULE, 'c'.repeat(4096))
        expect(readZip(archive)).toHaveLength(3)
    })

    test('a buffer that is not a zip says so rather than returning nothing', () => {
        expect(() => readZip(Buffer.from('not a zip at all'))).toThrow(/no end-of-central/)
    })
})

describe('inflateEntry', () => {
    test('refuses a compression method a Go module zip can never carry', () => {
        expect(() => inflateEntry(Buffer.alloc(4), 12)).toThrow(/unsupported/)
    })
})

describe('isUnsafeEntryName', () => {
    test('rejects the shapes that escape the destination directory', () => {
        expect(isUnsafeEntryName('../outside.go')).toBe(true)
        expect(isUnsafeEntryName('a/../../outside.go')).toBe(true)
        expect(isUnsafeEntryName('/etc/passwd')).toBe(true)
        expect(isUnsafeEntryName('C:/windows/x')).toBe(true)
        expect(isUnsafeEntryName('a\\..\\..\\out')).toBe(true)
        expect(isUnsafeEntryName('')).toBe(true)
    })

    test('accepts an ordinary module entry', () => {
        expect(isUnsafeEntryName('example.com/m@v1.0.0/a.go')).toBe(false)
    })
})

describe('extractZip', () => {
    test('writes nested entries and creates their directories', () => {
        const dir = tmpDir('zip-extract')
        extractZip(buildZip(MODULE), dir)
        expect(fs.readFileSync(path.join(dir, 'example.com/m@v1.0.0/pkg/b.go'), 'utf8')).toContain(
            'func B()'
        )
    })

    test('strip drops the module@version prefix every module zip carries', () => {
        const dir = tmpDir('zip-strip')
        extractZip(buildZip(MODULE), dir, {strip: 2})
        expect(fs.existsSync(path.join(dir, 'pkg/b.go'))).toBe(true)
        expect(fs.existsSync(path.join(dir, 'example.com'))).toBe(false)
    })

    test('filter keeps the walk off files nothing will read', () => {
        const dir = tmpDir('zip-filter')
        const written = extractZip(buildZip(MODULE), dir, {
            filter: e => e.name.endsWith('.go')
        })
        expect(written).toHaveLength(2)
        expect(fs.existsSync(path.join(dir, 'example.com/m@v1.0.0/go.mod'))).toBe(false)
    })

    test('a traversing entry is skipped, not written', () => {
        const dir = tmpDir('zip-traversal')
        const written = extractZip(
            buildZip([{name: '../escaped.go', body: 'package x\n'}, ...MODULE]),
            dir
        )
        expect(written.some(p => p.includes('escaped.go'))).toBe(false)
        expect(fs.existsSync(path.join(path.dirname(dir), 'escaped.go'))).toBe(false)
    })
})

/** A range fetcher over an in-memory archive, counting what it was asked for. */
function rangeOver(archive: Buffer): {fetch: RangeFetch; calls: number[][]; bytes: () => number} {
    const calls: number[][] = []
    return {
        calls,
        bytes: () => calls.reduce((n, [s, e]) => n + (e - s + 1), 0),
        fetch: async (start, end) => {
            calls.push([start, end])
            return archive.subarray(start, Math.min(end + 1, archive.length))
        }
    }
}

describe('readRemoteZip', () => {
    test('lists entries from the tail alone', async () => {
        const archive = buildZip(MODULE)
        const {fetch, calls} = rangeOver(archive)
        const entries = await readRemoteZip(archive.length, fetch)
        expect(entries.map(e => e.name)).toEqual(MODULE.map(m => m.name))
        // The tail read already held the central directory; a second request for
        // it would be a wasted round trip.
        expect(calls).toHaveLength(1)
    })

    test('fetches the central directory separately when it outruns the tail read', async () => {
        // The toolchain archive's directory is 1.5 MB, far past any tail read.
        const many = Array.from({length: 900}, (_, i) => ({
            name: `example.com/m@v1.0.0/deep/directory/name/file${String(i).padStart(5, '0')}.go`,
            body: 'package deep\n'
        }))
        const archive = buildZip(many)
        const {fetch, calls} = rangeOver(archive)
        const entries = await readRemoteZip(archive.length, fetch)
        expect(entries).toHaveLength(900)
        expect(calls).toHaveLength(2)
    })
})

describe('readRemoteEntries', () => {
    test('returns the decompressed bytes of the entries asked for', async () => {
        const archive = buildZip(MODULE)
        const {fetch} = rangeOver(archive)
        const entries = await readRemoteZip(archive.length, fetch)
        const wanted = entries.filter(e => e.name.endsWith('.go'))
        const got = await readRemoteEntries(wanted, fetch)
        expect(got.get('example.com/m@v1.0.0/a.go')?.toString()).toBe('package m\n\nfunc A() {}\n')
        expect(got.get('example.com/m@v1.0.0/pkg/b.go')?.toString()).toContain('func B()')
    })

    test('adjacent entries cost one request, not one each', async () => {
        const archive = buildZip(MODULE)
        const reader = rangeOver(archive)
        const entries = await readRemoteZip(archive.length, reader.fetch)
        reader.calls.length = 0
        await readRemoteEntries(entries, reader.fetch)
        expect(reader.calls).toHaveLength(1)
    })

    test('a far-apart entry is not dragged in by a coalesced span', async () => {
        // Stored, because a run of one character deflates to nothing and would
        // leave the two .go entries close enough to coalesce after all.
        const filler = Array.from({length: 40}, (_, i) => ({
            name: `example.com/m@v1.0.0/filler/${i}.txt`,
            body: 'y'.repeat(8000),
            stored: true
        }))
        const archive = buildZip([MODULE[1], ...filler, MODULE[2]])
        const reader = rangeOver(archive)
        const entries = await readRemoteZip(archive.length, reader.fetch)
        reader.calls.length = 0
        const got = await readRemoteEntries(
            entries.filter(e => e.name.endsWith('.go')),
            reader.fetch
        )
        expect(got.size).toBe(2)
        expect(reader.calls).toHaveLength(2)
        expect(reader.bytes()).toBeLessThan(archive.length / 2)
    })

    test('reads an entry whose data ran past the coalesced span', async () => {
        const archive = buildZip(MODULE)
        const entries = readZip(archive)
        const reader = rangeOver(archive)
        // Truncate every span so the recovery path is the only way through.
        const clipped: RangeFetch = (start, end) => reader.fetch(start, Math.min(end, start + 29))
        const got = await readRemoteEntries([entries[1]], clipped)
        expect(got.get('example.com/m@v1.0.0/a.go')?.toString()).toBe('package m\n\nfunc A() {}\n')
    })
})

describe('findCentralDirectory and parseCentralDirectory', () => {
    test('offsets are absolute even when only a tail was read', () => {
        const archive = buildZip(MODULE)
        const tailStart = archive.length - 200
        const cd = findCentralDirectory(archive.subarray(tailStart), tailStart)
        const entries = parseCentralDirectory(archive.subarray(cd.offset, cd.offset + cd.size))
        expect(entries.map(e => e.name)).toEqual(MODULE.map(m => m.name))
    })
})
