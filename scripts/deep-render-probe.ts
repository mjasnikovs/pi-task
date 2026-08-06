/**
 * deep-render-probe — run the authenticated deep-render check against a URL that is
 * ALREADY serving, and print the verdict. Durable, re-runnable, no model time.
 *
 *   bun run scripts/deep-render-probe.ts <url> <projectDir> [--facts <file>]
 *
 * --facts writes the DeepSessionFacts the verdict was made on (including the whole
 * same-origin request log) to <file>, for inspection or for a corpus entry.
 *
 * The projectDir is the tree whose dotenv declares the account (the same lookup the
 * final gate performs). Exit 0 = pass, 1 = fail, 2 = skip — so a RED/GREEN replay
 * can be scripted.
 */
import {writeFileSync} from 'node:fs'
import {
    findLoginCredentials,
    collectProjectEnv,
    runDeepRenderCheck,
    type DeepSessionFacts
} from '../src/task/deep-render-check'

const argv = process.argv.slice(2)
const factsAt = argv.indexOf('--facts')
const factsFile = factsAt === -1 ? null : argv[factsAt + 1]
const [url, projectDir] = argv.filter((_a, i) => i !== factsAt && i !== factsAt + 1)
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
let facts: DeepSessionFacts | null = null
const r = await runDeepRenderCheck(url, projectDir, {
    onFacts: f => {
        facts = f
    }
})
if (factsFile) {
    writeFileSync(factsFile, JSON.stringify(facts, null, 2))
    console.log(`facts written to ${factsFile}`)
}
const elapsed = ((Date.now() - started) / 1000).toFixed(1)
console.log(`${r.outcome.toUpperCase()} in ${elapsed}s — ${r.outcome === 'skip' ? r.note : r.detail}`)
process.exit(r.outcome === 'pass' ? 0 : r.outcome === 'fail' ? 1 : 2)
