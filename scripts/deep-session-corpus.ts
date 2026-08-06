/**
 * deep-session-corpus — record the DeepSessionFacts of nine real browser sessions
 * against one real served app and eight mutations of it.
 *
 *   bun run scripts/deep-session-corpus.ts
 *   → scripts/fixtures/deep-sessions.json   exit 0 ok · 3 setup failure
 *
 * Every entry is a session the REAL driver drove against a REAL server in a
 * throwaway git worktree of ~/hub/mx5 at 348af86 — never a hand-written fact.
 * `expected` is the verdict a gate that reads the request log must reach.
 *
 * The base tree is broken in one specific way: its client is built with
 * `hc('/api')` while every RPC path already starts `/api/…`, so all 33 call sites
 * address `/api/api/…`. The mutations either repair that (`mut-fixed`) or injure
 * the server underneath it, so that the corpus contains a missing route, a wrong
 * method, an SPA catch-all swallowing an XHR, a rejected password and a dead
 * database — the five shapes the verdict has to tell apart.
 *
 * Requires: chromium on PATH, the mx5 dev postgres container, ~/hub/mx5 at 348af86.
 * The corpus database (DEEP_CORPUS_DATABASE_URL) is migrated and seeded here, so it
 * is a throwaway: nothing reads or writes the app's own dev database.
 */
import {spawn} from 'node:child_process'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runDeepRenderCheck, type DeepSessionFacts, type SessionRequest} from '../src/task/deep-render-check'
import {pickFreePort} from '../src/task/final-gate'

const MX5 = path.join(os.homedir(), 'hub', 'mx5')
const BASE_COMMIT = '348af86'
const OUT = path.join(import.meta.dir, 'fixtures', 'deep-sessions.json')
const DB_URL =
    process.env.DEEP_CORPUS_DATABASE_URL
    ?? 'postgres://mx5_dev:mx5_dev_password@localhost:5432/mx5_dscorpus'
const ADMIN_PHONE = '+1234567890'
const ADMIN_PASSWORD = 'corpus-admin-pass'
/** Identical requests beyond this many are dropped from the STORED log — mx5's
 *  marketplace page re-fetches /api/listings in a render loop (~3000 times in six
 *  seconds) and the fixture would otherwise be megabytes of one repeated line. The
 *  counts the verdict reads are stored separately, measured over the WHOLE log. */
const KEEP_PER_CLASS = 5

const die: (why: string) => never = (why: string) => {
    console.error(`SETUP FAILURE: ${why}`)
    process.exit(3)
}

// ── mutations ────────────────────────────────────────────────────────────────

/** Replace the first occurrence of `from`; a missing anchor is a setup failure,
 *  never a silently unmutated tree. */
const edit = (dir: string, rel: string, from: string, to: string): void => {
    const file = path.join(dir, rel)
    const src = readFileSync(file, 'utf8')
    if (!src.includes(from)) die(`anchor not found in ${rel}: ${from}`)
    writeFileSync(file, src.replace(from, to))
}

/** The client's base URL, joined twice in the base tree, joined once here. */
const fixBaseUrl = (dir: string): void =>
    edit(dir, 'src/client/api.ts', "hc<RpcAppType>('/api'", "hc<RpcAppType>('/'")

const unmount = (dir: string, routes: string): void =>
    edit(dir, 'src/server/index.ts', `app.route('/', ${routes})\n`, '')

const deleteCatchAll = (dir: string): void => {
    const file = path.join(dir, 'src/server/index.ts')
    const src = readFileSync(file, 'utf8')
    const start = src.indexOf("app.get('/*'")
    if (start === -1) die('anchor not found in src/server/index.ts: app.get(\'/*\'')
    const end = src.indexOf('\n})\n', start)
    if (end === -1) die('the SPA catch-all block does not end where expected')
    writeFileSync(file, src.slice(0, start) + src.slice(end + 4))
}

interface Entry {
    name: string
    expected: 'pass' | 'fail' | 'skip'
    /** What the mutation is FOR — the shape the verdict has to see. */
    why: string
    patch: (dir: string) => void
    /** Overrides written into the worktree's .env AND the server's environment. */
    env?: Record<string, string>
}

