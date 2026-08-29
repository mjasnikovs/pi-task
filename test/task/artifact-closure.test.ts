import {describe, expect, test} from 'bun:test'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {
    normalizeRefPath,
    extractJsRefs,
    extractHtmlRefs,
    extractScriptEntrypoints,
    collectProducersFromCommand,
    collectProducersFromSource,
    collectEmittedHtml,
    emptyProducers,
    resolveDanglingRefs,
    findDanglingArtifacts,
    findSpecDanglingArtifacts,
    specListsFile,
    titlesCoverArtifact,
    danglingGateFailureText,
    danglingMissingText,
    danglingCarryText,
    type RuntimeRef
} from '../../src/task/artifact-closure.js'

describe('normalizeRefPath', () => {
    test('normalizes relative literals', () => {
        expect(normalizeRefPath('./dist/index.html')).toBe('dist/index.html')
        expect(normalizeRefPath('dist\\index.html')).toBe('dist/index.html')
        expect(normalizeRefPath('/app.css?v=2#x')).toBe('app.css')
        expect(normalizeRefPath('`dist/app.css`')).toBe('dist/app.css')
    })

    test('steps aside on anything non-literal or non-local', () => {
        for (const bad of [
            'https://cdn.example.com/x.js',
            '//cdn.example.com/x.js',
            'data:image/png;base64,xyz',
            'dist/${name}.html',
            'dist/*.html',
            'node_modules/pkg/index.js',
            '~/x.json',
            'a b.html',
            ''
        ]) {
            expect(normalizeRefPath(bad)).toBeNull()
        }
    })
})

describe('extractJsRefs', () => {
    test('extracts the mx5 run-13 SPA-fallback read (guarded reads still count)', () => {
        // The real server GUARDED the read (`if (!(await htmlFile.exists())) return
        // c.notFound()`) — the guard IS the 404, so it must not step aside.
        const refs = extractJsRefs(
            [
                "const htmlFile = Bun.file('dist/index.html')",
                'if (!(await htmlFile.exists())) return c.notFound()'
            ].join('\n'),
            'src/server/index.ts'
        )
        expect(refs).toHaveLength(1)
        expect(refs[0]).toMatchObject({
            path: 'dist/index.html',
            construct: 'Bun.file',
            kind: 'file'
        })
    })

    test('extracts readFile/createReadStream/sendFile/serveStatic/express.static', () => {
        const refs = extractJsRefs(
            [
                "await readFile('config/app.json', 'utf8')",
                "fs.readFileSync('data/seed.sql')",
                "createReadStream('assets/logo.png')",
                "res.sendFile('pages/404.html')",
                "app.use('/static', serveStatic({root: './public'}))",
                "app.use(express.static('www'))"
            ].join('\n'),
            'src/app.ts'
        )
        expect(refs.map(r => r.path)).toEqual([
            'config/app.json',
            'data/seed.sql',
            'assets/logo.png',
            'pages/404.html',
            'public',
            'www'
        ])
        expect(refs.filter(r => r.kind === 'dir')).toHaveLength(2)
    })

    test('steps aside on dynamic args, comments, and extension-less strings', () => {
        const refs = extractJsRefs(
            [
                'await readFile(configPath)',
                'Bun.file(path.join(dir, "x.html"))',
                'Bun.file(`dist/${page}.html`)',
                "// Bun.file('dist/commented-out.html')",
                "Bun.file('LICENSE-ISH-NAME')" // no extension — name-shaped
            ].join('\n'),
            'src/app.ts'
        )
        expect(refs).toHaveLength(0)
    })
})

describe('extractHtmlRefs', () => {
    test('extracts local script/link/img assets, skips URLs and routes', () => {
        const refs = extractHtmlRefs(
            [
                '<script type="module" src="./main.js"></script>',
                '<link rel="stylesheet" href="/app.css">',
                '<img src="img/logo.png">',
                '<script src="https://cdn.example.com/lib.js"></script>',
                '<a href="/about">About</a>',
                '<link rel="preconnect" href="//fonts.example.com">'
            ].join('\n'),
            'index.html'
        )
        expect(refs.map(r => r.path)).toEqual(['main.js', 'app.css', 'img/logo.png'])
    })
})

