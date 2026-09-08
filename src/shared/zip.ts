/**
 * zip — reading a zip archive in-process, whole or a slice at a time.
 *
 * Go module zips are why this exists. `unzip` is absent from a default Windows
 * install and GNU tar cannot read zip at all, so shelling out behaves
 * differently on every machine the agent runs on.
 *
 * The slice half is what makes the Go standard library affordable. It ships
 * inside an 83 MB toolchain archive of which any one package is under a
 * megabyte, and a reader that can pull the central directory and then only the
 * entries it wants leaves the other 82 MB on the server.
 */

import {inflateRawSync} from 'node:zlib'
import * as fs from 'node:fs'
import * as path from 'node:path'

const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const CDFH_SIG = 0x02014b50

const EOCD_SIZE = 22
const ZIP64_LOCATOR_SIZE = 20
const LOCAL_HEADER_FIXED = 30

/** A 32-bit field carrying this asks to be read from the zip64 extra field. */
const ZIP64_SENTINEL = 0xffffffff

/** The comment is a 16-bit length, so the EOCD starts no further back than this. */
export const EOCD_SEARCH_SPAN = 0xffff + EOCD_SIZE

const STORED = 0
const DEFLATED = 8

export interface ZipEntry {
    name: string
    method: number
    compressedSize: number
    uncompressedSize: number
    /** Offset of the entry's LOCAL header, which is not where its data begins. */
    localHeaderOffset: number
}

interface CentralDirectoryLocation {
    offset: number
    size: number
}

/**
 * Where the central directory is, given the tail of the file.
 *
 * `tailStart` is that tail's offset in the whole archive, so a caller that
 * fetched only the last few kilobytes still gets absolute offsets back.
 */
export function findCentralDirectory(tail: Buffer, tailStart = 0): CentralDirectoryLocation {
    const eocd = lastIndexOfSignature(tail, EOCD_SIG)
    if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')

    const size = tail.readUInt32LE(eocd + 12)
    const offset = tail.readUInt32LE(eocd + 16)
    if (size !== ZIP64_SENTINEL && offset !== ZIP64_SENTINEL) return {offset, size}

    const locator = eocd - ZIP64_LOCATOR_SIZE
    if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) {
        throw new Error('zip64 archive without a zip64 locator')
    }
    const zip64Eocd = Number(tail.readBigUInt64LE(locator + 8)) - tailStart
    if (zip64Eocd < 0 || tail.readUInt32LE(zip64Eocd) !== ZIP64_EOCD_SIG) {
        throw new Error('zip64 end-of-central-directory record is outside the read span')
    }
    return {
        size: Number(tail.readBigUInt64LE(zip64Eocd + 40)),
        offset: Number(tail.readBigUInt64LE(zip64Eocd + 48))
    }
}

function lastIndexOfSignature(buf: Buffer, sig: number): number {
    for (let i = buf.length - 4; i >= 0; i--) {
        if (buf.readUInt32LE(i) === sig) return i
    }
    return -1
}

/**
 * The entries a central directory declares.
 *
 * Sizes come from HERE and never from a local header: every Go module zip sets
 * the data-descriptor flag, which zeroes the size and CRC fields in the local
 * header and moves the real values to a trailer after the data.
 */
export function parseCentralDirectory(cd: Buffer): ZipEntry[] {
    const entries: ZipEntry[] = []
    let at = 0
    while (at + 46 <= cd.length && cd.readUInt32LE(at) === CDFH_SIG) {
        const nameLen = cd.readUInt16LE(at + 28)
        const extraLen = cd.readUInt16LE(at + 30)
        const commentLen = cd.readUInt16LE(at + 32)
        const entry: ZipEntry = {
            name: cd.toString('utf8', at + 46, at + 46 + nameLen),
            method: cd.readUInt16LE(at + 10),
            compressedSize: cd.readUInt32LE(at + 20),
            uncompressedSize: cd.readUInt32LE(at + 24),
            localHeaderOffset: cd.readUInt32LE(at + 42)
        }
        applyZip64Extra(entry, cd.subarray(at + 46 + nameLen, at + 46 + nameLen + extraLen))
        entries.push(entry)
        at += 46 + nameLen + extraLen + commentLen
    }
    return entries
}

/**
 * Zip64 widens only the fields that overflowed, and packs them in that order.
 * Reading a fixed layout would misplace every value on an entry that overflowed
 * one field but not the one before it.
 */
function applyZip64Extra(entry: ZipEntry, extra: Buffer): void {
    let at = 0
    while (at + 4 <= extra.length) {
        const id = extra.readUInt16LE(at)
        const size = extra.readUInt16LE(at + 2)
        if (id !== 0x0001) {
            at += 4 + size
            continue
        }
        let field = at + 4
        const next = (): number => {
            const v = Number(extra.readBigUInt64LE(field))
            field += 8
            return v
        }
        if (entry.uncompressedSize === ZIP64_SENTINEL) entry.uncompressedSize = next()
        if (entry.compressedSize === ZIP64_SENTINEL) entry.compressedSize = next()
        if (entry.localHeaderOffset === ZIP64_SENTINEL) entry.localHeaderOffset = next()
        return
    }
}

/**
 * Where an entry's compressed bytes start, read from its LOCAL header.
 *
 * The local header's name and extra lengths are its own and may differ from the
 * central directory's — deriving this from the central record produces an offset
 * that is silently a few bytes wrong.
 */
export function dataOffset(local: Buffer, at: number): number {
    return at + LOCAL_HEADER_FIXED + local.readUInt16LE(at + 26) + local.readUInt16LE(at + 28)
}

