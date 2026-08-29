/**
 * artifact-closure — dangling runtime file references.
 *
 * The failure this closes: a runtime file reference with NO producer anywhere in
 * the plan ships silently. A server's SPA fallback reads
 * `Bun.file('dist/index.html')`; the build emits only `app.css` and `main.js`;
 * nothing — no task, no script, no build output — ever CREATES `index.html`, so
 * the app 404s on every non-API GET. Sentence-grounded coverage cannot see it,
 * because it credits the SERVING side to the server's task and is structurally
 * blind to the missing PRODUCING side. The spec can be internally dangling the
 * same way: prose requiring `index.html` be served while the file tree and build
 * section never define it.
 *
 * Reproduced end-to-end while checking this file. A tree whose build runs
 * `bun build entry.ts --outdir dist` and `tailwindcss -o dist/app.css`, with a
 * server reading `dist/index.html`, `dist/app.css` and `dist/entry.js`, reports
 * exactly ONE dangle — `dist/index.html` — and the other two stay silent.
 *
 * Two seams consume this module:
 *   • plan-time (auto-orchestrator): refs extracted from the SPEC's own snippets
 *     that neither the spec's file tree, its build outputs, nor the existing
 *     scaffold produce become UNOWNED areas — they ride the coverage loop's
 *     `missing` list (forcing a round that assigns a producing task) and are
 *     carried into `.pi-tasks/requirements.md` when still unowned at exhaustion.
 *   • final gate: the shipped tree is scanned; a dangling reference is a ranked
 *     failure naming referencer + missing path.
 *
 * FP discipline — ground in artifacts the model cannot fake, and treat
 * inconclusive as never being evidence. Each rule below was run:
 *   • literal string paths only. A template hole, a bare variable and a
 *     concatenation each extract nothing; the literal beside them extracts.
 *   • a ref is DANGLING only on POSITIVE producer evidence: it must sit under a
 *     directory whose outputs could actually be ENUMERATED (parsed build
 *     script/flags) and not be among them — or be a missing source-extension
 *     script entrypoint, which nothing ever builds. A ref under a directory
 *     produced by machinery that could NOT be enumerated is OPAQUE and steps
 *     aside. Demonstrated on ONE tree by changing only the build command:
 *     `vite build` (opaque `dist`) reports zero dangles, while
 *     `bun build entry.ts --outdir dist` (enumerable `dist`) reports both refs.
 *   • gitignored-but-built paths therefore never fire: being built means a
 *     producer names them (exact file, enumerable stem, or opaque dir).
 *   • existence is checked on the live tree, so anything already present —
 *     committed, generated or hand-made — is satisfied. Creating a GITIGNORED
 *     `dist/index.html` took the same tree from one dangle to none.
 *
 * A GUARDED read does NOT step aside, deliberately. An existence guard
 * (`if (!(await htmlFile.exists())) return c.notFound()`) is exactly how this bug
 * presents — a permanent 404 rather than a crash — so the guard is a symptom, not
 * an all-clear. Confirmed: the same ref flags with and without the guard.
 */
