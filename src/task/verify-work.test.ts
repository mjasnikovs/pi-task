import {describe, expect, test} from 'bun:test'
import {
    buildVerifyPrompt,
    extractSpecForVerification,
    parseVerifyVerdict,
    runWorkVerification,
    VERIFY_TOOLS
} from './verify-work.js'
import {USER_CANCELLED} from './child-runner.js'

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
        // Regression guard for the mx5 run-5 class: the VERIFY CHILD (not the work)
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
        // Regression guard for the mx5 grep-theater class: a schema.sql with INVALID
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
        // Regression guard for the mx5 test-the-copy class: "integration tests"
        // re-implemented every protected route inline (own Bun.serve / fake Hono),
        // ran 26/26 green, and the old prompt false-PASSed 5/5 on the real tree.
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
        const p = buildVerifyPrompt('GOAL\nx', findings)
        expect(p).toContain('SELF-VERIFICATION NOTICE')
        expect(p).toContain('- src/test/auth.test.ts (+712 lines)')
        expect(p).toContain('- src/test/request.ts (+941 lines)')
        expect(p).toContain('you MUST confirm these tests exercise the REAL shipped artifact')
        // No findings → no probe block at all (empty array and undefined alike).
        expect(buildVerifyPrompt('GOAL\nx', [])).not.toContain('SELF-VERIFICATION NOTICE')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('SELF-VERIFICATION NOTICE')
    })

    test('forbids violation excusal: a violated spec prohibition is a FAIL, no waiver authority', () => {
        // Regression guard for the mx5 run-7 class (F5): the child saw "Do NOT modify
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
        const p = buildVerifyPrompt('GOAL\nx', [], '', [], findings)
        expect(p).toContain('SKIP-ESCAPE NOTICE')
        expect(p).toContain('- smoke.spec.js || echo')
        expect(p).toMatch(/UNOBSERVED \(rule 5c\)/)
        expect(p).toMatch(/Do NOT accept a skipped check as a passed check/)
        // No findings → no block at all.
        expect(buildVerifyPrompt('GOAL\nx', [], '', [], [])).not.toContain('SKIP-ESCAPE NOTICE')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('SKIP-ESCAPE NOTICE')
    })

    test('injects deterministic prohibition findings under the no-waiver rule', () => {
        const findings = [
            'src/server/index.ts — modified by this task, but the spec forbids it: "Do NOT modify `src/server/index.ts`"'
        ]
        const p = buildVerifyPrompt('GOAL\nx', [], '', findings)
        expect(p).toContain('PROHIBITION NOTICE')
        expect(p).toContain('- src/server/index.ts — modified by this task')
        expect(p).toContain('rule 4b applies')
        // No findings → no block at all (empty array and undefined alike).
        expect(buildVerifyPrompt('GOAL\nx', [], '', [])).not.toContain('PROHIBITION NOTICE')
        expect(buildVerifyPrompt('GOAL\nx')).not.toContain('PROHIBITION NOTICE')
    })

    test('forbids test-authored repair: a suite that patches the product is not verification', () => {
        // Regression guard for the mx5 run-4 class, A/B-proven live (silent fixture:
        // suite green ONLY because test setup ALTERs the schema and seeds around the
        // broken seed script): shipped prompt false-PASSed 3/5, prompt with this rule
        // 0/5 false-PASS naming the exact gap; honest fixture 3/3 PASS in both arms.
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
        // Regression guard for the mx5 run-8 F5 class: a catch-all fallback answered
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
        // Regression guard for the mx5 run-8 F2 class: the only behavioral checks ever
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
            probe: () =>
                Promise.resolve([
                    'src/test/a.test.ts constructs its OWN server/app (Bun.serve(...))'
                ]),
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
            probe: () => Promise.reject(new Error('git broke')),
            runChild: async (_t, p) => {
                prompt2 = p
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out2.ok).toBe(true)
        expect(prompt2).not.toContain('SELF-VERIFICATION NOTICE')
    })

    test('prohibition findings reach the child prompt; a probe failure never blocks', async () => {
        let prompt = ''
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            prohibitionProbe: () =>
                Promise.resolve([
                    'src/server/index.ts — modified by this task, but the spec forbids it: "Do NOT modify `src/server/index.ts`"'
                ]),
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
            prohibitionProbe: () => Promise.reject(new Error('git broke')),
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
        expect(out).toEqual({ok: false, reason: 'work did not verify: the build is broken'})
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
        // The mx5 run 6 shape: the child stashed the work away and judged the wrong
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
        expect(out).toEqual({ok: false, reason: 'work did not verify: behavior wrong'})
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
})
