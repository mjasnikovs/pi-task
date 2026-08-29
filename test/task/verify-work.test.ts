import {describe, expect, test} from 'bun:test'
import {
    buildVerifyPrompt,
    extractSpecForVerification,
    parseVerifyVerdict,
    runWorkVerification,
    VERIFY_TOOLS,
    VERIFY_FAIL_PREFIX,
    verifyFailClass,
    failClassOfReason,
    isStaticClass,
    type VerifyFailClass
} from '../../src/task/verify-work.js'
import {USER_CANCELLED} from '../../src/task/child-runner.js'

describe('VERIFY_TOOLS', () => {
    test('grants bash (to run) and read, but never edit/write', () => {
        const tools = VERIFY_TOOLS.split(',')
        expect(tools).toContain('bash')
        expect(tools).toContain('read')
        expect(tools).not.toContain('edit')
        expect(tools).not.toContain('write')
    })
})

describe('extractSpecForVerification', () => {
    const body = [
        '## raw prompt',
        'do the thing',
        '',
        '## spec',
        '',
        'GOAL',
        'make it work',
        '',
        'VERIFY:',
        '```sh',
        'bun run build',
        '```',
        '',
        '## phase timings',
        'refine 1s'
    ].join('\n')

    test('slices the spec section out of the task body', () => {
        const spec = extractSpecForVerification(body)
        expect(spec).toContain('GOAL')
        expect(spec).toContain('bun run build')
        expect(spec).not.toContain('## phase timings')
        expect(spec).not.toContain('do the thing')
    })

    test('returns null when there is no spec section', () => {
        expect(extractSpecForVerification('## raw prompt\nhi\n')).toBeNull()
    })

    test('returns null for an empty spec section', () => {
        expect(extractSpecForVerification('## spec\n\n## phase timings\n')).toBeNull()
    })
})

