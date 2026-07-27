/**
 * deep-render-probe — run the authenticated deep-render check against a URL that is
 * ALREADY serving, and print the verdict. Durable, re-runnable, no model time.
 *
 *   bun run scripts/deep-render-probe.ts <url> <projectDir>
 *
 * The projectDir is the tree whose dotenv declares the account (the same lookup the
 * final gate performs). Exit 0 = pass, 1 = fail, 2 = skip — so a RED/GREEN replay
 * can be scripted.
 */
import {findLoginCredentials, collectProjectEnv, runDeepRenderCheck} from '../src/task/deep-render-check'

const [url, projectDir] = process.argv.slice(2)
if (!url || !projectDir) {
    console.error('usage: bun run scripts/deep-render-probe.ts <url> <projectDir>')
    process.exit(3)
}

const creds = findLoginCredentials(collectProjectEnv(projectDir))
console.log(
    creds ?
        `credentials: ${creds.identifierKey} + ${creds.passwordKey} (values not printed)`
    :   'credentials: NONE declared'
)
const started = Date.now()
const r = await runDeepRenderCheck(url, projectDir)
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`${r.outcome.toUpperCase()} in ${elapsed}s — ${r.outcome === 'skip' ? r.note : r.detail}`)
process.exit(r.outcome === 'pass' ? 0 : r.outcome === 'fail' ? 1 : 2)
