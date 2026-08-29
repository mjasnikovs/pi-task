/**
 * serve-entry — the project builds a server app, expects to SERVE, and nothing in
 * the tree ever starts a listener.
 *
 * THE FAILURE THIS CLOSES. The shipped `src/server/index.ts`
 * is 28 lines that construct a Hono app, mount five `/api` routers, add an SPA
 * fallback reading `Bun.file('dist/index.html')` — and end at `export {app}`. There
 * is no `Bun.serve`, no `export default app`, no `serve()` from an adapter, no
 * `start` script. Running the entry directly exits 0 in milliseconds:
 *
 *     $ DATABASE_URL=… timeout 15 bun run src/server/index.ts   → EXIT=0
 *
 * The product could not be started at all, and the run shipped green: the gate's
 * boot command resolved to a `docker compose up` orchestrator, docker was absent in
 * the sandbox, and the boot SKIPPED. This is the SECOND run to lose this exact
 * clause — a shipped a server that never served the client bundle
 * — so a dynamic-only gate has now
 * failed to catch it twice.
 *
 * WHY STATIC. The check needs no runtime, no browser, no docker, no database and no
 * model: the tree either contains a bind or it does not. It runs in milliseconds and
 * is decidable in exactly the environment where every dynamic probe went blind.
 *
 * FP DISCIPLINE (the standing rule — inconclusive is NEVER evidence). Three
 * independent conditions must ALL hold before anything is reported, and each one
 * steps aside on doubt:
 *   1. a module CONSTRUCTS a server app (a known framework construct, literal);
 *   2. the project is expected to SERVE (a catch-all route, a static/dist read, a
 *      static-file middleware, or a design clause naming a served path);
 *   3. NOTHING anywhere in the scanned tree binds — `Bun.serve(`/`Deno.serve(`,
 *      any `.listen(`, an adapter `serve(` import, `export default <the app>` or
 *      `export default {fetch…}` (the Workers/Bun default-export protocol),
 *      `app.fire()`, or a platform handler export.
 * And a project whose LAUNCHER is somebody else's (next/nuxt/astro/remix/sveltekit/
 * nest/wrangler/vercel/netlify/serverless/…, by dependency or by script) steps aside
 * whole: those frameworks bind inside their own CLI, so their app modules correctly
 * contain no listener and the question is not decidable from this tree.
 *
 * Ground truth is the file tree only. No model, no network.
 */
import {readFileSync} from 'node:fs'
import * as path from 'node:path'
import {shippedSources, stripCommentLines, SOURCE_JS_RE} from './shipped-source.js'

export interface ServeEntryFinding {
    /** Repo-relative module that constructs the app and is the natural home for the bind. */
    file: string
    /** The construct that matched there (`new Hono()`, `express()`, …). */
    construct: string
    /** Why this project is expected to serve, in words. */
    expectation: string
    /** Where that expectation was found (repo-relative file, or 'the design/spec'). */
    expectationSource: string
    /** Every construction file found, for the report. */
    appFiles: string[]
}