describe('extractScriptEntrypoints', () => {
    test('extracts runner entrypoints from script bodies', () => {
        expect(
            extractScriptEntrypoints(
                'bun run --watch src/server/index.ts',
                'package.json scripts.dev'
            )
        ).toMatchObject([{path: 'src/server/index.ts', construct: 'script entrypoint'}])
        expect(extractScriptEntrypoints('node dist/index.js', 's')).toMatchObject([
            {path: 'dist/index.js'}
        ])
    })

    test('ignores script names, flags, and non-runner commands', () => {
        expect(extractScriptEntrypoints('bun run test', 's')).toHaveLength(0)
        expect(
            extractScriptEntrypoints('bunx playwright test --config=x.config.ts', 's')
        ).toHaveLength(0)
        expect(extractScriptEntrypoints('prettier --write src/', 's')).toHaveLength(0)
    })
})

describe('collectProducersFromCommand', () => {
    test('parses the mx5 tailwind output flag (file) and bundler outdirs (dir+stems)', () => {
        const prod = emptyProducers()
        collectProducersFromCommand(
            'bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css',
            prod
        )
        expect(prod.files.has('dist/app.css')).toBe(true)
        collectProducersFromCommand('esbuild src/worker.ts --outdir dist', prod)
        expect(prod.enumerable.get('dist')?.has('worker')).toBe(true)
        // -i is an INPUT flag: index.css must not be recorded as an output.
        expect(prod.files.has('src/client/index.css')).toBe(false)
    })

    test('parses redirects, cp/touch destinations, and mkdir dirs', () => {
        const prod = emptyProducers()
        collectProducersFromCommand('some-tool 2>&1 > logs/build.log', prod)
        collectProducersFromCommand('cp template.html dist/index.html', prod)
        collectProducersFromCommand('mkdir -p data', prod)
        expect(prod.files.has('logs/build.log')).toBe(true)
        expect(prod.files.has('dist/index.html')).toBe(true)
        expect(prod.dirs.has('data')).toBe(true)
    })

    test('unknown commands make the dirs they touch OPAQUE (inconclusive steps aside)', () => {
        const prod = emptyProducers()
        collectProducersFromCommand('somegen --target assets/generated', prod)
        expect(prod.opaque.has('assets/generated')).toBe(true)
    })

    test('known bundlers with unenumerable outputs mark their default dir opaque', () => {
        const prod = emptyProducers()
        collectProducersFromCommand('vite build', prod)
        expect(prod.opaque.has('dist')).toBe(true)
    })
})

describe('collectProducersFromSource', () => {
    test('parses the real mx5 build.ts shape: mkdir + spawn-array tailwind + Bun.build', () => {
        const prod = emptyProducers()
        collectProducersFromSource(
            [
                'fs.mkdirSync("dist", { recursive: true })',
                'const tailwind = Bun.spawn(["bun", "x", "@tailwindcss/cli", "-i", "src/client/index.css", "-o", "dist/app.css"])',
                'await Bun.build({',
                '  entrypoints: ["src/client/main.tsx"],',
                '  outdir: "dist",',
                '  minify: true,',
                '  splitting: true,',
                '})'
            ].join('\n'),
            prod
        )
        expect(prod.dirs.has('dist')).toBe(true)
        expect(prod.files.has('dist/app.css')).toBe(true)
        expect(prod.enumerable.get('dist')?.has('main')).toBe(true)
        // …and index is NOT among the enumerated stems: the run-13 evidence.
        expect(prod.enumerable.get('dist')?.has('index')).toBe(false)
    })

    test('Bun.build with a naming option is opaque (outputs underivable)', () => {
        const prod = emptyProducers()
        collectProducersFromSource(
            'await Bun.build({entrypoints: ["src/a.ts"], outdir: "dist", naming: "[dir]/[name]-[hash].[ext]"})',
            prod
        )
        expect(prod.opaque.has('dist')).toBe(true)
    })

    test('write-side calls register produced files', () => {
        const prod = emptyProducers()
        collectProducersFromSource(
            [
                'await Bun.write("dist/manifest.json", data)',
                "writeFileSync('cache/state.json', s)"
            ].join('\n'),
            prod
        )
        expect(prod.files.has('dist/manifest.json')).toBe(true)
        expect(prod.files.has('cache/state.json')).toBe(true)
    })
})