describe('buildVerifyPrompt', () => {
    test('hands over the spec and forbids editing', () => {
        const p = buildVerifyPrompt('GOAL\nbuild it')
        expect(p).toContain('GOAL\nbuild it')
        expect(p).toContain('`bash`')
        expect(p).toContain('never modify')
        expect(p).toContain('WORK-VERIFIED: PASS')
        expect(p).toContain('WORK-VERIFIED: FAIL')
    })

    test('rule 3d forbids the verifier itself substituting a copy for the artifact', () => {
        // Regression guard for the class: the VERIFY CHILD (not the work)
        // wrote final_verify.ts into the worktree, re-implemented the photos handler
        // "EXACTLY as in photos.ts", served the copy on a scratch port, and passed a
        // route the shipped app could not even serve (no Bun.serve existed). Rule 3b
        // only bound tests shipped BY THE WORK; 3d must bind the verifier too, keep
        // its scratch out of the repo (the file leaked into the next checkpoint
        // commit), and make "the real artifact cannot be exercised" a FAIL, not a
        // license to substitute.
        const p = buildVerifyPrompt('GOAL\nx')
        expect(p).toContain('3d. SELF-SUBSTITUTION')
        expect(p).toContain('bind YOU')
        expect(p).toMatch(/temp directory \(\/tmp\)/)
        expect(p).toContain('NEVER inside the repository worktree')
        expect(p).toMatch(/NEVER re-implement, copy, or paraphrase/)
        expect(p).toContain('that inability IS the defect')
        expect(p).toContain('Do not stand up a substitute')
    })

    test('anchors verification to the project as-shipped, run unaided', () => {
        // Regression guard for the validated work-around-to-pass class: the child has
        // `bash` and can make almost anything go green by preparing the run (export an
        // env var, source a file, run a different command, rebuild in a scratch dir).
        // The prompt must forbid that and treat any such intervention as the defect.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        // run the project's OWN command, unaided / as shipped
        expect(p).toContain("project's own")
        expect(p).toMatch(/as shipped|unaided|fresh\s*\n?\s*checkout/)
        // must NOT prepare/repair/reconfigure the run — name the concrete workarounds
        expect(p).toMatch(/do not prepare, repair, reconfigure/)
        expect(p).toContain('export an')
        expect(p).toContain('environment variable')
        expect(p).toMatch(/scratch dir/)
        // the intervention IS the defect
        expect(p).toMatch(/is the\s*\n?\s*defect/)
        // source-text presence is not verification
        expect(p).toContain('is not verification')
        // still distinguishes a genuine external-service gap from a code defect
        expect(p).toContain('environment gap')
        expect(p).toContain('external')
    })

    test('forbids grep-theater: static-only checks are not a PASS when execution was possible', () => {
        // Regression guard for the grep-theater class: a schema.sql with INVALID
        // SQL was "verified" by grepping for its own (broken) text while a live
        // Postgres sat reachable in the same container. The prompt must (a) say a
        // grep-only VERIFY block does not cap the obligation to execute/apply the
        // artifact, and (b) require PROBING a declared external service before
        // invoking the absent-service exception — reachable ⇒ must run against it.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        // the VERIFY block does not cap the obligation
        expect(p).toMatch(/verify block does not cap/)
        expect(p).toMatch(/executed or applied/)
        expect(p).toMatch(/grep-only checks passing[\s\S]*?not a pass/)
        // probe before relying on the external-service exception
        expect(p).toContain('probe')
        expect(p).toMatch(/is reachable, the exception\s*\n?\s*does not apply/)
        expect(p).toMatch(/genuinely absent/)
    })

    test('forbids test-the-copy: substitution rule always present (A/B: rule + probe = 5/5)', () => {
        // Regression guard for the test-the-copy class: "integration tests"
        // re-implemented every protected route inline (own Bun.serve / fake Hono),
        // ran wholly green, and a prompt without this rule false-PASSes it.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        expect(p).toContain('substitution')
        expect(p).toMatch(/proves only the copy/)
        expect(p).toMatch(/import the real module and then never call it/)
        expect(p).toMatch(/drive the real\s*\n?\s*shipped artifact/)
        expect(p).toMatch(/name the bypass/)
    })

    test('injects deterministic probe findings as a self-verification mandate', () => {
        const findings = [
            'src/test/auth.test.ts (+712 lines) — a test file this task authored or changed itself…',
            'src/test/request.ts (+941 lines) — a test file this task authored or changed itself…'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {substitution: findings})
        expect(p).toContain('SELF-VERIFICATION NOTICE')
        expect(p).toContain('- src/test/auth.test.ts (+712 lines)')
        expect(p).toContain('- src/test/request.ts (+941 lines)')
        expect(p).toContain('you MUST confirm these tests exercise the REAL shipped artifact')
        // No findings → no probe block at all (empty array and undefined alike).
        expect(buildVerifyPrompt('GOAL\nx', {substitution: []})).not.toContain(
            'SELF-VERIFICATION NOTICE'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('SELF-VERIFICATION NOTICE')
    })

    test('forbids violation excusal: a violated spec prohibition is a FAIL, no waiver authority', () => {
        // Regression guard for the class (F5): the child saw "Do NOT modify
        // server-side code" violated, waived it as "additive, tests pass with it", and
        // PASSed. The verdict on a violated prohibition is not the verifier's to relax.
        const p = buildVerifyPrompt('GOAL\nx')
        expect(p).toContain('NO WAIVER AUTHORITY')
        expect(p).toMatch(/additive, small, harmless/)
        expect(p).toMatch(/because every test still passes/)
        expect(p).toMatch(/fully REVERTED/)
        expect(p).toMatch(/wording states an exception/)
    })

    test('injects deterministic skip-escape findings tied to rule 5c', () => {
        const findings = [
            'smoke.spec.js || echo "skipping (uismoke not installed)" — its `||` fallback…'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {skipEscape: findings})
        expect(p).toContain('SKIP-ESCAPE NOTICE')
        expect(p).toContain('- smoke.spec.js || echo')
        expect(p).toMatch(/UNOBSERVED \(rule 5c\)/)
        expect(p).toMatch(/Do NOT accept a skipped check as a passed check/)
        // No findings → no block at all.
        expect(buildVerifyPrompt('GOAL\nx', {skipEscape: []})).not.toContain('SKIP-ESCAPE NOTICE')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('SKIP-ESCAPE NOTICE')
    })

    test('injects sandbox-path-leak findings tied to rule 4e', () => {
        const findings = [
            'playwright-ct.config.ts — committed the absolute path `/workspace/src/shared`…'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {foreignPath: findings})
        expect(p).toContain('SANDBOX PATH LEAK NOTICE')
        expect(p).toContain('- playwright-ct.config.ts — committed the absolute path')
        // The verdict-gating mandate, and the distinctive "green means nothing"
        // instruction: a leak breaks the BUILD, so the suite reports zero work.
        expect(p).toMatch(/the verdict is FAIL naming the file and the path \(rule 4e\)/)
        expect(p).toMatch(/count\s+the tests\/steps that ran, not the exit code/)
        // The standing rule is present even without a finding...
        expect(buildVerifyPrompt('GOAL\nx')).toContain(
            '4e. AN ABSOLUTE PATH TO PROJECT FILES IS A DEFECT'
        )
        // ...but the NOTICE block only appears with findings.
        expect(buildVerifyPrompt('GOAL\nx', {foreignPath: []})).not.toContain(
            'SANDBOX PATH LEAK NOTICE'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('SANDBOX PATH LEAK NOTICE')
    })

    test('injects neutered-check-script findings tied to rule 4f', () => {
        const findings = ['`lint`: tsc --noEmit || true — it ends in `|| true`, so the script…']
        const p = buildVerifyPrompt('GOAL\nx', {scriptEscape: findings})
        expect(p).toContain('NEUTERED CHECK SCRIPT NOTICE')
        expect(p).toContain('- `lint`: tsc --noEmit || true')
        // The key instruction: running the script cannot reveal the defect.
        expect(p).toMatch(/You CANNOT discover this by running the script/)
        expect(p).toMatch(/the verdict is FAIL naming the script \(rule 4f\)/)
        expect(buildVerifyPrompt('GOAL\nx')).toContain(
            '4f. A CHECK THAT CANNOT FAIL PROVES NOTHING'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('NEUTERED CHECK SCRIPT NOTICE')
    })

    test('injects runner glob-collision findings tied to rule 4g', () => {
        const findings = ['`test` runs bun test, which scans the whole project…']
        const p = buildVerifyPrompt('GOAL\nx', {runnerGlob: findings})
        expect(p).toContain('TEST-RUNNER GLOB COLLISION NOTICE')
        expect(p).toContain('- `test` runs bun test')
        // The distinctive mandate: collection-time death, so count what RAN.
        expect(p).toMatch(/errors during collection has verified nothing/)
        expect(buildVerifyPrompt('GOAL\nx')).toContain('4g. TWO RUNNERS, ONE FILE SET, NO RESULTS')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('TEST-RUNNER GLOB COLLISION NOTICE')
    })

    test('the three project-surface findings are independent', () => {
        const all = buildVerifyPrompt('GOAL\nx', {
            foreignPath: ['fp'],
            scriptEscape: ['se'],
            runnerGlob: ['rg']
        })
        expect(all).toContain('SANDBOX PATH LEAK NOTICE')
        expect(all).toContain('NEUTERED CHECK SCRIPT NOTICE')
        expect(all).toContain('TEST-RUNNER GLOB COLLISION NOTICE')
        // One present does not drag the others in.
        const one = buildVerifyPrompt('GOAL\nx', {scriptEscape: ['se']})
        expect(one).toContain('NEUTERED CHECK SCRIPT NOTICE')
        expect(one).not.toContain('SANDBOX PATH LEAK NOTICE')
        expect(one).not.toContain('TEST-RUNNER GLOB COLLISION NOTICE')
    })

    test('injects the cross-slice contracts block mandating a boundary check', () => {
        const contracts =
            '"POST /api/listings/:id/photos" [anchor: Photos API]\n"GET /api/photos/:id"'
        const p = buildVerifyPrompt('GOAL\nx', {}, {contracts})
        expect(p).toContain('CROSS-SLICE CONTRACTS')
        expect(p).toContain('- "POST /api/listings/:id/photos" [anchor: Photos API]')
        expect(p).toMatch(/SEAM BUG — report FAIL/)
        // Absent/empty contracts → no block.
        expect(buildVerifyPrompt('GOAL\nx', {}, {contracts: ''})).not.toContain(
            'CROSS-SLICE CONTRACTS'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('CROSS-SLICE CONTRACTS')
    })

    test('injects deterministic test-assembly findings under rule 3f (F4)', () => {
        const findings = [
            'test/photos.test.ts imports and re-composes 2 leaf module(s) '
                + '(src/server/routes/auth, src/server/routes/photos) that src/server/index.ts '
                + 'is the ONLY production file to compose, yet it never imports src/server/index.ts'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {testAssembly: findings})
        expect(p).toContain('TEST-ASSEMBLY NOTICE')
        expect(p).toContain('- test/photos.test.ts imports and re-composes 2 leaf module(s)')
        expect(p).toContain('rule 3f')
        // The rule text itself is always present (naming the class); the notice block
        // only when a finding is supplied.
        expect(p).toContain('TEST-REBUILT ASSEMBLY')
        expect(buildVerifyPrompt('GOAL\nx', {testAssembly: []})).not.toContain(
            'TEST-ASSEMBLY NOTICE'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('TEST-ASSEMBLY NOTICE')
    })

    test('injects deterministic probe-gaming findings under rule 4c (F6)', () => {
        const findings = [
            'src/server/index.ts: this task added a line stating its purpose is to make a '
                + 'check pass, not to meet the requirement — "// Return 401 so the verification test passes"'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {probeGaming: findings})
        expect(p).toContain('CHECK-GAMING NOTICE (deterministic')
        expect(p).toContain('- src/server/index.ts: this task added a line')
        expect(p).toContain('rule 4c')
        // The rule text itself is always present (and mentions the notice by name); the
        // deterministic notice BLOCK only appears when a finding is supplied.
        expect(p).toContain('THE CHECK IS THE MESSENGER, NOT THE REQUIREMENT')
        expect(buildVerifyPrompt('GOAL\nx', {probeGaming: []})).not.toContain(
            'CHECK-GAMING NOTICE (deterministic'
        )
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('CHECK-GAMING NOTICE (deterministic')
    })

    test('injects deterministic prohibition findings under the no-waiver rule', () => {
        const findings = [
            'src/server/index.ts — modified by this task, but the spec forbids it: "Do NOT modify `src/server/index.ts`"'
        ]
        const p = buildVerifyPrompt('GOAL\nx', {prohibition: findings})
        expect(p).toContain('PROHIBITION NOTICE')
        expect(p).toContain('- src/server/index.ts — modified by this task')
        expect(p).toContain('rule 4b applies')
        // No findings → no block at all (empty array and undefined alike).
        expect(buildVerifyPrompt('GOAL\nx', {prohibition: []})).not.toContain('PROHIBITION NOTICE')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('PROHIBITION NOTICE')
    })

    test('forbids test-authored repair: a suite that patches the product is not verification', () => {
        // Regression guard for the class, A/B-proven live (silent fixture:
        // suite green ONLY because test setup ALTERs the schema and seeds around the
        // broken seed script): the shipped prompt false-PASSes it, the prompt with this rule
        // never does, and names the exact gap; the honest fixture PASSes in both arms.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        expect(p).toContain('test-authored repair')
        expect(p).toMatch(/read its setup\/bootstrap/)
        expect(p).toMatch(/seeding ordinary test data is fine/)
        expect(p).toMatch(/proves the repaired copy/)
        expect(p).toMatch(/own setup commands \(its migrations \/ seed scripts\)/)
        expect(p).toMatch(/the column no migration creates/)
    })

    test('external service STATE is as-shipped: schema surgery is forbidden', () => {
        // Regression guard for the observed DB-repair loophole: children (and the
        // live impl turn) ALTER TABLEd the shared test DB to make broken work pass.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        expect(p).toContain('alter table')
        expect(p).toMatch(/schema surgery[\s\S]*?is the\s*\n?\s*defect/)
        expect(p).toMatch(/own migration\/schema files/)
    })

    test('negative control: a success that cannot fail on wrong input is void evidence', () => {
        // Regression guard: a catch-all fallback answered
        // ANY method on ANY path with 200 + HTML, so the broken upload endpoint
        // "succeeded" and the verify curl could not fail — the child false-PASSed.
        // The rule must require a deliberately-wrong control and treat same-success on
        // garbage as UNVERIFIED, stack-agnostically (HTTP / CLI / library / schema).
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        expect(p).toContain('negative control is mandatory')
        expect(p).toMatch(/a success you cannot make fail is not evidence/)
        expect(p).toMatch(
            /you must also run that same check with one input deliberately\s*\n?\s*wrong/
        )
        expect(p).toMatch(/nonsense path/)
        // must recreate setup so a killed server / one-shot command is not an excuse to skip
        expect(p).toMatch(/restart the server/)
        expect(p).toMatch(/yields the same success/)
        expect(p).toMatch(/catch-all fallback is masking it/)
        // skipping the control is a FAIL, not a neutral pass
        expect(p).toMatch(/skipping the control is not neutral/)
        expect(p).toMatch(/unverified is a fail/)
        // stack-agnostic surface: names non-HTTP artifact kinds too
        expect(p).toMatch(/cli invocation/)
        expect(p).toMatch(/library call/)
        // reinforced in the verdict-discipline section
        expect(p).toMatch(/paired\s*\n?\s*negative control/)
    })

    test('rule 5c: a spec-required check that self-skips or lacks tooling is UNOBSERVED, not PASS', () => {
        // Regression guard: the only behavioral checks ever
        // authored (browser smokes) were wrapped in `|| echo skipping`; the tool was
        // absent, the checks silently skipped, and the verify child called it "correctly
        // skipped" → PASS. The rule must (a) draw the line from rule 5's external-service
        // env-gap, (b) name the skip-escape shapes, (c) route it to a distinct UNOBSERVED
        // verdict, and (d) keep rule 6's "nothing to verify" case separate.
        const p = buildVerifyPrompt('GOAL\nx')
        expect(p).toContain('5c. A SPEC-REQUIRED CHECK THAT DID NOT ACTUALLY RUN IS NOT VERIFIED')
        expect(p).toMatch(
            /env-gap\s*\n?\s*exception \(rule 5\) covers ONLY a genuinely EXTERNAL service/
        )
        expect(p).toContain('|| echo')
        expect(p).toContain('command -v X')
        expect(p).toMatch(/"correctly skipped" is NOT a\s*\n?\s*PASS/)
        expect(p).toMatch(/the verdict is\s*\n?\s*UNOBSERVED/)
        // rule 6 stays distinct: nothing-to-verify is not a dodged observation
        expect(p).toMatch(/"nothing to verify" means the spec never demanded/)
        // the third verdict token is offered in the output contract
        expect(p).toContain('WORK-VERIFIED: UNOBSERVED')
        // the crisp discriminator that keeps rule 5 (absent runtime SERVICE = env-gap)
        // apart from rule 5c (absent observation HARNESS = UNOBSERVED) — the local model
        // over-fired on external-service gaps until this either/or was made explicit.
        expect(p).toContain('DISCRIMINATOR (rule 5 vs rule 5c)')
        expect(p).toMatch(/SERVICE the FINISHED PRODUCT itself[\s\S]*?connects to at runtime/)
        expect(p).toMatch(/HARNESS that[\s\S]*?exists only to OBSERVE or DRIVE the product/)
        expect(p).toMatch(
            /NEEDS the former to work at all; it needs the latter[\s\S]*?only to be CHECKED/
        )
    })

    test('verdict discipline: an unmet acceptance criterion is a FAIL, not a warning', () => {
        // Regression guard for verdict leniency: a live child enumerated two real
        // acceptance violations as warnings and PASSed anyway.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        expect(p).toContain('verdict discipline')
        expect(p).toMatch(/follow mechanically from your findings/)
        expect(p).toMatch(/never downgrade an unmet criterion/)
    })
})

describe('buildVerifyPrompt — the probe table preserves the measured layout', () => {
    // The prompt wording is load-bearing, and the table drives two
    // DIFFERENT orders: notice blocks come out in table order, the hand-numbered rules
    // come out in rule-number order. Nothing else pins either, so these hold them.
    test('the 4b…4g rule band stays in ascending rule-number order, each rule once', () => {
        const p = buildVerifyPrompt('GOAL\nx')
        const band = ['4b.', '4c.', '4d.', '4e.', '4f.', '4g.']
        const positions = band.map(id => {
            const starts = p.split('\n').filter(l => l.startsWith(id))
            expect(starts.length).toBe(1)
            return p.indexOf(`\n${id}`)
        })
        expect(positions.every(i => i > 0)).toBe(true)
        expect([...positions].sort((a, b) => a - b)).toEqual(positions)
        // The band sits between rule 4 and rule 5, where it was hand-written.
        expect(p.indexOf('\n4. Treat the ACCEPTANCE')).toBeLessThan(positions[0])
        expect(p.indexOf('\n5. The ONLY thing')).toBeGreaterThan(positions[5])
    })

    test('notice blocks are emitted in table order, not findings order', () => {
        const p = buildVerifyPrompt('GOAL\nx', {
            testAssembly: ['ta'],
            runnerGlob: ['rg'],
            skipEscape: ['se'],
            crossTaskDeletion: ['xtd'],
            substitution: ['sub'],
            prohibition: ['proh'],
            probeGaming: ['pg'],
            foreignPath: ['fp'],
            scriptEscape: ['sce']
        })
        const order = [
            'SELF-VERIFICATION NOTICE',
            'PROHIBITION NOTICE',
            'CROSS-TASK DELETION NOTICE',
            'CHECK-GAMING NOTICE',
            'SKIP-ESCAPE NOTICE',
            'SANDBOX PATH LEAK NOTICE',
            'NEUTERED CHECK SCRIPT NOTICE',
            'TEST-RUNNER GLOB COLLISION NOTICE',
            'TEST-ASSEMBLY NOTICE'
        ].map(h => p.indexOf(h))
        expect(order.every(i => i >= 0)).toBe(true)
        expect([...order].sort((a, b) => a - b)).toEqual(order)
        // …and they all sit above the "How to verify" instructions.
        expect(order[8]).toBeLessThan(p.indexOf('How to verify'))
    })
})

describe('buildVerifyPrompt — cross-task deletion (rule 4d, mx5 run 12 PROMPT 2)', () => {
    test('rule 4d is always present and gates the verdict', () => {
        const p = buildVerifyPrompt('GOAL\nx')
        expect(p).toContain("4d. A SIBLING TASK'S COMMITTED DELIVERABLE")
        expect(p).toContain('DELETED tracked files')
        // Verdict-gating: the rule names FAIL, and the two non-FAIL escapes.
        expect(p).toMatch(/verdict is FAIL naming the deleted file/)
        expect(p).toContain('relocation')
    })
    test('findings become a MANDATORY notice naming file and owner', () => {
        const p = buildVerifyPrompt('GOAL\nx', {
            crossTaskDeletion: [
                "`playwright/index.ts` — introduced and committed by TASK_0020, DELETED by this task's work"
            ]
        })
        expect(p).toContain('CROSS-TASK DELETION NOTICE')
        expect(p).toContain('`playwright/index.ts`')
        expect(p).toContain('TASK_0020')
        // The notice itself carries the verdict mandate — a buried rule is not read.
        expect(p).toMatch(/verdict is FAIL naming the deleted file and its owning task/)
        // No findings → no notice block.
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('CROSS-TASK DELETION NOTICE')
    })
})

describe('parseVerifyVerdict', () => {
    test('PASS verdict', () => {
        expect(parseVerifyVerdict('ran build ok\nWORK-VERIFIED: PASS')).toEqual({
            pass: true,
            detail: ''
        })
    })

    test('FAIL verdict carries the reason', () => {
        expect(parseVerifyVerdict('WORK-VERIFIED: FAIL build error in Auth.tsx')).toEqual({
            pass: false,
            detail: 'build error in Auth.tsx'
        })
    })

    test('last verdict wins when the model discusses before concluding', () => {
        const text = 'first I thought WORK-VERIFIED: FAIL maybe\n...\nWORK-VERIFIED: PASS'
        expect(parseVerifyVerdict(text).pass).toBe(true)
    })

    test('no marker is not a pass', () => {
        expect(parseVerifyVerdict('looks fine to me').pass).toBe(false)
    })

    test('UNOBSERVED verdict → not a pass, flagged unobserved, detail carried', () => {
        expect(
            parseVerifyVerdict('WORK-VERIFIED: UNOBSERVED browser smoke needs playwright')
        ).toEqual({
            pass: false,
            unobserved: true,
            detail: 'browser smoke needs playwright'
        })
    })

    test('UNOBSERVED with no text still carries a default detail', () => {
        const v = parseVerifyVerdict('WORK-VERIFIED: UNOBSERVED')
        expect(v.pass).toBe(false)
        expect(v.unobserved).toBe(true)
        expect(v.detail.length).toBeGreaterThan(0)
    })

    test('a plain FAIL is not flagged unobserved', () => {
        expect(parseVerifyVerdict('WORK-VERIFIED: FAIL build broke').unobserved).toBeUndefined()
    })

    test('echoed spec "VERIFY:" header does not false-trigger', () => {
        // The spec text itself contains "VERIFY:"; only the distinct
        // WORK-VERIFIED token counts.
        expect(parseVerifyVerdict('VERIFY:\n```sh\nbun test\n```').pass).toBe(false)
    })
})

describe('runWorkVerification', () => {
    test('no spec → pass no-op, child never runs', async () => {
        let called = false
        const out = await runWorkVerification({
            cwd: '/x',
            spec: null,
            runChild: async () => {
                called = true
                return ''
            }
        })
        expect(out).toEqual({ok: true, reason: 'no spec to verify'})
        expect(called).toBe(false)
    })

    test('PASS verdict → ok', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(true)
    })

    test('a skip-escape in the spec VERIFY block reaches the child prompt (rule 5c finding)', async () => {
        // The finding is computed deterministically from deps.spec — no injected dep.
        let prompt = ''
        const specWithEscape = [
            'GOAL',
            'ship a page',
            'VERIFY:',
            '```sh',
            'uismoke smoke.spec.js || echo "skipping browser smoke (uismoke not installed)"',
            '```'
        ].join('\n')
        await runWorkVerification({
            cwd: '/x',
            spec: specWithEscape,
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: UNOBSERVED tool absent'
            }
        })
        expect(prompt).toContain('SKIP-ESCAPE NOTICE')
        expect(prompt).toContain('uismoke smoke.spec.js || echo')
        // A spec with no skip-escape gets no block.
        let prompt2 = ''
        await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx\nVERIFY:\n```sh\nbun run build\n```',
            runChild: async (_t, p) => {
                prompt2 = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(prompt2).not.toContain('SKIP-ESCAPE NOTICE')
    })

    test('probe findings reach the child prompt; a probe failure never blocks', async () => {
        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {
                substitution: () =>
                    Promise.resolve([
                        'src/test/a.test.ts constructs its OWN server/app (Bun.serve(...))'
                    ])
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(prompt).toContain('SELF-VERIFICATION NOTICE')
        expect(prompt).toContain('src/test/a.test.ts')

        // Probe throwing must degrade to "no probe block", not a failed gate.
        let prompt2 = ''
        const out2 = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {substitution: () => Promise.reject(new Error('git broke'))},
            runChild: async (_t, p) => {
                prompt2 = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out2.ok).toBe(true)
        expect(prompt2).not.toContain('SELF-VERIFICATION NOTICE')
    })

    test('probes are fault-isolated in the table loop: one throwing thunk skips ITS row only', async () => {
        // The isolation lives in PROBE_ADAPTERS' run (one try/catch per row), not
        // in the binder — so a bag with one broken probe still yields every other
        // row's notice, in table order, and the gate still reaches the child.
        let prompt = ''
        const stages: string[] = []
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            onStage: s => stages.push(s),
            probes: {
                substitution: () => Promise.reject(new Error('git broke')),
                prohibition: () =>
                    Promise.resolve(['src/a.ts — modified by this task, but the spec forbids it']),
                crossTaskDeletion: () => {
                    throw new Error('sync throw, not even a rejection')
                },
                runnerGlob: () => Promise.resolve(['`bun test` also collects e2e/*.spec.ts'])
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(prompt).not.toContain('SELF-VERIFICATION NOTICE')
        expect(prompt).not.toContain('CROSS-TASK DELETION NOTICE')
        expect(prompt).toContain('PROHIBITION NOTICE')
        expect(prompt).toContain('TEST-RUNNER GLOB COLLISION NOTICE')
        expect(prompt.indexOf('PROHIBITION NOTICE')).toBeLessThan(
            prompt.indexOf('TEST-RUNNER GLOB COLLISION NOTICE')
        )
        // Every bound row announced its stage — the throwing ones included (the
        // stage fires before the probe runs) — and the unbound rows did not.
        expect(stages).toEqual([
            'substitution probe',
            'prohibition probe',
            'cross-task deletion probe',
            'runner-glob probe'
        ])
    })

    test('test-assembly findings reach the child prompt; a probe failure never blocks', async () => {
        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {
                testAssembly: () =>
                    Promise.resolve([
                        'test/photos.test.ts imports and re-composes 2 leaf module(s) '
                            + '(src/server/routes/auth, src/server/routes/photos) that '
                            + 'src/server/index.ts is the ONLY production file to compose'
                    ])
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(prompt).toContain('TEST-ASSEMBLY NOTICE')
        expect(prompt).toContain('test/photos.test.ts')

        // Probe throwing must degrade to "no block", not a failed gate.
        let prompt2 = ''
        const out2 = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {testAssembly: () => Promise.reject(new Error('git broke'))},
            runChild: async (_t, p) => {
                prompt2 = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out2.ok).toBe(true)
        expect(prompt2).not.toContain('TEST-ASSEMBLY NOTICE')
    })

    test('prohibition findings reach the child prompt; a probe failure never blocks', async () => {
        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {
                prohibition: () =>
                    Promise.resolve([
                        'src/server/index.ts — modified by this task, but the spec forbids it: "Do NOT modify `src/server/index.ts`"'
                    ])
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(prompt).toContain('PROHIBITION NOTICE')
        expect(prompt).toContain('src/server/index.ts — modified by this task')

        // Prohibition probe throwing must degrade to "no block", not a failed gate.
        let prompt2 = ''
        const out2 = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {prohibition: () => Promise.reject(new Error('git broke'))},
            runChild: async (_t, p) => {
                prompt2 = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out2.ok).toBe(true)
        expect(prompt2).not.toContain('PROHIBITION NOTICE')
    })

    test('env notes reach the prompt with the caveat; emitted ENV-NOTE lines are captured even on FAIL', async () => {
        let prompt = ''
        const appended: string[][] = []
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            envNotes: {
                read: () => Promise.resolve('postgres at localhost:5432 absent'),
                append: notes => {
                    appended.push(notes)
                    return Promise.resolve()
                }
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'ENV-NOTE: bun 1.3.14 installed\nWORK-VERIFIED: FAIL suite needs the db'
            }
        })
        expect(out.ok).toBe(false)
        expect(prompt).toContain('KNOWN ENVIRONMENT FACTS')
        expect(prompt).toContain('postgres at localhost:5432 absent')
        expect(prompt).toContain('NOT a license')
        expect(prompt).toContain('ENV-NOTE: <one-line fact>')
        expect(appended).toEqual([['bun 1.3.14 installed']])
    })

    test('an env-notes cache failure never blocks verification', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            envNotes: {
                read: () => Promise.reject(new Error('disk broke')),
                append: () => Promise.reject(new Error('disk broke'))
            },
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(true)
    })

    test('FAIL verdict → blocked with reason', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => 'WORK-VERIFIED: FAIL the build is broken'
        })
        expect(out).toEqual({
            ok: false,
            failClass: 'model-verdict',
            reason: 'work did not verify: the build is broken'
        })
    })

    test('no-verdict child → verify retried once, second verdict wins', async () => {
        // A verdict-less child never judged the work (budget death mid-investigation,
        // seen live) — re-running the IMPLEMENTATION on an unjudged artifact wasted a
        // full impl turn. The retry stays inside the verify gate.
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return runs === 1 ?
                        'I looked at many files but ran out of budget…'
                    :   'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(true)
        expect(runs).toBe(2)
    })

    test('no verdict twice → blocked, reason says the retry happened', async () => {
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return 'still investigating, no conclusion'
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('no verdict emitted (after verify retry)')
        expect(runs).toBe(2)
    })

    test('UNOBSERVED verdict → blocked with unobserved flag, not retried', async () => {
        // rule 5c: a spec-required behavioral check could not run (tooling absent). This
        // is a real verdict (not a no-verdict gray area), so it must not be retried, and
        // it carries `unobserved` so the gate hands it straight to the human.
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return 'WORK-VERIFIED: UNOBSERVED browser smoke requires an absent runner'
            }
        })
        expect(out.ok).toBe(false)
        expect(out.unobserved).toBe(true)
        expect(out.reason).toContain('work unobserved')
        expect(out.reason).toContain('absent runner')
        expect(runs).toBe(1)
    })

    test('a real FAIL verdict is NOT retried — one child run only', async () => {
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return 'WORK-VERIFIED: FAIL schema column missing'
            }
        })
        expect(out.ok).toBe(false)
        expect(runs).toBe(1)
    })

    test('mutated run → verdict discarded (even a PASS), retried once on the restored tree', async () => {
        // The shape: the child stashed the work away and judged the wrong
        // tree. The git-state guard restored the state; the first verdict must be
        // discarded regardless of its direction and the verify re-run.
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return 'WORK-VERIFIED: PASS'
            },
            mutationCheck: () =>
                runs === 1 ?
                    {mutated: true, detail: 'dropped 1 stash entry the child pushed'}
                :   {mutated: false, detail: ''}
        })
        expect(out.ok).toBe(true)
        expect(runs).toBe(2)
    })

    test('child mutates on the retry too → FAIL naming the guard, no third run', async () => {
        let runs = 0
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                runs++
                return 'WORK-VERIFIED: PASS'
            },
            mutationCheck: () => ({mutated: true, detail: 'restored worktree files'})
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('mutated repo state')
        expect(out.reason).toContain('restored worktree files')
        expect(runs).toBe(2)
    })

    test('passes VERIFY_TOOLS through to the child', async () => {
        let seenTools = ''
        await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async tools => {
                seenTools = tools
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(seenTools).toBe(VERIFY_TOOLS)
    })

    test('child crash → blocked, never throws', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                throw new Error('child exited 1')
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('could not run')
    })

    test('repoHealth FAIL short-circuits to blocked — model child never runs', async () => {
        let childRan = false
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            repoHealth: async () => ({ok: false, reason: '`bun run lint` exited 1'}),
            runChild: async () => {
                childRan = true
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('repo health')
        expect(out.reason).toContain('bun run lint')
        // The deterministic fail is authoritative; do not spend a model turn.
        expect(childRan).toBe(false)
    })

    test('repoHealth PASS falls through to the model verdict', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            repoHealth: async () => ({ok: true, reason: 'static checks passed'}),
            runChild: async () => 'WORK-VERIFIED: FAIL behavior wrong'
        })
        expect(out).toEqual({
            ok: false,
            failClass: 'model-verdict',
            reason: 'work did not verify: behavior wrong'
        })
    })

    test('repoHealth FAIL blocks even a spec-less task (no VERIFY block to lean on)', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: null,
            repoHealth: async () => ({ok: false, reason: '`bun run lint` exited 1'}),
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('repo health')
    })

    test('user cancel propagates (not swallowed as a fail)', async () => {
        await expect(
            runWorkVerification({
                cwd: '/x',
                spec: 'GOAL\nx',
                runChild: async () => {
                    throw new Error(USER_CANCELLED)
                }
            })
        ).rejects.toThrow(USER_CANCELLED)
    })

    test('cross-task deletion probe: findings reach the prompt AND ride on a FAIL outcome', async () => {
        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {
                crossTaskDeletion: async () => [{path: 'playwright/index.ts', owner: 'TASK_0020'}]
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: FAIL deleted a sibling deliverable'
            }
        })
        expect(prompt).toContain('CROSS-TASK DELETION NOTICE')
        expect(prompt).toContain('TASK_0020')
        expect(out.ok).toBe(false)
        // Structured findings ride on the FAIL so an ACCEPT can record debts.
        expect(out.crossTaskDeletions).toEqual([{path: 'playwright/index.ts', owner: 'TASK_0020'}])
    })

    test('cross-task deletion findings ride on an UNOBSERVED outcome too', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {crossTaskDeletion: async () => [{path: 'a/b.ts', owner: 'TASK_0002'}]},
            runChild: async () => 'WORK-VERIFIED: UNOBSERVED tool absent'
        })
        expect(out.ok).toBe(false)
        expect(out.unobserved).toBe(true)
        expect(out.crossTaskDeletions).toEqual([{path: 'a/b.ts', owner: 'TASK_0002'}])
    })

    test('a PASS carries no deletion findings; a throwing probe degrades to none', async () => {
        const pass = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {crossTaskDeletion: async () => [{path: 'a/b.ts', owner: 'TASK_0002'}]},
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(pass.ok).toBe(true)
        expect(pass.crossTaskDeletions).toBeUndefined()

        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            probes: {
                crossTaskDeletion: async () => {
                    throw new Error('git broke')
                }
            },
            runChild: async (_t, p) => {
                prompt = p
                return 'WORK-VERIFIED: FAIL nope'
            }
        })
        expect(out.ok).toBe(false)
        expect(out.crossTaskDeletions).toBeUndefined()
        expect(prompt).not.toContain('CROSS-TASK DELETION NOTICE')
    })
})