/** Decompress one entry's raw bytes. */
export function inflateEntry(raw: Buffer, method: number): Buffer {
    if (method === STORED) return raw
    if (method === DEFLATED) return inflateRawSync(raw)
    throw new Error(`unsupported zip compression method ${method}`)
}

/** Every entry of an archive held whole in memory. */
export function readZip(archive: Buffer): ZipEntry[] {
    const tailStart = Math.max(0, archive.length - EOCD_SEARCH_SPAN)
    const {offset, size} = findCentralDirectory(archive.subarray(tailStart), tailStart)
    return parseCentralDirectory(archive.subarray(offset, offset + size))
}

/** One entry's decompressed content, from an archive held whole in memory. */
export function readEntry(archive: Buffer, entry: ZipEntry): Buffer {
    const start = dataOffset(archive, entry.localHeaderOffset)
    return inflateEntry(archive.subarray(start, start + entry.compressedSize), entry.method)
}

/**
 * True for an entry path that would write outside its destination directory.
 * A module zip has never carried one; a malicious archive is the reason to look.
 */
export function isUnsafeEntryName(name: string): boolean {
    if (name === '' || path.isAbsolute(name) || /^[A-Za-z]:/.test(name)) return true
    return name.split(/[/\\]/).some(seg => seg === '..')
}

export interface ExtractOptions {
    /** Which entries to write. Directory entries are absent from a module zip. */
    filter?: (entry: ZipEntry) => boolean
    /** Path segments to drop from the front of every name, for a prefixed archive. */
    strip?: number
}

/** Write an in-memory archive's entries under `dest`. Returns what was written. */
export function extractZip(archive: Buffer, dest: string, options: ExtractOptions = {}): string[] {
    const written: string[] = []
    for (const entry of readZip(archive)) {
        if (entry.name.endsWith('/')) continue
        if (options.filter && !options.filter(entry)) continue
        if (isUnsafeEntryName(entry.name)) continue
        const rel = stripSegments(entry.name, options.strip ?? 0)
        if (rel === null) continue
        const target = path.join(dest, rel)
        fs.mkdirSync(path.dirname(target), {recursive: true})
        fs.writeFileSync(target, readEntry(archive, entry))
        written.push(target)
    }
    return written
}

function stripSegments(name: string, count: number): string | null {
    if (count === 0) return name
    const parts = name.split('/')
    return parts.length > count ? parts.slice(count).join('/') : null
}

/** Fetch `[start, end]` inclusive, the way an HTTP Range request is written. */
export type RangeFetch = (start: number, end: number) => Promise<Buffer>

/**
 * The entries of a remote archive, read from its tail alone.
 *
 * Two requests: the tail, then the central directory. `size` is the archive's
 * total length, which a HEAD or the first ranged response reports.
 */
export async function readRemoteZip(size: number, fetchRange: RangeFetch): Promise<ZipEntry[]> {
    const tailStart = Math.max(0, size - EOCD_SEARCH_SPAN)
    const tail = await fetchRange(tailStart, size - 1)
    const cd = findCentralDirectory(tail, tailStart)
    const held = cd.offset - tailStart
    const bytes =
        held >= 0 && held + cd.size <= tail.length ?
            tail.subarray(held, held + cd.size)
        :   await fetchRange(cd.offset, cd.offset + cd.size - 1)
    return parseCentralDirectory(bytes)
}

/**
 * Room for a local header whose name and extra fields we have not read yet.
 * Go's zip writer emits no local extra field, so this is slack, not a guess at a
 * real value — an entry that overruns it is re-fetched exactly.
 */
const LOCAL_HEADER_SLACK = 4096

/**
 * A gap worth paying for rather than opening a second connection. Well under the
 * bytes a TCP slow-start ramp wastes on an extra round trip.
 */
const COALESCE_GAP = 64 * 1024

/**
 * Fetch some entries of a remote archive, coalescing neighbours into one request.
 *
 * Zip entries are laid out in central-directory order, and the entries of one
 * directory are almost always adjacent, so a package's files come back as a
 * single contiguous read.
 */
export async function readRemoteEntries(
    entries: readonly ZipEntry[],
    fetchRange: RangeFetch
): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>()
    const ordered = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
    for (const span of coalesce(ordered)) {
        const buf = await fetchRange(span.start, span.end)
        for (const entry of span.entries) {
            const at = entry.localHeaderOffset - span.start
            const from = dataOffset(buf, at)
            const to = from + entry.compressedSize
            const raw = to <= buf.length ? buf.subarray(from, to) : await refetch(entry, fetchRange)
            out.set(entry.name, inflateEntry(raw, entry.method))
        }
    }
    return out
}

async function refetch(entry: ZipEntry, fetchRange: RangeFetch): Promise<Buffer> {
    const head = await fetchRange(
        entry.localHeaderOffset,
        entry.localHeaderOffset + LOCAL_HEADER_FIXED - 1
    )
    const start = dataOffset(head, 0) + entry.localHeaderOffset
    return fetchRange(start, start + entry.compressedSize - 1)
}

interface Span {
    start: number
    end: number
    entries: ZipEntry[]
}

function coalesce(ordered: readonly ZipEntry[]): Span[] {
    const spans: Span[] = []
    for (const entry of ordered) {
        const start = entry.localHeaderOffset
        const end = start + LOCAL_HEADER_FIXED + LOCAL_HEADER_SLACK + entry.compressedSize - 1
        const last = spans[spans.length - 1]
        if (last && start - last.end <= COALESCE_GAP) {
            last.end = Math.max(last.end, end)
            last.entries.push(entry)
            continue
        }
        spans.push({start, end, entries: [entry]})
    }
    return spans
}