describe('resolveDanglingRefs', () => {
    const ref = (p: string, over: Partial<RuntimeRef> = {}): RuntimeRef => ({
        path: p,
        referencer: 'src/server/index.ts',
        construct: 'Bun.file',
        kind: 'file',
        ...over
    })

    test('flags a ref under an enumerable outdir whose outputs do not include it', () => {
        const prod = emptyProducers()
        collectProducersFromCommand('bunx tailwindcss -o dist/app.css', prod)
        collectProducersFromSource(
            'Bun.build({entrypoints: ["src/client/main.tsx"], outdir: "dist"})',
            prod
        )
        const out = resolveDanglingRefs([ref('dist/index.html')], prod, () => false)
        expect(out).toHaveLength(1)
        expect(out[0].reason).toContain('build output directory')
    })

    test('satisfied by existence, exact produced file, enumerated stem, or opaque dir', () => {
        const prod = emptyProducers()
        collectProducersFromSource(
            'Bun.build({entrypoints: ["src/client/main.tsx"], outdir: "dist"})',
            prod
        )
        prod.files.add('dist/app.css')
        prod.opaque.add('generated')
        expect(resolveDanglingRefs([ref('dist/index.html')], prod, () => true)).toHaveLength(0)
        expect(resolveDanglingRefs([ref('dist/app.css')], prod, () => false)).toHaveLength(0)
        expect(resolveDanglingRefs([ref('dist/main.js')], prod, () => false)).toHaveLength(0)
        expect(resolveDanglingRefs([ref('generated/x.json')], prod, () => false)).toHaveLength(0)
    })

    test('steps aside without positive producer evidence (never evidence from absence)', () => {
        // No build machinery at all: a missing file COULD come from anywhere.
        const out = resolveDanglingRefs(
            [ref('templates/email.html')],
            emptyProducers(),
            () => false
        )
        expect(out).toHaveLength(0)
    })

    test('a missing source-extension script entrypoint is hard evidence on its own', () => {
        const out = resolveDanglingRefs(
            [
                ref('src/server/index.ts', {
                    referencer: 'package.json scripts.start',
                    construct: 'script entrypoint'
                })
            ],
            emptyProducers(),
            () => false
        )
        expect(out).toHaveLength(1)
    })

    test('relative refs satisfied from the referencing file directory', () => {
        const exists = (p: string): boolean => p === 'playwright/index.ts'
        const out = resolveDanglingRefs(
            [ref('index.ts', {referencer: 'playwright/index.html', construct: 'script src'})],
            emptyProducers(),
            exists
        )
        expect(out).toHaveLength(0)
    })

    test('dir refs: flagged only when machinery exists and nothing produces the root', () => {
        const bare = resolveDanglingRefs(
            [ref('public', {kind: 'dir', construct: 'serveStatic root'})],
            emptyProducers(),
            () => false
        )
        expect(bare).toHaveLength(0) // no producer machinery → no evidence
        const prod = emptyProducers()
        prod.files.add('dist/app.css')
        const flagged = resolveDanglingRefs(
            [ref('public', {kind: 'dir', construct: 'serveStatic root'})],
            prod,
            () => false
        )
        expect(flagged).toHaveLength(1)
        const produced = resolveDanglingRefs(
            [ref('public', {kind: 'dir', construct: 'serveStatic root'})],
            prod,
            p => p === 'public'
        )
        expect(produced).toHaveLength(0)
    })
})

