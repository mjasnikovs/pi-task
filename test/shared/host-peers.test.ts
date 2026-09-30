import {expect, test} from 'bun:test'
import {readdirSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import ts from 'typescript'
import {packageRootOf} from '../../src/workers/pi-worker-docs.js'

interface Manifest {
    name: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
}

const ROOT = path.join(import.meta.dir, '../..')
const readManifest = (file: string): Manifest =>
    JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as Manifest
const own = readManifest('package.json')
const host = readManifest('node_modules/@earendil-works/pi-coding-agent/package.json')

const SOURCE = /\.(ts|mjs)$/

/** Fixtures are data: their stubs import phantom packages on purpose. */
function sourceFiles(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir), {recursive: true, encoding: 'utf8'})
        .filter(f => SOURCE.test(f) && !f.split(/[\\/]/).includes('__fixtures__'))
        .map(f => path.join(dir, f))
}

const rootConfigs = readdirSync(ROOT).filter(f => SOURCE.test(f))

function isModuleCall(call: ts.CallExpression): boolean {
    const callee = call.expression
    return (
        callee.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(callee) && callee.text === 'require')
        || (ts.isPropertyAccessExpression(callee)
            && callee.name.text === 'resolve'
            && ts.isMetaProperty(callee.expression)
            && callee.expression.keywordToken === ts.SyntaxKind.ImportKeyword)
    )
}

/** A full parse: `preProcessFile` reads `from "${x}"` inside a template string as an import. */
function moduleSpecifiers(fileName: string, text: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)
        )
            found.push(node.moduleSpecifier.text)
        else if (
            ts.isImportEqualsDeclaration(node)
            && ts.isExternalModuleReference(node.moduleReference)
            && ts.isStringLiteral(node.moduleReference.expression)
        )
            found.push(node.moduleReference.expression.text)
        else if (
            ts.isCallExpression(node)
            && isModuleCall(node)
            && node.arguments[0]
            && ts.isStringLiteral(node.arguments[0])
        )
            found.push(node.arguments[0].text)
        else if (
            ts.isImportTypeNode(node)
            && ts.isLiteralTypeNode(node.argument)
            && ts.isStringLiteral(node.argument.literal)
        )
            found.push(node.argument.literal.text)
        ts.forEachChild(node, visit)
    }
    visit(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest))
    return found
}

/**
 * Package names a source imports, type-only imports included: they ship in the .d.ts.
 * A builtin must be spelled `node:x`: Bun's `builtinModules` also lists `ws` and `undici`,
 * which are packages on Node.
 */
function packagesIn(fileName: string, text: string): string[] {
    return moduleSpecifiers(fileName, text)
        .filter(s => !s.startsWith('.') && !s.includes(':'))
        .map(packageRootOf)
}

function undeclared(files: string[], declared: Record<string, string>): string[] {
    const missing = files.flatMap(file =>
        packagesIn(file, readFileSync(path.join(ROOT, file), 'utf8'))
            .filter(pkg => !(pkg in declared))
            .map(pkg => `${pkg} (${file})`)
    )
    return [...new Set(missing)]
}

/** Every peer needs a dev pin, and every dev pin the host also ships must match the host's. */
function drift(pkg: Manifest, piHost: Manifest): string[] {
    const shipped = piHost.dependencies ?? {}
    const dev = pkg.devDependencies ?? {}
    const unpinned = Object.keys(pkg.peerDependencies ?? {}).filter(
        p => p !== piHost.name && !(p in dev)
    )
    const offHost = Object.keys(dev).filter(
        p => p in shipped && !Bun.semver.satisfies(dev[p], shipped[p])
    )
    return [...unpinned, ...offHost]
}

test('every peer is a package the pi host ships', () => {
    const shipped = new Set([host.name, ...Object.keys(host.dependencies ?? {})])
    const foreign = Object.keys(own.peerDependencies ?? {}).filter(p => !shipped.has(p))
    expect(foreign).toEqual([])
})

test('tests run against the version of each host package the host ships', () => {
    expect(drift(own, host)).toEqual([])
})

test('drift catches a dev-only host package pinned off the host', () => {
    const offPin = {name: 'x', devDependencies: {'@earendil-works/pi-ai': '0.86.0'}}
    const piHost = {name: 'pi', dependencies: {'@earendil-works/pi-ai': '^0.87.0'}}
    expect(drift(offPin, piHost)).toEqual(['@earendil-works/pi-ai'])
})

test('shipped code imports only runtime dependencies and host peers', () => {
    expect(undeclared(sourceFiles('src'), {...own.dependencies, ...own.peerDependencies})).toEqual(
        []
    )
})

test('tests, scripts and root configs import only declared packages', () => {
    expect(
        undeclared([...sourceFiles('test'), ...sourceFiles('scripts'), ...rootConfigs], {
            ...own.dependencies,
            ...own.peerDependencies,
            ...own.devDependencies,
            bun: 'the runtime the suite runs on'
        })
    ).toEqual([])
})

test('the scan reads every file that can import a package, and no fixture', () => {
    const scanned = [...sourceFiles('scripts'), ...sourceFiles('test'), ...rootConfigs]
    expect(scanned).toContain('eslint.config.mjs')
    expect(scanned).toContain(path.join('scripts', 'node-smoke.mjs'))
    expect(scanned.filter(f => f.includes('__fixtures__'))).toEqual([])
})

test('a package Bun builds in is still a package', () => {
    expect(
        packagesIn('a.ts', "import {WebSocket} from 'ws'\nimport {fetch} from 'undici'")
    ).toEqual(['ws', 'undici'])
})

test('every form that loads a package is read', () => {
    const text = [
        "const a = require('req-pkg')",
        "import b = require('eq-pkg')",
        "const c = import.meta.resolve('@scope/meta-pkg/sub')",
        "const d = `require('in-a-string')`"
    ].join('\n')
    expect(packagesIn('a.ts', text)).toEqual(['req-pkg', 'eq-pkg', '@scope/meta-pkg'])
})
