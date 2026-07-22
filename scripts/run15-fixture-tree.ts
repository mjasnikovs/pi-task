/**
 * The mx5 run-15 TASK_0027 fixture, shared by the STEP 0 probes that need the real tree.
 *
 * THE TREE. mx5 commit 4b9827d is literally
 *   `chore: checkpoint before "Client API module — typed hono/client hc<AppType> with
 *    fetch hooks"`
 * i.e. the exact state of the working tree at the moment TASK_0027's research ran. It is
 * extracted with `git archive` into a writable copy; ~/hub/mx5 is EVIDENCE and is never
 * written to.
 *
 * Using HEAD instead would be wrong in a way that quietly changes the measurement:
 * src/client/api.ts would already exist, and one of the bullets worker:context emits is
 * precisely that it does NOT. Verified on extraction: 222 files, src/index.ts present,
 * src/client holding exactly components/, index.css, main.tsx — matching run 15's own
 * recorded bullet.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {execFileSync} from 'node:child_process'

const MX5 = path.join(os.homedir(), 'hub', 'mx5')
/** `chore: checkpoint before "Client API module …"` — the pre-TASK_0027 tree. */
export const PRE_TASK_0027 = '4b9827d'

/** The verbatim TASK_0027 refined task, from .pi-tasks/TASK_0027.md. */
export const REFINED_27 = `GOAL
  Create \`src/client/api.ts\` — a client-side API module that instantiates a typed Hono RPC client via \`hc<AppType>\` (importing \`AppType\` from the server's root entry \`src/index.ts\`) and exports thin fetch/mutation hooks wrapping each endpoint defined in the design spec (§5 API). The module must cover all route groups: auth (\`POST /api/auth/login\`, \`POST /api/auth/logout\`, \`GET /api/auth/me\`), invites (\`POST /api/invites\`, \`GET /api/invites/:token\`, \`POST /api/invites/:token/redeem\`), listings (\`GET /api/listings\`, \`GET /api/listings/:id\`, \`POST /api/listings\`, \`PATCH /api/listings/:id\`, \`POST /api/listings/:id/sold\`, \`DELETE /api/listings/:id\`, \`GET /api/listings/:id/contact\`), photos (\`POST /api/listings/:id/photos\`, \`GET /api/photos/:id\`, \`DELETE /api/photos/:id\`), and admin (\`GET /api/admin/users\`, \`POST /api/admin/users/:id/ban\`). Every call must be fully typed end-to-end through \`hc<AppType>\` — no manual types, no \`any\`. The module should export a default \`api\` object (the \`hc\` instance) plus named convenience functions or hooks that React components can import directly.

CONSTRAINTS
  - Import \`AppType\` from \`src/index.ts\` exactly as exported (\`export type AppType = typeof app\`). Do not redefine, rename, or duplicate the type.
  - Use \`hc<AppType>\` from \`hono/client\` to create the typed client. The base URL must be configurable (e.g., via a default of \`/api\` relative path so it works both in dev and production without hardcoding).
  - Every exported call must route through \`hc<AppType>\`. If any endpoint is not fully typed end-to-end, fix the route chaining or \`AppType\` export — do not paper over with manual types or \`any\`.
  - Do not hand-write request/response interfaces. All client types are inferred from \`AppType\` and shared zod schemas in \`src/shared/schema.ts\`.
  - Do not introduce any new server routes, middleware, or schema changes. This step is purely client-side.
  - Preserve all existing files. Do not modify \`src/server/index.ts\`, \`src/index.ts\`, \`package.json\`, \`tsconfig.json\`, \`eslint.config.js\`, or any route file. Only create \`src/client/api.ts\`.
  - Follow the project's TypeScript config: strict, \`noUncheckedIndexedAccess\`, \`verbatimModuleSyntax\`, etc. No \`any\`, no unused imports.
  - Follow Prettier rules: printWidth 120, no semicolons, single quotes, no bracket spacing, \`arrowParens: avoid\`, LF.
  - Do not create tests in this step — testing for the client API module is not specified as part of this task slice (tests land with components/pages in later steps).
  - Do not create or modify any React components, pages, router setup, CSS, or build config. Those belong to steps 28–44.

KNOWN-UNKNOWNS
  - Should the convenience wrappers be plain async functions or React \`useXXX\` hooks (using \`useState\`/\`useEffect\`)? The spec says "fetch hooks" but also mentions small helper functions — which pattern is preferred for this project?
  - Should the \`hc\` base URL default to a relative path (\`/\`) so it auto-resolves against the current origin, or should it read from an env variable (e.g., \`import.meta.env.APP_URL\`)? The design spec references \`APP_URL\` in \`.env\` but doesn't specify how the client consumes it.
  - Should error handling (non-2xx responses) be wrapped in a try/catch with a standardized error shape, or should raw \`hc\` responses propagate as-is for callers to handle?

EXTERNAL-DEPENDENCIES
- Hono RPC client  \`hono/client hc<AppType> typed client guide hono.dev docs/guides/rpc\``