describe('findDanglingArtifacts (tree seam)', () => {
    function makeRepo(): string {
        const dir = mkdtempSync(path.join(tmpdir(), 'artifact-closure-'))
        mkdirSync(path.join(dir, 'src/server'), {recursive: true})
        mkdirSync(path.join(dir, 'src/client'), {recursive: true})
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({
                name: 'fx',
                scripts: {build: 'bun build.ts', start: 'bun src/server/index.ts'}
            })
        )
        writeFileSync(
            path.join(dir, 'build.ts'),
            [
                'fs.mkdirSync("dist", {recursive: true})',
                'Bun.spawn(["bunx", "@tailwindcss/cli", "-i", "src/client/index.css", "-o", "dist/app.css"])',
                'await Bun.build({entrypoints: ["src/client/main.tsx"], outdir: "dist"})'
            ].join('\n')
        )
        writeFileSync(
            path.join(dir, 'src/server/index.ts'),
            [
                "const htmlFile = Bun.file('dist/index.html')",
                'if (!(await htmlFile.exists())) return c.notFound()'
            ].join('\n')
        )
        writeFileSync(path.join(dir, 'src/client/main.tsx'), 'export {}')
        writeFileSync(path.join(dir, 'src/client/index.css'), '')
        return dir
    }

    test('run-13 replay: flags dist/index.html, names referencer + path', () => {
        const dir = makeRepo()
        try {
            const out = findDanglingArtifacts(dir)
            expect(out).toHaveLength(1)
            expect(out[0]).toMatchObject({
                path: 'dist/index.html',
                referencer: 'src/server/index.ts'
            })
            const text = danglingGateFailureText(out[0])
            expect(text).toContain('src/server/index.ts')
            expect(text).toContain('dist/index.html')
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    test('goes quiet once a producer exists (cp in a script) or the file exists', () => {
        const dir = makeRepo()
        try {
            // A task added the producing side: build copies a template into dist.
            const pkg = JSON.parse(
                JSON.stringify({
                    name: 'fx',
                    scripts: {
                        build: 'bun build.ts && cp src/client/template.html dist/index.html',
                        start: 'bun src/server/index.ts'
                    }
                })
            ) as object
            writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg))
            expect(findDanglingArtifacts(dir)).toHaveLength(0)
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })

    test('missing script entrypoint is flagged; test/fixture trees are not scanned', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'artifact-closure-'))
        try {
            writeFileSync(
                path.join(dir, 'package.json'),
                JSON.stringify({name: 'fx', scripts: {start: 'bun src/main.ts'}})
            )
            mkdirSync(path.join(dir, 'test'), {recursive: true})
            // Would be a hit if tests were scanned — they are not.
            writeFileSync(path.join(dir, 'test', 'x.ts'), "Bun.file('dist/never.html')")
            const out = findDanglingArtifacts(dir)
            expect(out).toHaveLength(1)
            expect(out[0]).toMatchObject({path: 'src/main.ts', construct: 'script entrypoint'})
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    })
})