const ENTRIES: Entry[] = [
    {
        name: 'real-run20',
        expected: 'fail',
        why: 'the shipped tree: every client call addresses /api/api/… and 404s',
        patch: () => {}
    },
    {
        name: 'mut-fixed',
        expected: 'pass',
        why: 'the base URL repaired — the healthy control',
        patch: fixBaseUrl
    },
    {
        name: 'mut-badpass',
        expected: 'skip',
        why: 'a password the server REJECTS is a config gap, never an app defect. Built on mut-fixed: on the base tree the login 404s before any credential is read, so this entry could not test a rejection at all',
        patch: fixBaseUrl,
        env: {ADMIN_PASSWORD: 'not-the-seeded-password'}
    },
    {
        name: 'mut-auth-unmounted',
        expected: 'fail',
        why: 'the sign-in route is not mounted',
        patch: dir => unmount(dir, 'authRoutes')
    },
    {
        name: 'mut-auth-wrong-method',
        expected: 'fail',
        why: 'the sign-in path exists for another verb only',
        patch: dir =>
            edit(dir, 'src/server/routes/auth.ts', "authRoutes.post('/login'", "authRoutes.put('/login'")
    },
    {
        name: 'mut-listings-unmounted',
        expected: 'fail',
        why: 'a data route is gone while auth and the catch-all stay',
        patch: dir => unmount(dir, 'listingsRoutes')
    },
    {
        name: 'mut-one-of-eight',
        expected: 'fail',
        why: 'THE decisive entry: sign-in and /api/auth/me are healthy 2xx and only the listings route is gone, so the shipped two-integer rule (attempted>0 && 2xx===0) PASSES it',
        patch: dir => {
            fixBaseUrl(dir)
            unmount(dir, 'listingsRoutes')
        }
    },
    {
        name: 'mut-no-catchall',
        expected: 'fail',
        why: 'the same missing route with nothing to disguise it — the status alone is enough here',
        patch: dir => {
            unmount(dir, 'listingsRoutes')
            deleteCatchAll(dir)
        }
    },
    {
        name: 'mut-db-down',
        expected: 'skip',
        why: 'infrastructure down, not a client defect. Built on mut-fixed for the same reason as mut-badpass',
        patch: fixBaseUrl,
        env: {DATABASE_URL: 'postgres://mx5_dev:mx5_dev_password@localhost:5499/mx5_dscorpus'}
    }
]

// ── worktree / server plumbing ───────────────────────────────────────────────

const git = (...args: string[]): string =>
    execFileSync('git', ['-C', MX5, ...args], {encoding: 'utf8', stdio: 'pipe'})

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const removeWorktree = (dir: string): void => {
    try {
        git('worktree', 'remove', '--force', dir)
    } catch {
        rmSync(dir, {recursive: true, force: true})
        try {
            git('worktree', 'prune')
        } catch {
            // nothing to prune
        }
    }
}

/** Wait until the server answers, or give up. Returns false on give-up. */
const waitForServer = async (url: string, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
        try {
            await fetch(url, {signal: AbortSignal.timeout(2_000)})
            return true
        } catch {
            await sleep(200)
        }
    }
    return false
}

/** Identical entries beyond KEEP_PER_CLASS are dropped; the counts the verdict
 *  reads were computed over the full log before this runs. */
const trim = (log: SessionRequest[]): SessionRequest[] => {
    const seen = new Map<string, number>()
    const out: SessionRequest[] = []
    for (const r of log) {
        const key = `${r.phase}|${r.initiator}|${r.method}|${r.path}|${String(r.status)}|${String(r.mimeType)}|${String(r.failed)}`
        const n = (seen.get(key) ?? 0) + 1
        seen.set(key, n)
        if (n <= KEEP_PER_CLASS) out.push(r)
    }
    return out
}

interface CorpusEntry {
    name: string
    expected: 'pass' | 'fail' | 'skip'
    why: string
    /** What the gate as shipped said about this session, for the record. */
    shippedOutcome: string
    requestsRecorded: number
    requestsStored: number
    facts: DeepSessionFacts
}