/** A server-app construction: framework, and the regex that recognises it. */
const CONSTRUCT_PATTERNS: Array<{re: RegExp; construct: string}> = [
    {re: /\bnew\s+Hono\s*[<(]/, construct: 'new Hono()'},
    {re: /\bnew\s+Elysia\s*[<(]/, construct: 'new Elysia()'},
    {re: /\bnew\s+Koa\s*\(/, construct: 'new Koa()'},
    {re: /\bnew\s+Application\s*\(\s*\)/, construct: 'new Application()'},
    {re: /(?:^|[^.\w])express\s*\(\s*\)/, construct: 'express()'},
    {re: /(?:^|[^.\w])[Ff]astify\s*\(/, construct: 'fastify()'},
    {re: /(?:^|[^.\w])polka\s*\(/, construct: 'polka()'}
    // `connect()` (the middleware framework) is deliberately absent: another project's
    // src/store/db.ts calls `connect()` on a DATABASE, and a construct signal that
    // cannot tell a server from a db handle is not a construct signal.
]

/**
 * Anything that starts (or hands off) a listener. Deliberately GENEROUS: every
 * pattern here SUPPRESSES a finding, so a loose match costs a missed defect while a
 * tight one costs a false accusation — and the standing direction is that a false
 * accusation is the worse failure.
 */
const BIND_PATTERNS: Array<{re: RegExp; what: string}> = [
    {re: /\bBun\s*\.\s*serve\s*\(/, what: 'Bun.serve('},
    {re: /\bDeno\s*\.\s*serve\s*\(/, what: 'Deno.serve('},
    {re: /\.listen\s*\(/, what: '.listen('},
    {re: /\bcreateServer\s*\([^)]*\)\s*\.\s*listen/, what: 'createServer().listen('},
    {re: /\.\s*fire\s*\(\s*\)/, what: 'app.fire()'},
    {re: /\bserveHandler\s*\(|\bstartServer\s*\(/, what: 'a server-start helper'}
]

/** `export default` forms that ARE a bind: the runtime (Bun, Workers, Deno Deploy,
 *  Vercel) starts whatever is exported. A default-exported config object
 *  (`export default defineConfig({…})`) is not one of them, and neither is a React
 *  component — hence the identifier must be a name the tree BOUND to a server-app
 *  construction (aiz-client's `export default App` is a component, not a listener). */
function defaultExportBind(src: string, appNames: Set<string>): string | null {
    for (const m of src.matchAll(/export\s+default\s+([A-Za-z_$][\w$]*)/g)) {
        if (appNames.has(m[1])) return `export default ${m[1]}`
    }
    // `export default {fetch: app.fetch, port}` / `export default {async fetch(…)}` —
    // the Workers/Bun protocol. The `fetch` key must be in the same object literal.
    for (const m of src.matchAll(/export\s+default\s*\{([\s\S]{0,400}?)\}/g)) {
        if (/(?:^|[\s,{])(?:async\s+)?fetch\s*[:(]/.test(m[1])) return 'export default {fetch…}'
    }
    if (/export\s+default\s+(?:handle|serve|createHandler)\s*\(/.test(src)) {
        return 'export default handle(app)'
    }
    return null
}

/** An adapter whose `serve(app)` binds for you (`@hono/node-server`, `srvx`, …). */
function adapterServeBind(src: string): string | null {
    const importsAdapter =
        /from\s+['"](?:@hono\/node-server|srvx|@fastify\/[\w-]+|h3|listhen)['"]/.test(src)
    return importsAdapter && /(?:^|[^.\w])(?:serve|listen)\s*\(/.test(src) ?
            'serve() from a server adapter'
        :   null
}

/** Blank out same-line string literals. Real code never constructs an app inside a
 *  quote, but a module that NAMES the constructs — a detector, a doc, this file's
 *  own `construct: 'new Hono()'` labels — otherwise reads as seven server apps.
 *  Applied to construction matching only: the serve-expectation patterns are ABOUT
 *  string literals (`app.get('*')`, `Bun.file('dist/…')`) and must keep them. */
function stripStringLiterals(src: string): string {
    return src.replace(/'[^'\n]*'|"[^"\n]*"/g, "''")
}

/** Constructions in one source file, plus the variable each was assigned to. */
export function findAppConstructions(raw: string): Array<{construct: string; name: string | null}> {
    const src = stripStringLiterals(raw)
    const out: Array<{construct: string; name: string | null}> = []
    for (const {re, construct} of CONSTRUCT_PATTERNS) {
        if (!re.test(src)) continue
        // `const app = new Hono()` → remember `app`, so `export default app` counts.
        const assign = new RegExp(
            `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=]{0,80})?=\\s*[^=]{0,40}?${re.source}`
        ).exec(src)
        out.push({construct, name: assign ? assign[1] : null})
    }
    return out
}

/** Bind evidence in one source file, or null. */
export function findBindEvidence(src: string, appNames: Set<string> = new Set()): string | null {
    for (const {re, what} of BIND_PATTERNS) {
        if (re.test(src)) return what
    }
    return defaultExportBind(src, appNames) ?? adapterServeBind(src)
}

const SERVE_EXPECTATIONS: Array<{re: RegExp; what: string}> = [
    {
        re: /\.\s*(?:get|all|use|route)\s*\(\s*['"`]\/?\*['"`]/,
        what: 'a catch-all route (the SPA fallback)'
    },
    {
        re: /(?:Bun\s*\.\s*file|readFileSync|readFile|createReadStream|sendFile)\s*\(\s*['"`]\.?\/?(?:dist|build|out|public|static|client|assets)\//,
        what: 'a read of a built asset under dist/ (the client bundle)'
    },
    {re: /\bserveStatic\s*\(/, what: 'static-file middleware (serveStatic)'},
    {re: /\bexpress\s*\.\s*static\s*\(/, what: 'static-file middleware (express.static)'},
    {re: /\bfastifyStatic\b|@fastify\/static/, what: 'static-file middleware (@fastify/static)'}
]

/** Why this file makes the project a SERVING one, or null. */
export function findServeExpectation(src: string): string | null {
    for (const {re, what} of SERVE_EXPECTATIONS) {
        if (re.test(src)) return what
    }
    return null
}

/** A design/spec clause that names a served path — the plan-side half of the same
 *  expectation, e.g. a design that says "serves `/api` + static `dist/`". */
export function planExpectsServing(planText: string | undefined): string | null {
    if (!planText) return null
    const re =
        /\bserves?\b[^\n]{0,120}?\b(?:static|dist\/?|client|bundle|index\.html|spa|frontend)\b/i
    const m = re.exec(planText)
    return m ? `the design declares a served path ("${m[0].trim().slice(0, 100)}")` : null
}

/**
 * Frameworks and platforms that own the listener themselves. When one of these is a
 * dependency or drives a script, an app module with no bind is CORRECT, so the whole
 * check steps aside — it is not decidable from this tree.
 */
const LAUNCHER_DEPS =
    /^(?:next|nuxt|nuxt3|astro|@remix-run\/|@sveltejs\/kit|@nestjs\/core|@angular\/|@adonisjs\/core|redwoodjs|blitz|wrangler|@cloudflare\/|vercel|@vercel\/|netlify-cli|@netlify\/|serverless|serverless-http|firebase-functions|aws-lambda|@aws-sdk\/client-lambda|sst|nitropack|encore\.dev|@medusajs\/|keystone|payload|gatsby|@builder\.io\/qwik-city)/
const LAUNCHER_SCRIPT_RE =
    /\b(?:next|nuxt|astro|remix-serve|nest|wrangler|vercel|netlify|sst|gatsby|blitz|redwood|encore|payload|medusa)\s+(?:dev|start|serve|build\s+&&|run\b)/

/** The platform that would bind on this project's behalf, or null. */
export function opaqueLauncher(cwd: string): string | null {
    let pkg: {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        scripts?: Record<string, string>
    }
    try {
        pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as typeof pkg
    } catch {
        return null
    }
    const deps = Object.keys({...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {})})
    const dep = deps.find(d => LAUNCHER_DEPS.test(d))
    if (dep) return `the \`${dep}\` framework starts its own server`
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
        if (LAUNCHER_SCRIPT_RE.test(body))
            return `\`${name}\` runs a framework launcher (${body.slice(0, 60)})`
    }
    return null
}

// The tree walk, the caps, the skip sets and the comment strip live in
// task/shipped-source.ts — this scan and artifact-closure's were the same walker
// written twice, and their skip sets had drifted apart on `bench`/`benchmarks`.
const scanCandidates = (cwd: string): string[] => shippedSources(cwd, {ext: SOURCE_JS_RE})

/** A `/…/flags` literal whose body carries a regex METACHARACTER — `[`, `\`, `+`,
 *  `?`, `|`, a group. A path string like `'/api/admin'` has none, so it survives. */
const REGEX_LITERAL_RE = /\/(?![*/])((?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+)\/[gimsuyd]*/g
const METACHAR_RE = /[\\[\]+*?^$|(){}]/

/**
 * Blank out regex literals. A project that MATCHES on `new Hono` — a linter, a
 * codemod, this very module — does not construct one, and a source scanner that
 * cannot tell the two apart reports every detector as an app (pi-task scanned
 * itself and found "9 server apps", all of them pattern tables). Only literals
 * carrying a metacharacter are stripped, so `'/api/v1'` is untouched, and because
 * stripping can only REMOVE matches it is safe in the FP direction by construction.
 */
function stripRegexLiterals(src: string): string {
    return src.replace(REGEX_LITERAL_RE, (whole, body: string) =>
        METACHAR_RE.test(body) ? ' ' : whole
    )
}

/** What a whole tree looks like to this check — the base-rate row, and the
 *  intermediate the finding is derived from. */
export interface ServeEntryScan {
    /** Files that construct a server app, with the construct that matched. */
    apps: Array<{file: string; construct: string; name: string | null}>
    /** The first bind found anywhere, with its file. */
    bind: {file: string; what: string} | null
    /** Why the project is expected to serve, with its source. */
    expectation: {source: string; what: string} | null
    /** Non-null ⇒ somebody else's launcher owns the listener; the check stands down. */
    launcher: string | null
    filesScanned: number
}

/** Read the tree once and answer all three questions. Read-only, deterministic. */
export function scanServeEntry(cwd: string, planText?: string): ServeEntryScan {
    const scan: ServeEntryScan = {
        apps: [],
        bind: null,
        expectation: null,
        launcher: opaqueLauncher(cwd),
        filesScanned: 0
    }
    const files = scanCandidates(cwd)
    scan.filesScanned = files.length
    // Two passes: constructions first, so `export default app` can be resolved
    // against the app variable names the tree actually uses.
    const sources = new Map<string, string>()
    const appNames = new Set<string>()
    for (const rel of files) {
        let src: string
        try {
            src = stripRegexLiterals(stripCommentLines(readFileSync(path.join(cwd, rel), 'utf8')))
        } catch {
            continue
        }
        sources.set(rel, src)
        for (const c of findAppConstructions(src)) {
            scan.apps.push({file: rel, construct: c.construct, name: c.name})
            if (c.name) appNames.add(c.name)
        }
    }
    for (const [rel, src] of sources) {
        if (scan.bind === null) {
            const what = findBindEvidence(src, appNames)
            if (what) scan.bind = {file: rel, what}
        }
        if (scan.expectation === null) {
            const what = findServeExpectation(src)
            if (what) scan.expectation = {source: rel, what}
        }
    }
    if (scan.expectation === null) {
        const fromPlan = planExpectsServing(planText)
        if (fromPlan) scan.expectation = {source: 'the design/spec', what: fromPlan}
    }
    return scan
}

/** The construction file that should carry the bind: the one holding the serve
 *  expectation, else the most entry-like name, else the first. */
function entryFile(scan: ServeEntryScan): {file: string; construct: string} {
    const withExpectation = scan.apps.find(a => a.file === scan.expectation?.source)
    if (withExpectation) return withExpectation
    const entryish = scan.apps.find(a => /(?:^|\/)(?:index|main|server|app)\.[a-z]+$/i.test(a.file))
    return entryish ?? scan.apps[0]
}

/**
 * FINAL-GATE seam: does this project build a server app it expects to serve, with
 * nothing anywhere to start it? Returns at most ONE finding — the defect is a
 * property of the whole tree, not of each file. Best-effort and read-only.
 */
export function findMissingServeEntry(cwd: string, planText?: string): ServeEntryFinding | null {
    const scan = scanServeEntry(cwd, planText)
    if (scan.launcher !== null) return null
    if (scan.apps.length === 0) return null
    if (scan.bind !== null) return null
    if (scan.expectation === null) return null
    const {file, construct} = entryFile(scan)
    return {
        file,
        construct,
        expectation: scan.expectation.what,
        expectationSource: scan.expectation.source,
        appFiles: [...new Set(scan.apps.map(a => a.file))]
    }
}

/** Ranked-failure text for the final gate. Names the module that must bind and the
 *  reason the project is a serving one, so the autofix child has both halves. */
export function serveEntryGateFailureText(f: ServeEntryFinding): string {
    return (
        `serve entry missing: \`${f.file}\` builds a server app (${f.construct}) and the project `
        + `is expected to serve — ${f.expectation} in ${f.expectationSource === 'the design/spec' ? 'the design/spec' : `\`${f.expectationSource}\``} — `
        + 'but NOTHING in the tree ever starts a listener (no `Bun.serve(`, `export default app`, '
        + 'adapter `serve()`, or `.listen(`), so the app cannot be started at all'
    )
}