// The mx5 run-18 shape: the final-gate autofix closed `dist/index.html` by
// APPENDING an HTML template literal to build.ts and Bun.write-ing it — and that
// page pointed at `/app.css`, which only the watch-mode `dev:css` script emits.
// Every test below pins one of nexttask 3's pre-registered invariants.
describe('generated HTML (nexttask 3)', () => {
    const BUILD_HEAD = "await Bun.build({entrypoints: ['src/main.ts'], outdir: 'dist'})"
    const emit = (body: string): string =>
        [BUILD_HEAD, '', `const html = \`${body}\``, '', "Bun.write('dist/index.html', html)"].join(
            '\n'
        )

    function makeRepo(files: Record<string, string>, scripts: Record<string, string>): string {
        const dir = mkdtempSync(path.join(tmpdir(), 'gen-html-'))
        writeFileSync(
            path.join(dir, 'package.json'),
            JSON.stringify({name: 'fx', scripts: {build: 'bun run build.ts', ...scripts}})
        )
        for (const [rel, body] of Object.entries({'src/main.ts': 'export {}', ...files})) {
            const abs = path.join(dir, rel)
            mkdirSync(path.dirname(abs), {recursive: true})
            writeFileSync(abs, body)
        }
        return dir
    }

    function scan(files: Record<string, string>, scripts: Record<string, string> = {}): string[] {
        const dir = makeRepo(files, scripts)
        try {
            return findDanglingArtifacts(dir)
                .map(d => d.path)
                .sort()
        } finally {
            rmSync(dir, {recursive: true, force: true})
        }
    }

    test('collectEmittedHtml resolves a const binding and ignores non-HTML writes', () => {
        const out = collectEmittedHtml(
            [
                'const html = `<!doctype html><body><img src="/x.png"></body>`',
                "Bun.write('dist/index.html', html)",
                "Bun.write('dist/meta.json', JSON.stringify({a: 1}))",
                'writeFileSync(\'dist/inline.html\', `<html><link href="/y.css"></html>`)'
            ].join('\n')
        )
        expect(out.map(e => e.docPath)).toEqual(['dist/index.html', 'dist/inline.html'])
        expect(out[0].html).toContain('/x.png')
    })

    test('the run-18 replay: a watch-only producer does NOT close a generated ref', () => {
        // inv-dev-only-is-dangling — the rule the whole task turns on. `bun run
        // build` never invokes `dev:css`, so the shipped page has no CSS.
        expect(
            scan(
                {
                    'build.ts': emit(
                        '<html><head><link rel="stylesheet" href="/app.css" /></head>'
                            + '<body><script type="module" src="/main.js"></script></body></html>'
                    ),
                    'src/app.css': ''
                },
                {'dev:css': 'bunx @tailwindcss/cli -i src/app.css -o dist/app.css --watch'}
            )
            // /main.js IS produced (Bun.build entrypoint stem `main` in dist).
        ).toEqual(['dist/app.css'])
    })

    test('a real build step closes the same reference (the rule discriminates)', () => {
        expect(
            scan(
                {
                    'build.ts': emit('<html><link rel="stylesheet" href="/app.css" /></html>'),
                    'src/app.css': ''
                },
                {
                    build: 'bun run build.ts && bun run build:css',
                    'build:css': 'bunx @tailwindcss/cli -i src/app.css -o dist/app.css'
                }
            )
        ).toEqual([])
    })

    test('a --watch body counts as a dev script even when the name does not', () => {
        expect(
            scan(
                {
                    'build.ts': emit('<html><link rel="stylesheet" href="/app.css" /></html>'),
                    'src/app.css': ''
                },
                {css: 'bunx @tailwindcss/cli -i src/app.css -o dist/app.css --watch'}
            )
        ).toEqual(['dist/app.css'])
    })

    test('inv-scheme-urls-ignored: schemes, protocol-relative and routes never fire', () => {
        expect(
            scan({
                'build.ts': emit(
                    '<html><head><script src="https://cdn.example/x.js"></script>'
                        + '<link rel="stylesheet" href="//cdn.example/x.css" />'
                        + '<link rel="icon" href="data:image/png;base64,AAAA" />'
                        + '<link rel="canonical" href="#top" /></head>'
                        + '<body><a href="/about">about</a></body></html>'
                )
            })
        ).toEqual([])
    })

    test('inv-non-build-html-ignored: an email-body literal is never scanned', () => {
        // The real shape: ~/hub/aiz-server/src/connections/mailTemplate.ts is
        // `export default \`<!doctype html>…\`` — an email body, written nowhere.
        // A cid: asset AND a root-relative one must both stay invisible.
        expect(
            scan({
                'build.ts': BUILD_HEAD,
                'src/mail-template.ts':
                    'export default `<!doctype html><body><img src="cid:logo" />'
                    + '<link rel="stylesheet" href="/brand.css" /><img src="/pixel.png" /></body>`'
            })
        ).toEqual([])
    })

    test('HTML written outside any declared build outdir is out of scope', () => {
        // `report/` is not a build outdir — writing one file there must not turn
        // the directory into a closure surface for its siblings.
        expect(
            scan({
                'build.ts':
                    'const html = `<html><img src="logo.png"></html>`\n'
                    + "Bun.write('report/out.html', html)"
            })
        ).toEqual([])
    })

    test('root-relative resolves against the outdir, document-relative against the doc', () => {
        // Same missing asset reached two ways from a nested document: `/a.css`
        // hangs off the static root (dist), `b.css` off the document's own dir.
        expect(
            scan({
                'build.ts':
                    `${BUILD_HEAD}\n`
                    + 'const html = `<html><link href="/a.css" /><link href="b.css" /></html>`\n'
                    + "Bun.write('dist/pages/p.html', html)"
            })
        ).toEqual(['dist/a.css', 'dist/pages/b.css'])
    })

    test('media tags are scanned in generated HTML', () => {
        expect(
            scan({
                'build.ts': emit('<html><video><source src="/clip.mp4" /></video></html>')
            })
        ).toEqual(['dist/clip.mp4'])
    })

    test('an asset that exists on disk or is a build entrypoint stem is satisfied', () => {
        expect(
            scan({
                'build.ts': emit(
                    '<html><script type="module" src="/main.js"></script>'
                        + '<link rel="icon" href="/favicon.ico" /></html>'
                ),
                'dist/favicon.ico': ''
            })
        ).toEqual([])
    })
})

