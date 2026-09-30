import {expect, test} from 'bun:test'
import {readdirSync, readFileSync} from 'node:fs'
import {builtinModules} from 'node:module'
import * as path from 'node:path'
import ts from 'typescript'

interface Manifest {
    name: string
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    devDependencies?: Record<string, string>
}

const own = JSON.parse(readFileSync('package.json', 'utf8')) as Manifest
const host = JSON.parse(
    readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json', 'utf8')
) as Manifest

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, {recursive: true, encoding: 'utf8'})
        .filter(f => f.endsWith('.ts') && !f.includes('node_modules'))
        .map(f => path.join(dir, f))
}

/** A full parse: `preProcessFile` reads `from "${x}"` inside a template string as an import. */
function moduleSpecifiers(file: string): string[] {
    const found: string[] = []
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
            && node.moduleSpecifier
            && ts.isStringLiteral(node.moduleSpecifier)
        )
            found.push(node.moduleSpecifier.text)
        else if (
            ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
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
    visit(ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest))
    return found
}

/** Package names a file imports, type-only imports included: they ship in the .d.ts. */
function importedPackages(file: string): string[] {
    return moduleSpecifiers(file)
        .filter(s => !s.startsWith('.') && !s.includes(':') && !builtinModules.includes(s))
        .map(s =>
            s
                .split('/')
                .slice(0, s.startsWith('@') ? 2 : 1)
                .join('/')
        )
}

function undeclared(dirs: string[], declared: Record<string, string>): string[] {
    const missing = dirs
        .flatMap(sourceFiles)
        .flatMap(file => importedPackages(file).map(pkg => `${pkg} (${file})`))
        .filter(entry => !(entry.split(' ')[0] in declared))
    return [...new Set(missing)]
}

test('every peer is a package the pi host ships', () => {
    const shipped = new Set([host.name, ...Object.keys(host.dependencies ?? {})])
    const foreign = Object.keys(own.peerDependencies ?? {}).filter(p => !shipped.has(p))
    expect(foreign).toEqual([])
})

test('tests run against the version of each peer the host ships', () => {
    const drifted = Object.entries(own.peerDependencies ?? {})
        .filter(([peer]) => peer !== host.name)
        .map(([peer]) => ({
            peer,
            dev: own.devDependencies?.[peer],
            host: host.dependencies?.[peer]
        }))
        .filter(p => !p.dev || !p.host || !Bun.semver.satisfies(p.dev, p.host))
    expect(drifted).toEqual([])
})

test('shipped code imports only runtime dependencies and host peers', () => {
    expect(undeclared(['src'], {...own.dependencies, ...own.peerDependencies})).toEqual([])
})

test('tests and scripts import only declared packages', () => {
    expect(
        undeclared(['test', 'scripts'], {
            ...own.dependencies,
            ...own.peerDependencies,
            ...own.devDependencies
        })
    ).toEqual([])
})