/**
 * Extract the pre-TASK_0027 tree into `<root>/trial-<n>` and seed the task file
 * phaseResearch persists into.
 *
 * `created_at` in the front matter is REQUIRED: parseFrontMatter (task-parsers.ts) returns
 * null without it and readTaskFile then throws "malformed front matter", aborting every
 * rep before the model is reached. Omitting it cost a full 8-rep run.
 */
export function buildPreTask27Tree(root: string, trial: number): string {
    return buildCheckpointTree(root, trial, {
        commit: PRE_TASK_0027,
        taskId: 'TASK_0027',
        title: 'Client API module — typed hono/client hc<AppType> with fetch hooks'
    })
}

/** One run-15 task's pre-implementation state: its checkpoint commit and its task file. */
export interface CheckpointFixture {
    /** mx5 `chore: checkpoint before "<title>"` commit — the tree as that task's research saw it. */
    commit: string
    taskId: string
    title: string
    /**
     * The task's `## raw prompt`, seeded only when a fixture needs it. Run 15's real task
     * files carry `… | spec: @DESIGN/PROJECT.md — otherwise authoritative`, which is the ONLY
     * place the design document's path appears anywhere in the task; anything that resolves
     * @-mentions (readReferencedDocs) needs it. Omitted by default so the fixtures that
     * recorded their baselines without it are byte-identical to what they measured.
     */
    rawPrompt?: string
}

/**
 * Extract a run-15 checkpoint tree into `<root>/trial-<n>` and seed the task file
 * phaseResearch persists into.
 *
 * `created_at` in the front matter is REQUIRED: parseFrontMatter (task-parsers.ts) returns
 * null without it and readTaskFile then throws "malformed front matter", aborting every
 * rep before the model is reached. Omitting it cost a full 8-rep run.
 */
export function buildCheckpointTree(
    root: string,
    trial: number,
    fixture: CheckpointFixture
): string {
    const dir = path.join(root, `trial-${trial}`)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(path.join(dir, '.pi-tasks'), {recursive: true})

    const tar = execFileSync('git', ['archive', '--format=tar', fixture.commit], {
        cwd: MX5,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer'
    })
    execFileSync('tar', ['-x', '-C', dir], {input: tar, maxBuffer: 512 * 1024 * 1024})

    // Read-only view of the real installed tree: the APIS worker's docs lookups need it.
    const nm = path.join(dir, 'node_modules')
    if (!fs.existsSync(nm)) fs.symlinkSync(path.join(MX5, 'node_modules'), nm, 'dir')

    const now = new Date().toISOString()
    fs.writeFileSync(
        path.join(dir, '.pi-tasks', `${fixture.taskId}.md`),
        `---\nid: ${fixture.taskId}\nstate: in_progress\nphase: research\n`
            + `created_at: ${now}\nupdated_at: ${now}\n`
            + `title: ${fixture.title}\n`
            + `---\n\n`
            + (fixture.rawPrompt ? `## raw prompt\n\n${fixture.rawPrompt}\n\n` : '')
            + `## research\n\n`,
        'utf8'
    )
    return dir
}
