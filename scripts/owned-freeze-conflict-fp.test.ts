/**
 * Zero-FP fixtures for the owned-requirement/category-freeze detector (nexttask 7).
 *
 * The discipline is `frozen-conflict`'s ("FP-swept over the 26 real mx5 run-12
 * specs") and `dangling-artifact-fp-suite.ts`'s: a detector whose finding is
 * FORCED into the critique rewrite spends model time on every fire, so a false
 * positive is not a nuisance, it is a spec the model is ordered to damage.
 *
 *   NEGATIVES  specs carrying BOTH sides of the shape — an owned requirement and
 *              a freeze — that are satisfiable anyway. Expect zero findings.
 *   POSITIVES  the same specs with the satisfiability removed. Without them, the
 *              negatives also pass with a detector that never fires at all.
 *
 * `alwaysSource` stands in for the git oracle, so these need no repo on disk and
 * no evidence tree — which is why they run on every `bun test` rather than when
 * somebody remembers the script. The corpus arm (mx5, gofer-pixel, IAR1, runner,
 * aiz-client) stays in `scripts/owned-freeze-conflict-fp-suite.ts`.
 *
 * Run 18's TASK_0023 spec is preserved verbatim as a positive below, so rolling
 * the evidence tree can never silently retire the original evidence — the corpus
 * already rolled over once (2026-08-05, run 18 → run 19).
 */
import {describe, expect, test} from 'bun:test'
import {findOwnedFreezeConflicts} from '../src/task/owned-freeze-conflict.js'
import {parseOwnedRequirements} from '../src/task/requirements.js'

const alwaysSource = (): boolean => true

interface Fixture {
    name: string
    spec: string
}

describe('negatives — both sides of the shape present, and satisfiable anyway', () => {
    const NEGATIVES: Fixture[] = [
        {
            name: 'scoped freeze — the resolution shape must never re-fire',
            spec: `GOAL
  Register the component test config.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - You MAY edit \`src/server/index.ts\` ONLY as far as the owned requirement requires; do not modify any other source file outside \`package.json\` and \`src/server/index.ts\`.
ACCEPTANCE
  - The server serves the built client bundle from \`dist/\`.`
        },
        {
            name: 'owned path is OUTSIDE the freeze category (exempted by name)',
            spec: `GOAL
  Build the canvas component.
CONSTRAINTS
  - "\`Canvas.tsx\` — HTML5 Canvas element with mouse event handlers" [13. Plan] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do NOT modify any existing file outside \`src/components/Canvas.tsx\` — all files under \`src/engine/\` remain untouched.
ACCEPTANCE
  - \`src/components/Canvas.tsx\` exists and exports a default React component.`
        },
        {
            name: 'category freeze with NO owned requirement at all',
            spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - Do not modify \`build.ts\`, \`tsconfig.json\`, or any source files outside of \`package.json\`.
  - The server watch command must match the contract exactly: \`bun run --watch src/server/index.ts\`.
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
        },
        {
            name: 'owned requirement is itself prohibition-shaped',
            spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - "Never edit \`src/server/index.ts\` by hand — it is generated." [3. Repo layout] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`build.ts\` or any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev\` script.`
        },
        {
            name: 'creation ban, not a modification category freeze',
            spec: `GOAL
  Seed the admin account.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not create any files other than \`src/server/seed.ts\` and do not modify \`tsconfig.json\` or \`eslint.config.js\`.
ACCEPTANCE
  - \`src/server/seed.ts\` creates the admin.`
        },
        {
            name: 'owned requirement names its file only as a command argument',
            spec: `GOAL
  Add a \`dev\` script.
CONSTRAINTS
  - "**Client CSS:** \`bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css\`" [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`build.ts\` or any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev:css\` script.`
        }
    ]

    for (const f of NEGATIVES) {
        test(f.name, () => {
            const hits = findOwnedFreezeConflicts(f.spec, {isSource: alwaysSource})
            expect(
                hits.map(h => `${h.paths.join(', ')} | ${h.constraint.slice(0, 90)}`)
            ).toEqual([])
        })
    }
})

describe('positive controls — the same shapes with the satisfiability removed', () => {
    const LEDGER = parseOwnedRequirements(
        'OWNED: "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`." '
            + '[anchor: 9. Build & run] [title: Wire dev build pipeline]'
    )

    const POSITIVES: Fixture[] = [
        {
            name: 'run 18 TASK_0023, reduced to the pair',
            spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
  - Do not modify \`docker-compose.dev.yml\`, \`build.ts\`, or any source files outside of \`package.json\`.
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
        },
        {
            name: 'passive ACCEPTANCE freeze alone (no CONSTRAINTS freeze)',
            spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`." [9. Build & run] — owned requirement from the source design (AUTHORITATIVE; satisfy it in this task, do not narrow it)
ACCEPTANCE
  - No files other than \`package.json\` are modified.`
        },
        {
            name: 'unstamped owned quote, recovered from the run ledger',
            spec: `GOAL
  Add a \`dev\` script to \`package.json\`.
CONSTRAINTS
  - The server must satisfy "**Server:** \`bun run --watch src/server/index.ts\` — serves \`/api\` + static \`dist/\`."
  - Do not modify any source files outside of \`package.json\`.
ACCEPTANCE
  - \`package.json\` gains a \`dev\` script.`
        }
    ]

    for (const f of POSITIVES) {
        test(f.name, () => {
            const hits = findOwnedFreezeConflicts(f.spec, {owned: LEDGER, isSource: alwaysSource})
            expect(hits).toHaveLength(1)
            expect(hits[0].paths).toContain('src/server/index.ts')
        })
    }
})
