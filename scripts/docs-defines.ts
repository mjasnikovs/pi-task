/**
 * DOCS DEFINES — does retrieval return the chunk that DEFINES what was asked?
 *
 * WHY THIS EXISTS. Every quality metric this project had was saturated. Recall
 * read 43/44 across four runs; "the symbol is mentioned" reads 62/62 on every
 * arm of every comparison, because a package's own doc comments name it
 * constantly. Neither can move, so neither can decide anything.
 *
 * This one can. A chunk DEFINES a symbol when its own first declaration head
 * names it — which is exactly what a caller needs and what a mention is not. It
 * chose defect 21 (16/62 -> 34/62 paired, p=1.2e-4), chose the retrieve limit
 * against a sweep, and mechanised defect 22, and it needs no model at all: the
 * whole thing is the index and the recorded queries.
 *
 * IT RE-RETRIEVES, so it inherits every caution `--retrieve` does. Run it in the
 * container against pinned deps, and hold the cache's package set fixed across
 * arms or bm25 crosstalk (defect 17) is what moves the number.
 *
 *   bun scripts/docs-defines.ts <recorded.jsonl...> --project ts=/path/to/ts --out a.jsonl
 *   bun scripts/docs-defines.ts --compare a.jsonl b.jsonl
 */
import fs from 'node:fs'
import path from 'node:path'
import {docsRaw} from '../src/workers/docs-core.js'
import {TRUTH, PROJECTS, type EcosystemId} from './docs-live-truth.js'

/**
 * The first declaration head of a chunk, per ecosystem. Head only: a name that
 * merely appears inside a body is a use, not a definition, and counting those is
 * how the saturated "mentioned" metric behaves.
 *
 * The chunk's own `// path` / `-- path` comment line is skipped first.
 */
const HEAD: Record<EcosystemId, RegExp> = {
    npm: /^(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/,
    cargo: /^(?:#\[[^\n]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+)*(?:fn|struct|enum|union|trait|type|impl|mod|const|static)\s+([A-Za-z_][\w]*)/,
    hackage: /^(?:([a-z_][\w']*)\s*::|(?:data|newtype|type|class)\s+([A-Z][\w']*))/
}

/**
 * A MEMBER is never a top-level head, and two of this suite's own ground-truth
 * symbols are members — `issues` on a ZodError, `json` on a hono Context. Scoring
 * them by the head rule alone read npm at 45% when it is at 93%, which is the
 * kind of number that sends a session hunting a defect that is not there.
 */
function memberDeclaration(symbol: string): RegExp {
    return new RegExp(`^\\s*(?:readonly\\s+)?${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[?:(<]`, 'm')
}

/** Strip the leading `// path` or `-- path` line the indexer prepends. */
function body(chunk: string): string {
    return chunk.replace(/^(?:\/\/|--)[^\n]*\n/, '')
}

export function definesSymbol(
    chunks: readonly {content: string}[],
    ecosystem: EcosystemId,
    symbol: string
): boolean {
    for (const c of chunks) {
        const head = HEAD[ecosystem].exec(body(c.content))
        if (head && (head[1] ?? head[2]) === symbol) return true
        if (memberDeclaration(symbol).test(body(c.content))) return true
    }
    return false
}

export interface DefinesRow {
    source: string
    module: string
    query: string
    symbol: string
    ecosystem: EcosystemId
    chunks: number
    bytes: number
    defines: boolean
    /** The saturated comparison, kept so its saturation stays visible. */
    mentions: boolean
}

interface Options {
    files: string[]
    projects: Record<string, string>
    out: string | null
    compare: [string, string] | null
}

function parseArgs(argv: string[]): Options {
    const opts: Options = {files: [], projects: {}, out: null, compare: null}
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === '--project') {
            const [id, dir] = (argv[++i] ?? '').split('=')
            if (!id || !dir) throw new Error('docs-defines: --project wants id=/path')
            opts.projects[id] = dir
        } else if (a === '--out') opts.out = argv[++i]
        else if (a === '--compare') opts.compare = [argv[++i], argv[++i]]
        else if (a.startsWith('--')) throw new Error(`docs-defines: unknown flag ${a}`)
        else opts.files.push(a)
    }
    return opts
}

/** `<anything>-ts.jsonl` and `ts.jsonl` both name the ts project. */
function projectIdOf(file: string): string {
    const base = path.basename(file)
    const m = /(?:^|[-_])(ts|rs|hs)\.jsonl$/.exec(base)
    return m ? m[1] : 'ts'
}

interface Recorded {
    module?: string
    query?: string
}