async function record(entry: Entry): Promise<CorpusEntry> {
    const dir = path.join('/tmp', `ds-${entry.name}`)
    removeWorktree(dir)
    rmSync(dir, {recursive: true, force: true})
    git('worktree', 'add', '--detach', dir, BASE_COMMIT)
    try {
        symlinkSync(path.join(MX5, 'node_modules'), path.join(dir, 'node_modules'))
        entry.patch(dir)
        const port = await pickFreePort()
        if (port === null) die('no free port')
        const env: Record<string, string> = {
            DATABASE_URL: DB_URL,
            ADMIN_PHONE,
            ADMIN_PASSWORD,
            APP_URL: `http://127.0.0.1:${String(port)}`,
            PORT: String(port),
            ...entry.env
        }
        writeFileSync(
            path.join(dir, '.env'),
            Object.entries(env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n') + '\n'
        )
        try {
            execFileSync('bun', ['run', 'build'], {cwd: dir, encoding: 'utf8', stdio: 'pipe'})
        } catch (e) {
            die(`${entry.name}: bun run build failed — ${e instanceof Error ? e.message : String(e)}`)
        }
        const url = `http://127.0.0.1:${String(port)}/`
        const child = spawn('bun', ['run', 'src/server/index.ts'], {
            cwd: dir,
            env: {...process.env, ...env},
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        })
        let serverLog = ''
        child.stdout?.on('data', d => (serverLog += String(d)))
        child.stderr?.on('data', d => (serverLog += String(d)))
        try {
            if (!(await waitForServer(url, 20_000))) {
                die(`${entry.name}: the server never answered on ${url}\n${serverLog}`)
            }
            const captured: {facts: DeepSessionFacts | null} = {facts: null}
            const outcome = await runDeepRenderCheck(url, dir, {
                onFacts: fx => {
                    captured.facts = fx
                }
            })
            const f = captured.facts
            if (f === null) {
                die(`${entry.name}: the driver never reached a verdict (${JSON.stringify(outcome)})`)
            }
            const full = f.sessionRequests ?? []
            const shipped =
                outcome.outcome === 'skip' ?
                    `skip — ${outcome.note}`
                :   `${outcome.outcome} — ${outcome.detail}`
            console.log(
                `  ${entry.name}: shipped=${outcome.outcome} expected=${entry.expected} `
                + `requests=${String(full.length)}`
            )
            return {
                name: entry.name,
                expected: entry.expected,
                why: entry.why,
                shippedOutcome: shipped,
                requestsRecorded: full.length,
                requestsStored: trim(full).length,
                facts: {...f, sessionRequests: trim(full)}
            }
        } finally {
            try {
                if (child.pid) process.kill(-child.pid, 'SIGKILL')
            } catch {
                // already gone
            }
        }
    } finally {
        removeWorktree(dir)
    }
}

// ── preconditions, then the nine sessions ────────────────────────────────────

if (!existsSync(MX5)) die(`${MX5} does not exist`)
const head = git('rev-parse', 'HEAD').trim()
if (!head.startsWith(BASE_COMMIT)) {
    console.log(`note: ${MX5} HEAD is ${head}; the corpus is built from ${BASE_COMMIT} regardless`)
}

// Migrate and seed the throwaway corpus database from a scratch worktree, so the
// account the probe signs in with is one this script created.
const seedDir = path.join('/tmp', 'ds-seed')
removeWorktree(seedDir)
rmSync(seedDir, {recursive: true, force: true})
git('worktree', 'add', '--detach', seedDir, BASE_COMMIT)
try {
    symlinkSync(path.join(MX5, 'node_modules'), path.join(seedDir, 'node_modules'))
    const dbEnv = {...process.env, DATABASE_URL: DB_URL, ADMIN_PHONE, ADMIN_PASSWORD}
    execFileSync('bun', ['run', 'src/server/migrate.ts'], {cwd: seedDir, env: dbEnv, stdio: 'pipe'})
    execFileSync('bun', ['run', 'src/server/seed.ts'], {cwd: seedDir, env: dbEnv, stdio: 'pipe'})
} catch (e) {
    die(
        `the corpus database (${DB_URL}) could not be migrated and seeded — `
        + `${e instanceof Error ? e.message : String(e)}`
    )
} finally {
    removeWorktree(seedDir)
}

const corpus: CorpusEntry[] = []
for (const entry of ENTRIES) {
    corpus.push(await record(entry))
}
mkdirSync(path.dirname(OUT), {recursive: true})
writeFileSync(OUT, JSON.stringify(corpus, null, 2))
console.log(`\n${String(corpus.length)} entries → ${OUT}`)
process.exit(corpus.length === ENTRIES.length ? 0 : 3)