describe('findSpecDanglingArtifacts (plan-time seam)', () => {
    // Distilled from the real DESIGN/PROJECT.md: prose serving line (L224), file
    // tree (§7, no index.html), build section (§9: css file + Bun.build js).
    const MX5ISH_SPEC = [
        '## 3. File tree',
        '```',
        '├─ src/',
        '│  └─ client/',
        '│     ├─ main.tsx               # React root',
        '│     ├─ index.css              # tailwind',
        '```',
        '',
        '**SPA fallback:** non-`/api` GETs serve the built `index.html`.',
        '',
        '## 9. Build & run',
        '- **Client CSS:** `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`',
        '- **Client JS:** `Bun.build({ entrypoints: ["src/client/main.tsx"], outdir: "dist", minify, splitting })` (in `build.ts`)'
    ].join('\n')

    test('flags the run-13 spec dangle: index.html served but never produced', () => {
        const out = findSpecDanglingArtifacts(MX5ISH_SPEC, () => false)
        expect(out).toHaveLength(1)
        expect(out[0].path).toBe('index.html')
        expect(out[0].construct).toContain('spec prose')
    })

    test('goes quiet when the file tree lists it, an output produces it, or it exists', () => {
        const listed = MX5ISH_SPEC.replace(
            '│     ├─ main.tsx               # React root',
            '│     ├─ main.tsx               # React root\n│     ├─ index.html             # SPA shell'
        )
        expect(findSpecDanglingArtifacts(listed, () => false)).toHaveLength(0)
        const produced = MX5ISH_SPEC.replace(
            '-o dist/app.css',
            '-o dist/app.css && cp src/index.html dist/index.html'
        )
        expect(findSpecDanglingArtifacts(produced, () => false)).toHaveLength(0)
        expect(findSpecDanglingArtifacts(MX5ISH_SPEC, p => p.endsWith('index.html'))).toHaveLength(
            0
        )
    })

    test('a spec with no parseable build outputs yields no prose verdict', () => {
        const spec = 'The server serves the built `index.html` for non-API GETs.'
        expect(findSpecDanglingArtifacts(spec, () => false)).toHaveLength(0)
    })

    test('code-construct refs in spec snippets resolve like tree refs', () => {
        const spec = [
            '```ts',
            "const htmlFile = Bun.file('dist/index.html')",
            '```',
            '- build: `Bun.build({ entrypoints: ["src/client/main.tsx"], outdir: "dist" })`'
        ].join('\n')
        const out = findSpecDanglingArtifacts(spec, () => false)
        expect(out).toHaveLength(1)
        expect(out[0].path).toBe('dist/index.html')
        expect(out[0].construct).toBe('Bun.file')
    })

    test('doc files and blockquotes never produce findings', () => {
        const spec = [
            'Read `README.md` first; the tool loads `CONTRIBUTING.md`.',
            '> see the discussion of dist/index.html for background',
            '- CSS: `tailwindcss -o dist/app.css`'
        ].join('\n')
        expect(findSpecDanglingArtifacts(spec, () => false)).toHaveLength(0)
    })
})

describe('specListsFile / titlesCoverArtifact / texts', () => {
    test('specListsFile: tree entries and artifact bullets count, mid-sentence prose does not', () => {
        const spec = [
            '│     ├─ index.css              # tokens',
            '- `src/app.ts` main entry',
            'non-`/api` GETs serve the built `index.html`.'
        ].join('\n')
        expect(specListsFile(spec, 'src/client/index.css')).toBe(true)
        expect(specListsFile(spec, 'src/app.ts')).toBe(true)
        expect(specListsFile(spec, 'dist/index.html')).toBe(false)
    })

    test('titlesCoverArtifact: basename or full-path mention claims the artifact', () => {
        const ref = {path: 'dist/index.html'}
        expect(titlesCoverArtifact(['Create index.html template and static serving'], ref)).toBe(
            true
        )
        expect(titlesCoverArtifact(['Build the API server'], ref)).toBe(false)
    })

    test('missing/carry texts name the path and the producing obligation', () => {
        const d = {
            path: 'dist/index.html',
            referencer: 'spec',
            construct: 'spec prose (serve/read)',
            kind: 'file' as const,
            reason: 'r'
        }
        expect(danglingMissingText(d)).toContain('dist/index.html')
        expect(danglingCarryText(d)).toContain('NOTHING creates it')
    })
})

describe('zero-FP self-scan', () => {
    test('pi-task repo itself yields no dangling artifacts', () => {
        const repo = path.resolve(import.meta.dir, '../..')
        expect(findDanglingArtifacts(repo)).toEqual([])
    })
})