// ─── The failure CLASS, as data ─────────────────────────────────────────────
//
// `unobserved` was always a typed field. Its siblings travelled as the PREFIX of
// `reason`, recovered at three production sites by re-typing the literal with two
// different matchers — so a reword of the mint disabled the graduated lint-fix
// path AND the only auto-closing debt class, with no compile error.

describe('verify failure class', () => {
    // The gap that let this registry ship ALREADY DRIFTED: the harness-fault
    // prefix read `verify pass could not run:` while the only site minting that
    // class emitted `verification pass could not run:`, so `failClassOfReason`
    // returned undefined for it. Asserting the prefixes are non-empty did not
    // catch that; asserting they round-trip does.
    test('every declared prefix is recognised back as its own class', () => {
        for (const [cls, prefix] of Object.entries(VERIFY_FAIL_PREFIX)) {
            expect(failClassOfReason(`${prefix} something went wrong`)).toBe(cls as VerifyFailClass)
        }
    })

    test('a harness fault carries its class and the registry prefix', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: () => Promise.reject(new Error('spawn ENOENT'))
        })
        expect(out.ok).toBe(false)
        expect(out.failClass).toBe('harness-fault')
        expect(failClassOfReason(out.reason ?? '')).toBe('harness-fault')
    })

    test('every class declares a display prefix', () => {
        const classes: VerifyFailClass[] = [
            'repo-health',
            'static-checks',
            'unobserved',
            'model-verdict',
            'harness-fault'
        ]
        for (const c of classes) expect(VERIFY_FAIL_PREFIX[c]).toBeTruthy()
        expect(Object.keys(VERIFY_FAIL_PREFIX).sort()).toEqual([...classes].sort())
    })

    test('a repo-health FAIL carries its class, not just its prefix', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            repoHealth: async () => ({ok: false, reason: '`bun run lint` exited 1'}),
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(false)
        expect(out.failClass).toBe('repo-health')
        // The wording is byte-frozen — the debt ledger stores it verbatim.
        expect(out.reason).toBe('repo health: `bun run lint` exited 1')
    })

    test('an UNOBSERVED FAIL keeps both its flag and its class', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => 'WORK-VERIFIED: UNOBSERVED playwright is not installed'
        })
        expect(out.unobserved).toBe(true)
        expect(out.failClass).toBe('unobserved')
    })

    test('verifyFailClass prefers the field and falls back to the minted prefix', () => {
        expect(verifyFailClass({failClass: 'repo-health', reason: 'anything at all'})).toBe(
            'repo-health'
        )
        // A debt read back off disk is a bare string with no outcome attached.
        expect(verifyFailClass({reason: 'repo health: `make lint` exited 2'})).toBe('repo-health')
        expect(verifyFailClass({reason: 'work did not verify: nope'})).toBe('model-verdict')
        expect(verifyFailClass({reason: 'boot check: no listener'})).toBeUndefined()
        expect(verifyFailClass({})).toBeUndefined()
    })

    // The run-level twin mints a DIFFERENT literal for the same concept, which is
    // why `isStaticClassDebt` was structurally blind to every run-level static
    // failure that reached the ledger.
    test('the run-level and task-level static failures are the same class', () => {
        expect(isStaticClass(failClassOfReason('repo health: `bun run lint` exited 1'))).toBe(true)
        expect(isStaticClass(failClassOfReason('static checks: `make lint` exited 2'))).toBe(true)
        expect(isStaticClass(failClassOfReason('work did not verify: behavior wrong'))).toBe(false)
        expect(isStaticClass(failClassOfReason('work unobserved: no playwright'))).toBe(false)
    })
})
