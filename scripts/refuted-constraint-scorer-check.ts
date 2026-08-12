/**
 * Scorer check for A/B-2's two counts, against the RECORDED run-19 spec — the
 * shipped defect itself, which is the one case no fixture can stand in for.
 *
 * The metric is the whole experiment, and this one was wrong three times before
 * it was right: bare token presence scored a spec that PROHIBITS `argon2` as one
 * that requires it. A metric that cannot tell a requirement from a prohibition
 * would have reported the lever's own success as its failure.
 *
 * The ten hand-built requirement/prohibition shapes moved to
 * `scripts/refuted-constraint-scorer.test.ts` and now run on every `bun test`.
 * This arm stays a script because it needs the mx5 evidence tree.
 *
 * Run: bun run scripts/refuted-constraint-scorer-check.ts
 *   PASS 0 · FAIL 1 · ABSTAIN 2 (mx5 not on this machine)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {forbidsMandatedApi, requiresUnneededDep} from './refuted-constraint-delivered-ab.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')

/**
 * A missing section is a VALUE, not an exception. The previous version asserted
 * the match with `!`, so a spec whose heading did not match raised a TypeError
 * from inside the scorer check — an instrument crash wearing the costume of a
 * scorer failure.
 */
function section(md: string, name: string): string | undefined {
    const m = new RegExp(String.raw`^##\s+${name}\s*$`, 'im').exec(md)
    if (m === null) return undefined
    const rest = md.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

function main(): void {
    const eq = (a: string[], b: string[]): boolean =>
        a.slice().sort().join(',') === b.slice().sort().join(',')

    const recordedPath = path.join(MX5, '.pi-tasks', 'TASK_0001.md')
    if (!fs.existsSync(recordedPath)) {
        console.log(
            `*** ABSTAIN — THIS RUN PROVED NOTHING ***\n`
                + `${recordedPath} is not on this machine, so the scorers were never run\n`
                + `against the recorded defect. The ten hand-built shapes still ran: see\n`
                + `scripts/refuted-constraint-scorer.test.ts (bun test).`
        )
        process.exit(2)
    }

    const spec = section(fs.readFileSync(recordedPath, 'utf8'), 'spec')
    if (spec === undefined) {
        console.log(
            `*** ABSTAIN — THIS RUN PROVED NOTHING ***\n`
                + `${recordedPath} has no \`## spec\` section, so there was nothing to score.\n`
                + `The corpus rolled over or the heading changed; re-pin it before reading this.`
        )
        process.exit(2)
    }

    // A spec that names neither token is not a scorer failure — it is a corpus
    // that rolled over. `~/hub/mx5` kept running after run 19, and by 2026-08-07
    // TASK_0001 was a different task entirely. Reporting that as SCORER BROKEN is
    // how a regression net goes red for reasons that have nothing to do with what
    // it guards, and a net that goes red on its own is a net nobody reads — the
    // same lesson dangling-artifact-fp-suite.ts learned when it started pinning
    // `git archive` exports instead of scanning a live tree.
    if (!/argon2|bun-sql/i.test(spec)) {
        console.log(
            `*** ABSTAIN — THIS RUN PROVED NOTHING ***\n`
                + `${recordedPath} no longer contains run-19's spec: it names neither\n`
                + `\`argon2\` nor \`bun-sql\`, so the defect this arm scores is not in the tree.\n`
                + `The corpus rolled over. Pin an export of the run-19 commit (see\n`
                + `scripts/html-asset-closure-corpus.ts for the pattern) before reading this arm.`
        )
        process.exit(2)
    }

    const dep = requiresUnneededDep(spec)
    const api = forbidsMandatedApi(spec)
    const ok = eq(dep, ['argon2', 'bun-sql']) && eq(api, ['Bun.password', 'Bun.sql'])
    console.log(`${ok ? 'ok  ' : 'BAD '} recorded run-19 spec — dep=[${dep}] api=[${api}]`)
    console.log(ok ? '\nSCORER OK' : '\nSCORER BROKEN — the recorded defect no longer scores')
    process.exit(ok ? 0 : 1)
}

main()