import {existsSync, readdirSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {shippedSources, stripCommentLines, SOURCE_HTML_RE, SOURCE_JS_RE} from './shipped-source.js'

export interface RuntimeRef {
    /** Repo-relative normalized path (posix separators, no leading ./). */
    path: string
    /** Where the reference lives: repo-relative file, `package.json scripts.X`, or 'spec'. */
    referencer: string
    /** The construct that matched (Bun.file, readFile, script src, …). */
    construct: string
    /** file = must exist as a file; dir = a static root that must exist as a directory. */
    kind: 'file' | 'dir'
}

export interface DanglingRef extends RuntimeRef {
    /** Why the producer resolution came up empty (human- and prompt-readable). */
    reason: string
}

/** Everything the tree/scripts/build POSITIVELY produce. */
export interface ProducedOutputs {
    /** Exact output files (tailwind -o, --outfile, redirects, Bun.write, cp dest…). */
    files: Set<string>
    /** Enumerable outdir → output STEMS (basename sans extension) it emits —
     *  from parsed Bun.build entrypoints, explicit output files, source args. */
    enumerable: Map<string, Set<string>>
    /** Dirs produced by machinery we could not enumerate (vite/tsc/next/unknown
     *  commands naming them) — everything under them steps aside. */
    opaque: Set<string>
    /** Dirs known to be created (mkdir, outdirs) — satisfies dir-kind refs. */
    dirs: Set<string>
    /** Dirs a BUILD TOOL declared as its output location (`--outdir`, `Bun.build`
     *  outdir, a bundler's known dir, tsconfig/vite outDir). Strictly narrower
     *  than `dirs`: writing one file into `report/` makes `report` enumerable but
     *  never a build outdir. Generated-HTML scanning is gated on this set, so a
     *  one-off HTML report writer cannot pull its assets into the check. */
    outdirs: Set<string>
}

export function emptyProducers(): ProducedOutputs {
    return {
        files: new Set(),
        enumerable: new Map(),
        opaque: new Set(),
        dirs: new Set(),
        outdirs: new Set()
    }
}

/** Normalize a literal path: posix separators, strip `./` prefixes, query/hash
 *  tails (HTML), wrapping quotes, trailing slash. Returns null when the literal
 *  is not a checkable repo path — a scheme URL, protocol-relative `//host/x`,
 *  `~`, a `${…}` hole, a glob, anything with embedded whitespace, and anything
 *  under `node_modules/`.
 *
 *  A single leading `/` is NOT a rejection: it is treated as root-relative and
 *  resolved from the repo root, which is what `<script src="/app.js">` means.
 *  So `/app.js` normalizes to `app.js`. A drive-letter path like `C:\win\a.js`
 *  is rejected, but as a SCHEME, not as an absolute path. */
export function normalizeRefPath(raw: string): string | null {
    let p = raw.trim().replace(/\\/g, '/')
    // Markdown/shell wrapping (a spec bullet's `-o dist/app.css` arrives with a
    // trailing backtick) — strip wrapping quote characters at both ends.
    p = p.replace(/^[`'"]+/, '').replace(/[`'"]+$/, '')
    // HTML-side noise: ?query / #fragment tails.
    p = p.replace(/[?#].*$/, '')
    if (p.length === 0 || p.length > 200) return null
    // Dynamic/glob/scheme/absolute — inconclusive, never evidence. A remaining
    // quote or whitespace mid-token means we mis-tokenized — step aside.
    if (/\$\{|[*?]|^[a-z][a-z0-9+.-]*:|^\/\/|^~|[`'"\s]/i.test(p)) return null
    while (p.startsWith('./')) p = p.slice(2)
    if (p.startsWith('/')) p = p.slice(1) // root-relative (HTML) → resolve from repo root
    p = p.replace(/\/+$/, '')
    if (p.length === 0 || p === '.' || p === '..') return null
    if (p.startsWith('node_modules/') || p.includes('/node_modules/')) return null
    return p
}

const stem = (p: string): string => path.posix.basename(p).replace(/\.[^.]+$/, '')
const hasExt = (p: string): boolean => /\.[A-Za-z0-9]{1,8}$/.test(path.posix.basename(p))
/** Source-only extensions nothing ships un-built: a missing one of these is hard
 *  evidence on its own (a script entrypoint like `bun src/server/index.ts`). */
const SOURCE_ONLY_EXT_RE = /\.(?:ts|tsx|mts|cts|jsx)$/i

interface Pattern {
    re: RegExp
    construct: string
    kind: 'file' | 'dir'
}

// Literal-first-argument read-side constructs. `[^'"\`\n]` keeps the argument on
// one line and free of a closing quote; normalizeRefPath rejects `${…}` holes.
const JS_READ_PATTERNS: Pattern[] = [
    {re: /\bBun\.file\(\s*(['"`])([^'"`\n]+)\1/g, construct: 'Bun.file', kind: 'file'},
    {re: /\breadFile(?:Sync)?\(\s*(['"`])([^'"`\n]+)\1/g, construct: 'readFile', kind: 'file'},
    {
        re: /\bcreateReadStream\(\s*(['"`])([^'"`\n]+)\1/g,
        construct: 'createReadStream',
        kind: 'file'
    },
    {re: /\bsendFile\(\s*(['"`])([^'"`\n]+)\1/g, construct: 'sendFile', kind: 'file'},
    {
        re: /\bserveStatic\(\s*\{[^}]*?\broot:\s*(['"`])([^'"`\n]+)\1/g,
        construct: 'serveStatic root',
        kind: 'dir'
    },
    {
        re: /\b(?:express|app)\.static\(\s*(['"`])([^'"`\n]+)\1/g,
        construct: 'express.static root',
        kind: 'dir'
    }
]

// Local-asset references in HTML: script/link/img only — an <a href> is a route,
// not a file the server must materialize.
const HTML_PATTERNS: Pattern[] = [
    {re: /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi, construct: 'script src', kind: 'file'},
    {re: /<link\b[^>]*\bhref\s*=\s*(['"])([^'"]+)\1/gi, construct: 'link href', kind: 'file'},
    {re: /<img\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi, construct: 'img src', kind: 'file'}
]

/** Extract runtime refs from one JS/TS source. */
export function extractJsRefs(source: string, referencer: string): RuntimeRef[] {
    const src = stripCommentLines(source)
    const out: RuntimeRef[] = []
    for (const {re, construct, kind} of JS_READ_PATTERNS) {
        re.lastIndex = 0
        for (let m = re.exec(src); m !== null; m = re.exec(src)) {
            const p = normalizeRefPath(m[2])
            if (p === null) continue
            if (kind === 'file' && !hasExt(p)) continue // route-/name-shaped, not a file
            out.push({path: p, referencer, construct, kind})
        }
    }
    return out
}

/** Extract local-asset refs from one HTML source. */
export function extractHtmlRefs(source: string, referencer: string): RuntimeRef[] {
    const out: RuntimeRef[] = []
    for (const {re, construct, kind} of HTML_PATTERNS) {
        re.lastIndex = 0
        for (let m = re.exec(source); m !== null; m = re.exec(source)) {
            const p = normalizeRefPath(m[2])
            if (p === null) continue
            if (!hasExt(p)) continue // extension-less href/src = route or directory
            out.push({path: p, referencer, construct, kind})
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// GENERATED HTML.
//
// Without this pass there is a way to "fix" a dangle by moving it one
// indirection deeper. The extractor scans HTML FILES and JS READS; it does not
// see the HTML a source GENERATES. So a build script can satisfy a missing
// `dist/index.html` by writing one from a template literal — and that page can
// point at an asset the production build never emits, which nothing then checks.
//
// Scope discipline, the reason this does not become an FP machine: a literal is
// scanned ONLY when it reaches a write whose destination is an HTML file inside a
// directory a BUILD TOOL declared as its output (`prod.outdirs`). Both halves
// were run. The same `Bun.write("dist/index.html", …)` source yields refs when
// `dist` is a declared outdir and NOTHING when it is not; a write into `report/`
// — enumerable, but never an outdir — yields nothing either. An email-body
// template that is only exported, never written, is not collected at all,
// `<img src="cid:logo">` and all.
// ---------------------------------------------------------------------------

/** Asset attributes scanned in GENERATED HTML: everything HTML_PATTERNS matches,
 *  plus `<source>`, `<video>` and `<audio>` src. On-disk `.html` files keep using
 *  the narrower HTML_PATTERNS — confirmed, a `<video src>` in a real HTML file
 *  extracts nothing. */
const GENERATED_HTML_PATTERNS: Pattern[] = [
    ...HTML_PATTERNS,
    {
        re: /<(?:source|video|audio)\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/gi,
        construct: 'media src',
        kind: 'file'
    }
]

/** One HTML document a source writes into a build output. */
export interface EmittedHtml {
    /** Repo-relative path written to (`dist/index.html`). */
    docPath: string
    /** The literal's raw text. */
    html: string
}

/** Read a quoted/template literal starting at `i` (src[i] is the quote char).
 *  Returns the body and the index just past the closing quote, or null when
 *  unterminated. Escapes are honoured; a `${…}` hole is left in the text, where
 *  normalizeRefPath rejects it. */
function readLiteral(src: string, i: number): {text: string; end: number} | null {
    const q = src[i]
    if (q !== '"' && q !== "'" && q !== '`') return null
    let out = ''
    for (let j = i + 1; j < src.length; j++) {
        const c = src[j]
        if (c === '\\') {
            out += src[j + 1] ?? ''
            j++
            continue
        }
        if (c === q) return {text: out, end: j + 1}
        if (c === '\n' && q !== '`') return null // unterminated single-line literal
        out += c
    }
    return null
}

/** `const NAME = <literal>` bindings (also let/var). The shape this exists for is
 *  a build script holding its page in a variable — `const html = \`…\`` followed by
 *  `Bun.write('dist/index.html', html)` — where the literal and the write are not
 *  the same expression. */
function literalBindings(src: string): Map<string, string> {
    const out = new Map<string, string>()
    const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?=['"`])/g
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const lit = readLiteral(src, m.index + m[0].length)
        if (lit === null) continue
        out.set(m[1], lit.text)
        re.lastIndex = lit.end
    }
    return out
}

/** HTML documents this source writes: `Bun.write('x.html', <literal|ident>)` and
 *  the writeFile family. Only literal destinations, only HTML extensions. */
export function collectEmittedHtml(source: string): EmittedHtml[] {
    const src = stripCommentLines(source)
    const bindings = literalBindings(src)
    const out: EmittedHtml[] = []
    const writeRe =
        /\b(?:Bun\.write|writeFileSync|writeFile|fs\.promises\.writeFile)\(\s*(['"`])([^'"`\n]+)\1\s*,\s*/g
    for (let m = writeRe.exec(src); m !== null; m = writeRe.exec(src)) {
        const docPath = normalizeRefPath(m[2])
        if (docPath === null || !SOURCE_HTML_RE.test(docPath)) continue
        const at = m.index + m[0].length
        let html: string | undefined
        const lit = readLiteral(src, at)
        if (lit !== null) html = lit.text
        else {
            const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(at, at + 80))
            if (id) html = bindings.get(id[0])
        }
        if (html === undefined || !html.includes('<')) continue
        out.push({docPath, html})
    }
    return out
}

/** The narrowest build outdir containing `p`, or null when no build tool
 *  declared one that covers it. */
function containingOutdir(p: string, prod: ProducedOutputs): string | null {
    let best: string | null = null
    for (const d of prod.outdirs) {
        if (!underDir(p, d)) continue
        if (best === null || d.length > best.length) best = d
    }
    return best
}

/**
 * Asset references inside HTML this source GENERATES into a build output.
 *
 * Resolution, deterministic:
 *  • root-relative (`/app.css`) resolves against the build OUTDIR the document
 *    lands in (`dist/index.html` ⇒ `dist/`) — that dir is the server's static
 *    root by construction;
 *  • document-relative (`app.css`, `./assets/x.js`) resolves against the
 *    document's own directory;
 *  • schemes (`https:`, `data:`, `cid:`), protocol-relative `//host/x`, and bare
 *    `#fragment`s are dropped by normalizeRefPath;
 *  • a literal not written into a declared build outdir is never scanned at all.
 */
export function extractGeneratedHtmlRefs(
    source: string,
    referencer: string,
    prod: ProducedOutputs
): RuntimeRef[] {
    const out: RuntimeRef[] = []
    const seen = new Set<string>()
    for (const {docPath, html} of collectEmittedHtml(source)) {
        const outdir = containingOutdir(docPath, prod)
        if (outdir === null) continue // not a build artifact — out of scope
        const docDir = path.posix.dirname(docPath)
        for (const {re, construct, kind} of GENERATED_HTML_PATTERNS) {
            re.lastIndex = 0
            for (let m = re.exec(html); m !== null; m = re.exec(html)) {
                const raw = m[2]
                const rootRelative = /^\/(?!\/)/.test(raw.trim())
                const p = normalizeRefPath(raw)
                if (p === null || !hasExt(p)) continue
                const base = rootRelative ? outdir : docDir
                const resolved = path.posix.normalize(base === '.' ? p : `${base}/${p}`)
                if (resolved.startsWith('..')) continue
                if (seen.has(resolved)) continue
                seen.add(resolved)
                out.push({
                    path: resolved,
                    referencer,
                    construct: `${construct} in generated ${docPath}`,
                    kind
                })
            }
        }
    }
    return out
}

/** A path-shaped shell token: contains a separator or an extension, no shell
 *  metacharacters, not a flag. */
function isPathToken(t: string): boolean {
    if (t.startsWith('-') || t.length === 0 || t.length > 200) return false
    if (/["'`$(){}<>|;&*?[\]]/.test(t)) return false
    return t.includes('/') || hasExt(t)
}

/** Script entrypoints: `bun x.ts`, `bun run x.ts`, `node x.js`, `tsx x.ts` —
 *  the first path-shaped source arg of a runner command. */
export function extractScriptEntrypoints(body: string, referencer: string): RuntimeRef[] {
    const out: RuntimeRef[] = []
    for (const cmd of splitShellCommands(body)) {
        const toks = cmd.trim().split(/\s+/)
        let i = 0
        if (['bun', 'bunx', 'node', 'tsx', 'deno'].includes(toks[i] ?? '')) {
            i++
            if (toks[i] === 'run') i++
            while (toks[i]?.startsWith('-')) i++
            const cand = toks[i]
            if (cand !== undefined && isPathToken(cand) && /\.(?:ts|tsx|js|mjs|cjs)$/.test(cand)) {
                const p = normalizeRefPath(cand)
                if (p !== null)
                    out.push({path: p, referencer, construct: 'script entrypoint', kind: 'file'})
            }
        }
    }
    return out
}

/** Split a package.json script body into individual commands (`&&`, `||`, `;`,
 *  `|`, background `&`, newlines). */
function splitShellCommands(body: string): string[] {
    return body
        .split(/&&|\|\||[;|&]|\n/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
}

function addEnumerable(prod: ProducedOutputs, dir: string, stems: Iterable<string>): void {
    const d = prod.enumerable.get(dir) ?? new Set<string>()
    for (const s of stems) d.add(s)
    prod.enumerable.set(dir, d)
    prod.dirs.add(dir)
}

function addFile(prod: ProducedOutputs, file: string): void {
    prod.files.add(file)
    const dir = path.posix.dirname(file)
    if (dir !== '.') addEnumerable(prod, dir, [stem(file)])
}

/** Tools that never materialize project files on their own — their leftover path
 *  args must not escalate a directory to opaque. */
const KNOWN_NON_PRODUCING_RE =
    /^(?:prettier|eslint|tsc|bun|bunx|npx|node|tsx|deno|jest|vitest|mocha|playwright|cypress|grep|cat|echo|rm|test|cross-env|env|git|curl|wget|true|false|exit|sleep|kill|mkdir|cp|mv|touch|concurrently|npm-run-all|wait-on)$/

/** Bundlers/compilers whose OUTPUT DIRECTORY is known but whose exact output
 *  file set we cannot enumerate statically — the dir becomes opaque. */
const OPAQUE_TOOL_DIRS: Array<{re: RegExp; dirs: string[]}> = [
    {re: /\bvite\s+build\b|\bvite\b\s*$/, dirs: ['dist']},
    {re: /\bnext\s+build\b/, dirs: ['.next', 'out']},
    {re: /\btsup\b/, dirs: ['dist']},
    {re: /\bwebpack\b/, dirs: ['dist', 'build']},
    {re: /\brollup\b/, dirs: ['dist']},
    {re: /\bparcel\s+build\b/, dirs: ['dist']},
    {re: /\breact-scripts\s+build\b/, dirs: ['build']},
    {re: /\bng\s+build\b/, dirs: ['dist']},
    {re: /\bastro\s+build\b/, dirs: ['dist']},
    {re: /\bnuxt\s+(?:build|generate)\b/, dirs: ['.output', 'dist']}
]

/**
 * Producer facts from ONE shell command: output flags (`-o x`, `--outfile x`,
 * `--outdir d`), redirects, `cp`/`mv`/`touch` destinations, `mkdir` dirs, known
 * opaque bundlers. Leftover path tokens of an UNRECOGNIZED command escalate any
 * directory they point into to opaque — that command may produce there, and
 * inconclusive is never evidence. `escalate: false` disables that escalation
 * for command text embedded in PROSE (a markdown bullet's surrounding words
 * tokenize as junk "commands" and would opaque half the spec's paths).
 */
export function collectProducersFromCommand(
    cmd: string,
    prod: ProducedOutputs,
    opts: {escalate?: boolean} = {}
): void {
    let rest = cmd.replace(/2>&1|&>\s*\S+|2>\s*\S+/g, ' ')
    for (const {re, dirs} of OPAQUE_TOOL_DIRS) {
        if (re.test(rest))
            for (const d of dirs) {
                prod.opaque.add(d)
                prod.outdirs.add(d)
            }
    }
    // Redirect target.
    rest = rest.replace(/>>?\s*([^\s&|;]+)/g, (_, f: string) => {
        const p = normalizeRefPath(f)
        if (p !== null && p !== 'dev/null') addFile(prod, p)
        return ' '
    })
    // Explicit output flags. --outdir/--out-dir is always a dir; -o/--output/
    // --outfile decide by extension (tailwind -o dist/app.css vs esbuild -o dir).
    const flagRe = /(?:^|\s)(--out(?:file|put|dir|-dir)?|-o)(?:=|\s+)([^\s&|;]+)/g
    const sourceArgs: string[] = []
    rest = rest.replace(flagRe, (_, flag: string, val: string) => {
        const p = normalizeRefPath(val)
        if (p === null) return ' '
        if (flag === '--outdir' || flag === '--out-dir') {
            addEnumerable(prod, p, [])
            prod.outdirs.add(p)
        } else if (hasExt(p)) addFile(prod, p)
        else {
            addEnumerable(prod, p, [])
            prod.outdirs.add(p)
        }
        return ' '
    })
    const toks = rest.trim().split(/\s+/)
    const bin = (toks[0] ?? '').replace(/^.*\//, '')
    if (bin === 'mkdir') {
        for (const t of toks.slice(1)) {
            const p = t.startsWith('-') ? null : normalizeRefPath(t)
            if (p !== null) prod.dirs.add(p)
        }
        return
    }
    if (bin === 'cp' || bin === 'mv') {
        const args = toks.slice(1).filter(t => !t.startsWith('-'))
        const dest = args[args.length - 1]
        const p = dest !== undefined ? normalizeRefPath(dest) : null
        if (p !== null && args.length >= 2) {
            if (hasExt(p)) addFile(prod, p)
            else prod.opaque.add(p) // dir dest: contents unenumerable
        }
        return
    }
    if (bin === 'touch') {
        for (const t of toks.slice(1)) {
            const p = t.startsWith('-') ? null : normalizeRefPath(t)
            if (p !== null) addFile(prod, p)
        }
        return
    }
    // Source-shaped args (a bundler's entrypoints) contribute stems to any
    // outdir this same command declared.
    for (const t of toks.slice(1)) {
        if (isPathToken(t) && /\.(?:ts|tsx|js|jsx|mjs|cjs|css|html)$/.test(t)) {
            const p = normalizeRefPath(t)
            if (p !== null) sourceArgs.push(p)
        }
    }
    // (flagRe already consumed outdirs; attribute stems to dirs declared here.)
    // Re-scan the ORIGINAL command for the outdirs it declared:
    const declaredDirs: string[] = []
    const dirFlagRe = /(?:^|\s)--out(?:dir|-dir)(?:=|\s+)([^\s&|;]+)/g
    for (let m = dirFlagRe.exec(cmd); m !== null; m = dirFlagRe.exec(cmd)) {
        const p = normalizeRefPath(m[1])
        if (p !== null) declaredDirs.push(p)
    }
    for (const d of declaredDirs) {
        addEnumerable(prod, d, sourceArgs.map(stem))
        prod.outdirs.add(d)
    }
    // Unrecognized command: any leftover path token pointing INTO a directory
    // makes that directory opaque — the tool may generate arbitrary files there.
    if ((opts.escalate ?? true) && !KNOWN_NON_PRODUCING_RE.test(bin) && !/^@/.test(bin)) {
        for (const t of toks.slice(1)) {
            if (!isPathToken(t)) continue
            const p = normalizeRefPath(t)
            if (p === null) continue
            const dir = hasExt(p) ? path.posix.dirname(p) : p
            if (dir !== '.') prod.opaque.add(dir)
        }
    }
}

/**
 * Producer facts from JS/TS source: write-side calls (`Bun.write`,
 * `writeFile(Sync)`, `createWriteStream`, `copyFile` dest, `mkdir(Sync)`),
 * `Bun.build({entrypoints, outdir})` (enumerable — unless a `naming` option
 * makes the output names underivable, then opaque), `outfile:`, and `Bun.spawn`
 * argv arrays re-fed through the shell-command collector, for the build-script
 * shape where a tool's `-o dist/app.css` lives inside a spawn array rather than
 * in package.json. All four run as described: entrypoints give
 * `dist{a,b}`, adding `naming` turns `dist` opaque and drops the stems, the spawn
 * array yields `dist/app.css`, and `outfile:` yields its exact file.
 */
export function collectProducersFromSource(source: string, prod: ProducedOutputs): void {
    const src = stripCommentLines(source)
    const litRe = (call: string): RegExp =>
        new RegExp(String.raw`\b${call}\(\s*(['"\`])([^'"\`\n]+)\1`, 'g')
    for (const call of [
        'Bun\\.write',
        'writeFile(?:Sync)?',
        'appendFile(?:Sync)?',
        'createWriteStream'
    ]) {
        const re = litRe(call)
        for (let m = re.exec(src); m !== null; m = re.exec(src)) {
            const p = normalizeRefPath(m[2])
            if (p !== null && hasExt(p)) addFile(prod, p)
        }
    }
    const cpRe = /\bcopyFile(?:Sync)?\(\s*[^,()]+,\s*(['"`])([^'"`\n]+)\1/g
    for (let m = cpRe.exec(src); m !== null; m = cpRe.exec(src)) {
        const p = normalizeRefPath(m[2])
        if (p !== null) addFile(prod, p)
    }
    const mkRe = /\bmkdir(?:Sync)?\(\s*(['"`])([^'"`\n]+)\1/g
    for (let m = mkRe.exec(src); m !== null; m = mkRe.exec(src)) {
        const p = normalizeRefPath(m[2])
        if (p !== null) prod.dirs.add(p)
    }
    // Bun.build blocks: pair each `outdir` with the `entrypoints` in the same
    // options object (nearest preceding within the call's brace span — a simple
    // window keeps this robust to formatting without a real parser).
    const buildRe = /Bun\.build\(\s*\{([\s\S]{0,2000}?)\}\s*\)/g
    for (let m = buildRe.exec(src); m !== null; m = buildRe.exec(src)) {
        const body = m[1]
        const outdirM = /\boutdir:\s*(['"`])([^'"`\n]+)\1/.exec(body)
        const outfileM = /\boutfile:\s*(['"`])([^'"`\n]+)\1/.exec(body)
        if (outfileM) {
            const p = normalizeRefPath(outfileM[2])
            if (p !== null) addFile(prod, p)
        }
        if (!outdirM) continue
        const dir = normalizeRefPath(outdirM[2])
        if (dir === null) continue
        prod.outdirs.add(dir)
        if (/\bnaming:/.test(body)) {
            prod.opaque.add(dir) // custom naming — outputs underivable
            continue
        }
        const entryM = /\bentrypoints:\s*\[([^\]]*)\]/.exec(body)
        const entries: string[] = []
        if (entryM) {
            const lit = /(['"`])([^'"`\n]+)\1/g
            for (let em = lit.exec(entryM[1]); em !== null; em = lit.exec(entryM[1])) {
                const p = normalizeRefPath(em[2])
                if (p !== null) entries.push(p)
            }
        }
        if (entries.length === 0 && entryM === null) {
            prod.opaque.add(dir) // dynamic entrypoints — cannot enumerate
        } else {
            addEnumerable(prod, dir, entries.map(stem))
        }
    }
    // Bun.spawn / spawnSync argv arrays → re-parse as a shell command.
    const spawnRe = /\bspawn(?:Sync)?\(\s*\[([^\]]*)\]/gi
    for (let m = spawnRe.exec(src); m !== null; m = spawnRe.exec(src)) {
        const lit = /(['"`])([^'"`\n]*)\1/g
        const argv: string[] = []
        for (let am = lit.exec(m[1]); am !== null; am = lit.exec(m[1])) argv.push(am[2])
        if (argv.length > 0) collectProducersFromCommand(argv.join(' '), prod)
    }
}

/** Best-effort `outDir` from tsconfig-family files (JSONC-tolerant). tsc mirrors
 *  arbitrary source names into it, so it is always OPAQUE. */
function collectTsconfigOutDirs(cwd: string, prod: ProducedOutputs): void {
    let names: string[]
    try {
        names = readdirSync(cwd).filter(n => /^tsconfig(\..+)?\.json$/.test(n))
    } catch {
        return
    }
    for (const n of names) {
        try {
            const m = /"outDir"\s*:\s*"([^"]+)"/.exec(readFileSync(path.join(cwd, n), 'utf8'))
            if (m) {
                const p = normalizeRefPath(m[1])
                if (p !== null) {
                    prod.opaque.add(p)
                    prod.outdirs.add(p)
                }
            }
        } catch {
            // unreadable config — nothing to learn
        }
    }
}

/** vite/astro-style config: `outDir: 'x'` (opaque), plus their default `dist`. */
function collectBundlerConfigOutDirs(cwd: string, prod: ProducedOutputs): void {
    for (const n of [
        'vite.config.ts',
        'vite.config.js',
        'vite.config.mts',
        'vite.config.mjs',
        'astro.config.mjs',
        'astro.config.ts'
    ]) {
        const f = path.join(cwd, n)
        if (!existsSync(f)) continue
        prod.opaque.add('dist')
        prod.outdirs.add('dist')
        try {
            const m = /\boutDir:\s*(['"`])([^'"`\n]+)\1/.exec(readFileSync(f, 'utf8'))
            if (m) {
                const p = normalizeRefPath(m[2])
                if (p !== null) {
                    prod.opaque.add(p)
                    prod.outdirs.add(p)
                }
            }
        } catch {
            // default already recorded
        }
    }
}

/** package.json scripts of `cwd` (empty on any fault). */
function packageScripts(cwd: string): Record<string, string> {
    try {
        const j = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }
        return j.scripts ?? {}
    } catch {
        return {}
    }
}

/**
 * A WATCH/DEV script — one a production build never invokes.
 *
 * The rule this exists for: a file whose ONLY producer is a watch-mode script —
 * `dev:css` running `tailwindcss … -o dist/app.css --watch` — is not produced by
 * a release at all. The gate runs `build`, `test`, `lint`; none of them invokes
 * it, so the shipped page loads no CSS while a naive producer table reports the
 * file "produced". A production artifact closed only by a watch script is
 * dangling by construction.
 *
 * Deterministic, name-or-flag based: a script whose NAME starts with
 * `dev`/`watch` (bare or before `:`/`_`/`-`), or whose BODY carries `--watch`.
 * Run across the edge cases — `development` and `predev` are NOT dev scripts,
 * while a script literally named `build` running `tsc --watch` IS one. And
 * end-to-end: with `excludeDevScripts`, a `dist/app.css` produced only by
 * `dev:css` drops out of the producer table entirely.
 */
export function isDevScript(name: string, body: string): boolean {
    return /^(?:dev|watch)\b|^(?:dev|watch)[:._-]/i.test(name) || /(?:^|\s)--watch\b/.test(body)
}

export interface ProducerOpts {
    /**
     * Drop watch/dev scripts (and the build files reachable only through them)
     * from the producer table — the PRODUCTION view of what a release contains.
     * Off by default: the shipped resolution path is unchanged by this task.
     */
    excludeDevScripts?: boolean
}

/**
 * Discover everything the project's own machinery produces: package.json script
 * bodies, build files those scripts run (plus conventional root build files),
 * tsconfig/vite outDirs.
 */
export function discoverProducers(cwd: string, opts: ProducerOpts = {}): ProducedOutputs {
    const prod = emptyProducers()
    const all = packageScripts(cwd)
    const scripts =
        opts.excludeDevScripts === true ?
            Object.fromEntries(Object.entries(all).filter(([n, b]) => !isDevScript(n, b)))
        :   all
    const buildFiles = new Set<string>(
        ['build.ts', 'build.js', 'build.mjs'].filter(f => existsSync(path.join(cwd, f)))
    )
    for (const body of Object.values(scripts)) {
        for (const cmd of splitShellCommands(body)) {
            collectProducersFromCommand(cmd, prod)
            // A script that runs a local JS/TS file may produce through it —
            // parse that file's source too, for the `bun build.ts` shape where
            // the real output flags live inside the script, not the command.
            for (const t of cmd.split(/\s+/)) {
                if (isPathToken(t) && /\.(?:ts|js|mjs|cjs)$/.test(t)) {
                    const p = normalizeRefPath(t)
                    if (p !== null && existsSync(path.join(cwd, p))) buildFiles.add(p)
                }
            }
        }
    }
    for (const f of buildFiles) {
        try {
            collectProducersFromSource(readFileSync(path.join(cwd, f), 'utf8'), prod)
        } catch {
            // unreadable build file: its outdirs stay whatever the scripts said
        }
    }
    collectTsconfigOutDirs(cwd, prod)
    collectBundlerConfigOutDirs(cwd, prod)
    return prod
}

const underDir = (p: string, dir: string): boolean => p === dir || p.startsWith(dir + '/')

/** Is a FILE path positively produced — named exactly, under an opaque dir, or
 *  an enumerated stem of an enumerable outdir? */
function fileProduced(c: string, prod: ProducedOutputs): boolean {
    if (prod.files.has(c)) return true
    if ([...prod.opaque].some(d => underDir(c, d))) return true
    for (const [dir, stems] of prod.enumerable) {
        if (underDir(path.posix.dirname(c), dir) && stems.has(stem(c))) return true
    }
    return false
}

/**
 * Resolve refs against existence + producers. DANGLING requires POSITIVE
 * evidence (see the module doc): the ref sits under an ENUMERATED output dir
 * and is not among its outputs, or is a missing source-only-extension file
 * (nothing ever builds a `.ts`/`.tsx`). Everything inconclusive steps aside.
 */
export function resolveDanglingRefs(
    refs: RuntimeRef[],
    prod: ProducedOutputs,
    exists: (rel: string) => boolean
): DanglingRef[] {
    const out: DanglingRef[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
        const p = ref.path
        // Candidate bases: repo root and the referencing file's directory (a JS
        // relative read may resolve from either at runtime; HTML relative src
        // resolves from its own dir). Satisfied under ANY plausible base.
        const bases = ['']
        const refDir = path.posix.dirname(ref.referencer.replace(/\\/g, '/'))
        if (
            refDir !== '.'
            && !ref.referencer.startsWith('package.json')
            && ref.referencer !== 'spec'
        ) {
            bases.push(refDir)
        }
        const candidates = bases
            .map(b => path.posix.normalize(b === '' ? p : `${b}/${p}`))
            .filter(c => !c.startsWith('..'))
        if (candidates.length === 0) continue // escapes the repo — cannot ground
        if (candidates.some(c => exists(c))) continue
        if (ref.kind === 'dir') {
            const satisfied = candidates.some(
                c =>
                    prod.dirs.has(c)
                    || prod.opaque.has(c)
                    || prod.enumerable.has(c)
                    || [...prod.files].some(f => underDir(f, c))
                    || [...prod.opaque].some(d => underDir(c, d))
            )
            if (satisfied) continue
            // A static root that neither exists nor is produced is only flagged
            // when the project HAS producer machinery at all — a bare repo with
            // no scripts yields no evidence either way.
            if (prod.dirs.size + prod.enumerable.size + prod.opaque.size + prod.files.size === 0) {
                continue
            }
            push(ref, `directory does not exist and no script or build step creates it`)
            continue
        }
        const isSatisfied = candidates.some(c => fileProduced(c, prod))
        if (isSatisfied) continue
        // Positive-evidence branches:
        const underEnumerable = candidates.some(c =>
            [...prod.enumerable.keys()].some(d => underDir(path.posix.dirname(c), d))
        )
        if (underEnumerable) {
            push(ref, 'it sits in a build output directory whose parsed outputs do not include it')
            continue
        }
        if (SOURCE_ONLY_EXT_RE.test(p) && ref.construct === 'script entrypoint') {
            push(ref, 'the script entrypoint file does not exist and nothing generates sources')
        }
        // Everything else: inconclusive — step aside.
    }
    return out

    function push(ref: RuntimeRef, reason: string): void {
        const key = `${ref.referencer} ${ref.path}`
        if (seen.has(key)) return
        seen.add(key)
        out.push({...ref, reason})
    }
}

// The tree walk, the caps and the skip sets live in task/shipped-source.ts —
// this was serve-entry's walker written a second time, and the two skip sets had
// drifted: `bench`/`benchmarks` and `*.bench.*` were skipped there and scanned
// here, so a dangling reference in a benchmark was a run-level finding while the
// same file was invisible to the sibling scan.
//
// `producedDirs` stays this scan's own: bundled output re-referencing its own
// chunks is noise, and which dirs are produced is discovered per run.
function scanCandidates(cwd: string, prod: ProducedOutputs): string[] {
    const producedRoots = new Set(
        [...prod.dirs, ...prod.opaque, ...prod.enumerable.keys()].map(d => d.split('/')[0])
    )
    return shippedSources(cwd, {
        ext: new RegExp(`${SOURCE_JS_RE.source}|${SOURCE_HTML_RE.source}`, 'i'),
        excludeRoots: producedRoots
    })
}

/**
 * FINAL-GATE seam: scan the shipped tree for dangling runtime references.
 * Deterministic, read-only, best-effort (throws nothing in normal operation;
 * callers still guard). Producers are discovered first (scripts + build files +
 * configs), then every authored source contributes refs AND runtime write-side
 * producers (an app that writes its own cache file satisfies its own read).
 */
export function findDanglingArtifacts(cwd: string): DanglingRef[] {
    const prod = discoverProducers(cwd)
    // Second, PRODUCTION-only table: identical machinery minus watch/dev scripts.
    // Generated-HTML refs resolve against this one, so a file whose only producer
    // is a `--watch` script does not close a reference the built page makes.
    // Everything else keeps resolving against the full table, so widening the
    // production view cannot move an existing finding.
    const prodProduction = discoverProducers(cwd, {excludeDevScripts: true})
    const refs: RuntimeRef[] = []
    const sources: Array<{rel: string; src: string}> = []
    for (const rel of scanCandidates(cwd, prod)) {
        let src: string
        try {
            src = readFileSync(path.join(cwd, rel), 'utf8')
        } catch {
            continue
        }
        if (SOURCE_HTML_RE.test(rel)) {
            refs.push(...extractHtmlRefs(src, rel))
        } else {
            refs.push(...extractJsRefs(src, rel))
            collectProducersFromSource(src, prod)
            collectProducersFromSource(src, prodProduction)
            sources.push({rel, src})
        }
    }
    for (const [name, body] of Object.entries(packageScripts(cwd))) {
        refs.push(...extractScriptEntrypoints(body, `package.json scripts.${name}`))
    }
    const out = resolveDanglingRefs(refs, prod, rel => existsSync(path.join(cwd, rel)))
    // Generated HTML runs in a SECOND pass: whether a literal counts as a build
    // artifact depends on outdirs any source in the tree may have declared, so
    // the producer table has to be complete first.
    const generated: RuntimeRef[] = []
    for (const {rel, src} of sources) {
        generated.push(...extractGeneratedHtmlRefs(src, rel, prodProduction))
    }
    const seen = new Set(out.map(d => `${d.referencer} ${d.path}`))
    for (const d of resolveDanglingRefs(generated, prodProduction, rel =>
        existsSync(path.join(cwd, rel))
    )) {
        if (seen.has(`${d.referencer} ${d.path}`)) continue
        seen.add(`${d.referencer} ${d.path}`)
        out.push(d)
    }
    return out
}

/** How a generated-HTML asset reference resolves — the STEP 0 measurement. */
export type GeneratedHtmlRefClass =
    /** Produced by the production build (or already on disk). */
    | 'produced'
    /** Only a watch/dev script produces it — dangling for a production build. */
    | 'dev-only'
    /** Nothing produces it at all. */
    | 'missing'

/** Classify one generated-HTML ref against both producer tables (STEP 0 / A/B
 *  reporting; the gate itself only needs the dangling verdict). */
export function classifyGeneratedHtmlRef(
    ref: RuntimeRef,
    full: ProducedOutputs,
    production: ProducedOutputs,
    exists: (rel: string) => boolean
): GeneratedHtmlRefClass {
    if (exists(ref.path) || fileProduced(ref.path, production)) return 'produced'
    if (fileProduced(ref.path, full)) return 'dev-only'
    return 'missing'
}

/** STEP 0 / A/B helper: every generated-HTML asset ref in a tree, with the
 *  producer tables it was measured against. Read-only, deterministic. */
export function collectGeneratedHtmlRefs(cwd: string): {
    refs: RuntimeRef[]
    full: ProducedOutputs
    production: ProducedOutputs
} {
    const full = discoverProducers(cwd)
    const production = discoverProducers(cwd, {excludeDevScripts: true})
    const sources: Array<{rel: string; src: string}> = []
    for (const rel of scanCandidates(cwd, full)) {
        if (SOURCE_HTML_RE.test(rel)) continue
        let src: string
        try {
            src = readFileSync(path.join(cwd, rel), 'utf8')
        } catch {
            continue
        }
        collectProducersFromSource(src, full)
        collectProducersFromSource(src, production)
        sources.push({rel, src})
    }
    const refs: RuntimeRef[] = []
    for (const {rel, src} of sources) refs.push(...extractGeneratedHtmlRefs(src, rel, production))
    return {refs, full, production}
}

/** Ranked-failure text for the final gate (names referencer + missing path). */
export function danglingGateFailureText(d: DanglingRef): string {
    return (
        `dangling artifact: \`${d.referencer}\` references \`${d.path}\` (${d.construct}) `
        + `but nothing in the tree, build outputs, or scripts produces it — ${d.reason}`
    )
}

// ---------------------------------------------------------------------------
// Plan-time seam: the SPEC's own snippets and prose referencing artifacts the
// spec never defines — a design document whose behaviour section requires
// serving `index.html` while its file tree and build section never produce it.
// ---------------------------------------------------------------------------

/** Does the spec LIST the file as its own artifact — a file-tree entry or a
 *  bullet whose first token is (or ends with) the basename? Prose that merely
 *  mentions the name mid-sentence ("serves the built index.html") does NOT
 *  count: that is the CONSUMING side, exactly what must not self-satisfy. */
export function specListsFile(spec: string, refPath: string): boolean {
    const base = path.posix.basename(refPath).toLowerCase()
    for (const line of spec.split('\n')) {
        const cleaned = line
            .replace(/[│├└─┬┼]/g, ' ')
            .replace(/^[\s*+-]+/, '')
            .replace(/[`'"]/g, '')
            .trim()
        const tok = (cleaned.split(/\s+/)[0] ?? '').toLowerCase()
        if (tok === base || tok.endsWith('/' + base)) return true
    }
    return false
}

/** Consuming-side prose verbs: a spec sentence that SERVES/READS/LOADS a
 *  backticked file is referencing it at runtime — the shape being a line like
 *  "**SPA fallback:** non-`/api` GETs serve the built `index.html`." */
const PROSE_CONSUME_RE = /\b(?:serves?|serving|served|fallback|reads?|loads?|renders?)\b/i
/** Runtime-artifact extensions the prose channel accepts. Prose is the loosest
 *  signal, so the list is a tight whitelist rather than a blocklist: a backticked
 *  dotted identifier must never read as a file, and neither must a doc file a
 *  spec tells the READER to open. Run on a consuming-verb line, `c.var.user`,
 *  `Bun.password.hash`, `foo.bar` and `README.md` all extract nothing, while
 *  `index.html`, `data/seed.json` and `assets/logo.svg` all extract.
 *  Code-construct refs are not subject to this list. */
const PROSE_ASSET_EXT_RE =
    /\.(?:html?|css|m?js|cjs|json|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf|wasm|webmanifest|xml|csv|sql|ya?ml|toml|pdf|mp[34]|db|sqlite)$/i

/** Backticked, asset-extension, path-shaped tokens on consuming-verb lines. */
export function extractSpecProseRefs(spec: string): RuntimeRef[] {
    const out: RuntimeRef[] = []
    for (const line of spec.split('\n')) {
        if (!PROSE_CONSUME_RE.test(line)) continue
        const tick = /`([^`\n]+)`/g
        for (let m = tick.exec(line); m !== null; m = tick.exec(line)) {
            const tok = m[1]
            if (!/^[\w./-]+$/.test(tok)) continue // code fragments, not paths
            const p = normalizeRefPath(tok)
            if (p === null || !PROSE_ASSET_EXT_RE.test(p)) continue
            out.push({
                path: p,
                referencer: 'spec',
                construct: 'spec prose (serve/read)',
                kind: 'file'
            })
        }
    }
    return out
}

/**
 * PLAN-TIME seam: runtime refs in the spec's snippets AND consuming prose that
 * neither the existing scaffold (`fileExists`), the spec's parsed build
 * outputs, nor its own file tree produce. Each result becomes an UNOWNED
 * coverage area until some task title claims the artifact.
 */
export function findSpecDanglingArtifacts(
    spec: string,
    fileExists: (rel: string) => boolean
): DanglingRef[] {
    const prod = emptyProducers()
    collectProducersFromSource(spec, prod)
    // Shell-looking lines in the spec (build/script snippets) contribute
    // producers too: only lines carrying an output-flag shape, and never
    // markdown blockquotes (`> …` is quoting, not a shell redirect), so prose
    // cannot feed the producer table and mask a real dangle.
    for (const line of spec.split('\n')) {
        if (line.trimStart().startsWith('>')) continue
        if (/(?:^|\s)(?:--out(?:file|put|dir|-dir)?|-o)(?:=|\s)/.test(line)) {
            for (const cmd of splitShellCommands(line)) {
                collectProducersFromCommand(cmd, prod, {escalate: false})
            }
        }
    }
    // package.json-snippet script lines (`"build": "bun build.ts"`) — parse the
    // body for producers.
    const scriptLineRe = /"([A-Za-z0-9:_-]+)"\s*:\s*"([^"\n]+)"/g
    for (let m = scriptLineRe.exec(spec); m !== null; m = scriptLineRe.exec(spec)) {
        const body = m[2]
        if (/^(?:bun|bunx|node|tsx|npm|npx|deno)\b|--out|-o\s/.test(body)) {
            for (const cmd of splitShellCommands(body)) collectProducersFromCommand(cmd, prod)
        }
    }
    // Code-construct refs resolve exactly like tree refs.
    const codeRefs: RuntimeRef[] = [
        ...extractJsRefs(spec, 'spec'),
        ...extractHtmlRefs(spec, 'spec')
    ]
    const dangling = resolveDanglingRefs(codeRefs, prod, fileExists)
    // Prose refs carry no directory, so they resolve by BASENAME against the
    // declared outputs — and dangle ONLY when the spec positively declares an
    // enumerable output set that does not include them (a spec with no
    // parseable build machinery, or any opaque producer, yields no verdict —
    // inconclusive is never evidence).
    const declaredStemCount = [...prod.enumerable.values()].reduce((n, s) => n + s.size, 0)
    const hasOutputEvidence = prod.files.size > 0 || declaredStemCount > 0
    const producedBasenames = new Set([...prod.files].map(f => path.posix.basename(f)))
    const producedStems = new Set([
        ...[...prod.files].map(stem),
        ...[...prod.enumerable.values()].flatMap(s => [...s])
    ])
    const seen = new Set(dangling.map(d => path.posix.basename(d.path)))
    for (const ref of extractSpecProseRefs(spec)) {
        const base = path.posix.basename(ref.path)
        if (seen.has(base)) continue
        if (!hasOutputEvidence || prod.opaque.size > 0) continue
        const satisfied =
            fileExists(ref.path)
            || [...prod.dirs, ...prod.enumerable.keys()].some(d => fileExists(`${d}/${ref.path}`))
            || producedBasenames.has(base)
            || producedStems.has(stem(ref.path))
        if (satisfied) continue
        seen.add(base)
        dangling.push({
            ...ref,
            reason: 'the spec declares its build outputs and none of them is this file'
        })
    }
    // The spec's own file tree / artifact bullets are plan-time producers: a
    // listed file is an artifact some task will create.
    return dangling.filter(d => !specListsFile(spec, d.path))
}

/** Does some task title claim the artifact (by basename or full path)? Titles
 *  are the one plan artifact the model cannot fake ownership INTO — mentioning
 *  the file is the grounded signal a producing task exists. */
export function titlesCoverArtifact(titles: string[], ref: {path: string}): boolean {
    const base = path.posix.basename(ref.path).toLowerCase()
    const full = ref.path.toLowerCase()
    return titles.some(t => {
        const tl = t.toLowerCase()
        return tl.includes(base) || tl.includes(full)
    })
}

/** Coverage-loop `missing` entry for an unowned dangling artifact. */
export function danglingMissingText(d: DanglingRef): string {
    return (
        `dangling runtime artifact \`${d.path}\` — referenced by the spec (${d.construct}) `
        + `but no file tree entry, build output, or task produces it; add a task that `
        + `creates it or makes the build emit it`
    )
}

/** Carried-requirement line when still unowned at coverage exhaustion. */
export function danglingCarryText(d: DanglingRef): string {
    return (
        `runtime artifact \`${d.path}\` is referenced (${d.construct}) but NOTHING creates it — `
        + `whichever task builds the referencing side must also produce this file or wire the `
        + `build to emit it`
    )
}