async function collect(opts: Options): Promise<DefinesRow[]> {
    // A TruthEntry names its package, not its registry; the pins do. Derived
    // rather than duplicated, so a new pin cannot disagree with a hand-written map.
    const ecosystemOf = new Map<string, EcosystemId>()
    for (const spec of PROJECTS) for (const pkg of Object.keys(spec.pins)) ecosystemOf.set(pkg, spec.ecosystem)
    const byModule = new Map<string, {symbol: string; ecosystem: EcosystemId}[]>()
    for (const t of TRUTH) {
        const eco = ecosystemOf.get(t.pkg)
        if (eco === undefined) continue
        byModule.set(t.pkg, [...(byModule.get(t.pkg) ?? []), {symbol: t.symbol, ecosystem: eco}])
    }
    const rows: DefinesRow[] = []
    for (const file of opts.files) {
        const id = projectIdOf(file)
        const cwd = opts.projects[id]
        if (cwd === undefined) throw new Error(`docs-defines: no --project ${id}=… for ${file}`)
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim()) continue
            let rec: Recorded
            try {
                rec = JSON.parse(line) as Recorded
            } catch {
                continue
            }
            const truths = rec.module === undefined ? undefined : byModule.get(rec.module)
            if (!truths || rec.query === undefined) continue
            const named = truths.filter(t => rec.query!.includes(t.symbol))
            if (named.length === 0) continue
            const res = await docsRaw({
                pkg: rec.module!,
                query: rec.query,
                cwd,
                npmVersionLookup: () => Promise.resolve(null)
            })
            if (res.kind !== 'ok') continue
            const text = res.chunks.map(c => c.content).join('\n')
            for (const t of named) {
                rows.push({
                    source: path.basename(file),
                    module: rec.module!,
                    query: rec.query,
                    symbol: t.symbol,
                    ecosystem: t.ecosystem,
                    chunks: res.chunks.length,
                    bytes: text.length,
                    defines: definesSymbol(res.chunks, t.ecosystem, t.symbol),
                    mentions: new RegExp(`\\b${t.symbol}\\b`).test(text)
                })
            }
        }
    }
    return rows
}

/** Two-sided exact McNemar. The design is paired — the same query in both arms —
 *  and an unpaired test on a paired design has already reported p=0.34 where the
 *  paired one said 0.0019. */
export function mcnemar(onlyA: number, onlyB: number): number {
    const n = onlyA + onlyB
    if (n === 0) return 1
    const choose = (nn: number, k: number): number => {
        let r = 1
        for (let i = 0; i < k; i++) r = (r * (nn - i)) / (i + 1)
        return r
    }
    let tail = 0
    for (let k = 0; k <= Math.min(onlyA, onlyB); k++) tail += choose(n, k)
    return Math.min(1, (2 * tail) / 2 ** n)
}

export function compare(a: DefinesRow[], b: DefinesRow[]): string {
    const key = (r: DefinesRow): string => `${r.source}|${r.module}|${r.query}|${r.symbol}`
    const mb = new Map(b.map(r => [key(r), r]))
    let both = 0
    let onlyA = 0
    let onlyB = 0
    let neither = 0
    for (const ra of a) {
        const rb = mb.get(key(ra))
        if (rb === undefined) continue
        if (ra.defines && rb.defines) both++
        else if (ra.defines) onlyA++
        else if (rb.defines) onlyB++
        else neither++
    }
    const pairs = both + onlyA + onlyB + neither
    return [
        `pairs ${pairs}   both ${both}   only-A ${onlyA}   only-B ${onlyB}   neither ${neither}`,
        `defines  A ${both + onlyA}/${pairs}   B ${both + onlyB}/${pairs}`,
        `McNemar exact, two-sided: p = ${mcnemar(onlyA, onlyB).toExponential(3)}`
    ].join('\n')
}

function render(rows: DefinesRow[]): string {
    const byEco = new Map<string, DefinesRow[]>()
    for (const r of rows) byEco.set(r.ecosystem, [...(byEco.get(r.ecosystem) ?? []), r])
    const out: string[] = []
    for (const [eco, list] of [...byEco].sort()) {
        const d = list.filter(r => r.defines).length
        const m = list.filter(r => r.mentions).length
        out.push(
            `${eco.padEnd(8)} pairs ${String(list.length).padStart(3)}`
                + `   mentioned ${String(m).padStart(3)}   DEFINED ${String(d).padStart(3)}`
                + `  (${((100 * d) / list.length).toFixed(0)}%)`
        )
    }
    const bySym = new Map<string, DefinesRow[]>()
    for (const r of rows) bySym.set(`${r.module}:${r.symbol}`, [...(bySym.get(`${r.module}:${r.symbol}`) ?? []), r])
    out.push('')
    for (const [sym, list] of [...bySym].sort()) {
        out.push(`  ${sym.padEnd(24)} ${list.filter(r => r.defines).length}/${list.length}`)
    }
    return out.join('\n')
}

async function main(): Promise<void> {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.compare) {
        const read = (f: string): DefinesRow[] =>
            fs
                .readFileSync(f, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map(l => JSON.parse(l) as DefinesRow)
        console.log(compare(read(opts.compare[0]), read(opts.compare[1])))
        return
    }
    if (opts.files.length === 0) {
        throw new Error('docs-defines: give at least one recorded .jsonl, or --compare a b')
    }
    const rows = await collect(opts)
    if (opts.out) fs.writeFileSync(opts.out, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    console.log(render(rows))
}

if (import.meta.main) await main()
