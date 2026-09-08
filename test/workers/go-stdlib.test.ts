import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {deflateRawSync, crc32} from 'node:zlib'
import {randomBytes} from 'node:crypto'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {
    chooseToolchain,
    listToolchains,
    findInGoroot,
    findSliced,
    stdlibDirName,
    acquireStdlibPackage
} from '../../src/workers/go-stdlib.js'

const LIST = [
    'v0.0.1-go1.9.7.linux-amd64',
    'v0.0.1-go1.23.4.linux-amd64',
    'v0.0.1-go1.24.2.linux-amd64',
    'v0.0.1-go1.24.13.linux-amd64',
    'v0.0.1-go1.25.1.linux-amd64',
    'v0.0.1-go1.24.13.darwin-arm64',
    'v0.0.1-go1.26.3.plan9-amd64'
].join('\n')

function listing(body = LIST): typeof fetch {
    return (async () => ({
        ok: true,
        status: 200,
        text: async () => body
    })) as unknown as typeof fetch
}

describe('choosing a toolchain', () => {
    test('reads only the pinned platform, since src is identical across them', async () => {
        const found = await listToolchains(listing())
        expect(found.every(v => v.moduleVersion.endsWith('linux-amd64'))).toBe(true)
        expect(found.map(v => v.goVersion)).toEqual([
            'go1.9.7',
            'go1.23.4',
            'go1.24.2',
            'go1.24.13',
            'go1.25.1'
        ])
    })

    test('orders numerically, so go1.9 does not outrank go1.24', async () => {
        const found = await listToolchains(listing())
        expect(found[found.length - 1].goVersion).toBe('go1.25.1')
    })

    test('takes the newest patch of the version the project asks for', async () => {
        const found = await listToolchains(listing())
        expect(chooseToolchain(found, '1.24')?.goVersion).toBe('go1.24.13')
        expect(chooseToolchain(found, 'go1.23')?.goVersion).toBe('go1.23.4')
    })

    test('falls back to the newest when the project names none, or one long gone', async () => {
        const found = await listToolchains(listing())
        expect(chooseToolchain(found, null)?.goVersion).toBe('go1.25.1')
        expect(chooseToolchain(found, '1.4')?.goVersion).toBe('go1.25.1')
    })

    test('an empty listing is nothing to read, not a crash', () => {
        expect(chooseToolchain([], '1.24')).toBeNull()
    })
})

describe('finding a local copy', () => {
    test('a GOROOT is free and exactly the version the project builds with', () => {
        const goroot = tmpDir('goroot')
        fs.mkdirSync(path.join(goroot, 'src', 'net', 'http'), {recursive: true})
        fs.writeFileSync(path.join(goroot, 'VERSION'), 'go1.24.13\ntime 2026-01-01\n')
        expect(findInGoroot('net/http', goroot)).toEqual({
            dir: path.join(goroot, 'src', 'net', 'http'),
            version: 'go1.24.13'
        })
        expect(findInGoroot('net/nothing', goroot)).toBeNull()
        expect(findInGoroot('net/http', undefined)).toBeNull()
    })

    test('a package sliced out earlier is found by its std@ directory', () => {
        const root = tmpDir('go-modules')
        const dir = path.join(root, stdlibDirName('go1.24.13'), 'net', 'http')
        fs.mkdirSync(dir, {recursive: true})
        expect(findSliced('net/http', [root])).toEqual({dir, version: 'go1.24.13'})
    })

    test('the newest slice on disk wins', () => {
        const root = tmpDir('go-modules-two')
        for (const v of ['go1.23.4', 'go1.24.13']) {
            fs.mkdirSync(path.join(root, stdlibDirName(v), 'fmt'), {recursive: true})
        }
        expect(findSliced('fmt', [root])?.version).toBe('go1.24.13')
    })
})

/** A toolchain-shaped archive, deflate with sizes only in the central directory. */
function buildArchive(files: Record<string, string | Buffer>): Buffer {
    const locals: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const [name, body] of Object.entries(files)) {
        const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')
        const data = deflateRawSync(raw)
        const nameBuf = Buffer.from(name, 'utf8')

        const local = Buffer.alloc(30 + nameBuf.length)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(0x08, 6)
        local.writeUInt16LE(8, 8)
        local.writeUInt16LE(nameBuf.length, 26)
        nameBuf.copy(local, 30)
        locals.push(local, data)

        const cdfh = Buffer.alloc(46 + nameBuf.length)
        cdfh.writeUInt32LE(0x02014b50, 0)
        cdfh.writeUInt16LE(0x08, 8)
        cdfh.writeUInt16LE(8, 10)
        cdfh.writeUInt32LE(crc32(raw), 16)
        cdfh.writeUInt32LE(data.length, 20)
        cdfh.writeUInt32LE(raw.length, 24)
        cdfh.writeUInt16LE(nameBuf.length, 28)
        cdfh.writeUInt32LE(offset, 42)
        nameBuf.copy(cdfh, 46)
        central.push(cdfh)
        offset += local.length + data.length
    }
    const cd = Buffer.concat(central)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(central.length, 8)
    eocd.writeUInt16LE(central.length, 10)
    eocd.writeUInt32LE(cd.length, 12)
    eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...locals, cd, eocd])
}

const PREFIX = 'golang.org/toolchain@v0.0.1-go1.24.13.linux-amd64'
// Random, because the real archive is 60% prebuilt binaries and a run of one
// character would deflate to nothing — leaving no bulk for a slice to avoid.
const ARCHIVE = buildArchive({
    [`${PREFIX}/bin/go`]: randomBytes(300_000),
    [`${PREFIX}/pkg/tool/blob`]: randomBytes(300_000),
    [`${PREFIX}/src/net/http/server.go`]:
        'package http\n\nfunc ListenAndServe() error { return nil }\n',
    [`${PREFIX}/src/net/http/server_test.go`]: 'package http\n',
    [`${PREFIX}/src/net/http/httptest/server.go`]: 'package httptest\n\nfunc NewServer() {}\n',
    [`${PREFIX}/src/fmt/print.go`]: 'package fmt\n\nfunc Println(a ...any) {}\n'
})

interface Served {
    ranges: Array<[number, number]>
    bytes: number
}

/** The proxy as it actually behaves: a HEAD for the size, then ranged GETs. */
function toolchainServer(served: Served): typeof fetch {
    return (async (url: string, init?: {method?: string; headers?: Record<string, string>}) => {
        const u = String(url)
        if (u.endsWith('/list')) return {ok: true, status: 200, text: async () => LIST}
        if (init?.method === 'HEAD') {
            return {
                ok: true,
                status: 200,
                headers: {
                    get: (h: string) => (h === 'content-length' ? String(ARCHIVE.length) : null)
                }
            }
        }
        const range = /bytes=(\d+)-(\d+)/.exec(init?.headers?.range ?? '')
        if (!range) throw new Error('the toolchain archive must never be fetched whole')
        const [start, end] = [Number(range[1]), Number(range[2])]
        served.ranges.push([start, end])
        const slice = ARCHIVE.subarray(start, Math.min(end + 1, ARCHIVE.length))
        served.bytes += slice.length
        return {ok: true, status: 206, arrayBuffer: async () => slice}
    }) as unknown as typeof fetch
}

describe('acquireStdlibPackage', () => {
    test('slices one package out without downloading the archive', async () => {
        const installDir = tmpDir('go-std-slice')
        const served: Served = {ranges: [], bytes: 0}
        const got = await acquireStdlibPackage({
            importPath: 'net/http',
            goDirective: '1.24',
            installDir,
            fetchFn: toolchainServer(served)
        })
        expect(got.success).toBe(true)
        const dir = path.join(installDir, stdlibDirName('go1.24.13'), 'net', 'http')
        expect(fs.readFileSync(path.join(dir, 'server.go'), 'utf8')).toContain(
            'func ListenAndServe'
        )
        // The binaries are 600 KB of the archive and no part of an answer.
        expect(served.bytes).toBeLessThan(ARCHIVE.length / 4)
    })

    test('subdirectories come too, being adjacent and nearly free', async () => {
        const installDir = tmpDir('go-std-subdirs')
        await acquireStdlibPackage({
            importPath: 'net/http',
            goDirective: '1.24',
            installDir,
            fetchFn: toolchainServer({ranges: [], bytes: 0})
        })
        const dir = path.join(installDir, stdlibDirName('go1.24.13'), 'net', 'http', 'httptest')
        expect(fs.existsSync(path.join(dir, 'server.go'))).toBe(true)
    })

    test('another package in the same toolchain reuses the cached entry list', async () => {
        const installDir = tmpDir('go-std-reuse')
        const first: Served = {ranges: [], bytes: 0}
        await acquireStdlibPackage({
            importPath: 'net/http',
            goDirective: '1.24',
            installDir,
            fetchFn: toolchainServer(first)
        })
        const second: Served = {ranges: [], bytes: 0}
        await acquireStdlibPackage({
            importPath: 'fmt',
            goDirective: '1.24',
            installDir,
            fetchFn: toolchainServer(second)
        })
        // Reading the directory again is 1.6 MB against the real archive, and
        // every research child would pay it for its second question.
        expect(second.bytes).toBeLessThan(first.bytes)
    })

    test('a path that is not a package says so rather than writing an empty tree', async () => {
        const installDir = tmpDir('go-std-missing')
        const got = await acquireStdlibPackage({
            importPath: 'net/nonesuch',
            goDirective: '1.24',
            installDir,
            fetchFn: toolchainServer({ranges: [], bytes: 0})
        })
        expect(got.success).toBe(false)
        expect(got.stderr).toContain('net/nonesuch')
    })

    test('a dead proxy is a failure with a reason, not a throw', async () => {
        const dead = (async () => ({
            ok: false,
            status: 503,
            text: async () => ''
        })) as unknown as typeof fetch
        const got = await acquireStdlibPackage({
            importPath: 'net/http',
            goDirective: '1.24',
            installDir: tmpDir('go-std-dead'),
            fetchFn: dead
        })
        expect(got.success).toBe(false)
        expect(got.stderr).not.toBe('')
    })
})
