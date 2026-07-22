/**
 * STAGE 2 — the two ASSERTED string surgeries for the APIS output-contract lever, plus the
 * runtime check that either one actually took effect.
 *
 * TWO SURGERIES, BECAUSE THE LEVER IS WIRED AT A DIFFERENT MOMENT IN EACH STEP:
 *   SPLICE_CONTRACT  STEP A only. The lever is NOT in src/ yet, so it is spliced into a
 *                    private dist copy in front of the APIS output-format line. This is what
 *                    lets the feasibility probe run BEFORE the implementation — the ordering
 *                    the whole nexxtasks file exists to enforce.
 *   STRIP_CONTRACT   STEP D baseline arm. The lever IS shipped by then, so the baseline is the
 *                    shipped path with the block REMOVED, not a code path configured by a flag
 *                    that production never takes.
 *
 * WHY THE SPLICE ESCAPES ITS PAYLOAD. `RESEARCH_APIS_PROMPT` is a template literal in the
 * emitted JS, and the contract text contains backticks (it quotes `hc(baseUrl: Prefix, …)`).
 * Pasting it in raw would TERMINATE the literal and leave a dist that either fails to parse or
 * — worse — parses into something else. So backslashes, backticks and `${` are escaped for the
 * template-literal context, and `assertContractInPrompt` then verifies the RESULT by calling
 * the loaded module rather than trusting that the replacement was well-formed.
 *
 * THE ASSERTIONS ARE THE POINT. buildPatchedDist already refuses an anchor that does not occur
 * exactly once; that catches a missing anchor but not a mangled payload. Checking the ASSEMBLED
 * PROMPT closes the other half: PROMPT 4's negative result would have been a mis-report without
 * the equivalent check (it verified that the block was COMPUTED, which is a different claim
 * from the block REACHING the prompt).
 */
import * as path from 'node:path'
import {APIS_SEMANTICS_CONTRACT} from '../src/task/apis-contract.js'
import type {Surgery} from './spec-url-dist.js'

/**
 * The APIS output-format contract as tsc emits it. Unique in `task/prompts.js`: FILES, CONTEXT
 * and TOOLING each name their own section, so this two-line block occurs exactly once.
 */
const APIS_OUTPUT_ANCHOR = `Output ONLY the content of an APIS section — one entry per line, format:
  <name>  <one-line signature or use>`

/** Escape a payload for insertion INSIDE a JS template literal. */
const forTemplateLiteral = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')

/** STEP A: splice the (not yet wired) contract into a private dist copy. */
export const SPLICE_CONTRACT: Surgery = {
    file: 'task/prompts.js',
    find: APIS_OUTPUT_ANCHOR,
    replace: `${forTemplateLiteral(APIS_SEMANTICS_CONTRACT)}\n\n${APIS_OUTPUT_ANCHOR}`,
    label: 'splice APIS_SEMANTICS_CONTRACT into RESEARCH_APIS_PROMPT (STEP A probe only)'
}

/**
 * STEP D baseline arm: remove the shipped block from the assembled prompt.
 *
 * The anchor is the interpolation site, not the identifier — the identifier also appears in the
 * import statement, and a two-occurrence anchor would (correctly) throw rather than silently
 * patching the wrong one.
 *
 * RE-RUN NOTE: the lever is UNWIRED as of 2026-07-23 (the A/B FAILED). While unwired, the
 * contract interpolation is absent from dist and this surgery's exactly-once assertion throws.
 * To re-run the A/B, re-wire the interpolation into RESEARCH_APIS_PROMPT first, exactly as
 * PROMPT 4's spec-URL harness required its wiring restored. The STEP A probe and the delivery
 * check's treatment arm use SPLICE_CONTRACT instead and work without re-wiring.
 */
export const STRIP_CONTRACT: Surgery = {
    file: 'task/prompts.js',
    find: '${APIS_SEMANTICS_CONTRACT}',
    replace: "${''}",
    label: 'strip APIS_SEMANTICS_CONTRACT from the APIS prompt (baseline arm only)'
}

/** First line of the contract — enough to identify it, short enough to survive re-wrapping. */
export const CONTRACT_MARKER = APIS_SEMANTICS_CONTRACT.slice(0, 120)

interface PromptsModule {
    RESEARCH_APIS_PROMPT: (refined: string, filesMap?: string) => string
}

/**
 * Load a patched dist's prompts module and assert the contract is present/absent in the
 * ASSEMBLED APIS prompt, as the worker would receive it.
 *
 * Returns the assembled prompt so a caller can print its length and tail — "the block was
 * computed" and "the block reached the prompt" are different claims and only the second one
 * matters to a model.
 */
export async function assertContractInPrompt(distRoot: string, expectPresent: boolean): Promise<string> {
    const mod = (await import(path.join(distRoot, 'task', 'prompts.js'))) as PromptsModule
    const prompt = mod.RESEARCH_APIS_PROMPT('a task that uses the hono package', 'src/x.ts  a file')
    const present = prompt.includes(CONTRACT_MARKER)
    if (present !== expectPresent) {
        throw new Error(
            `SURGERY CHECK FAILED for ${distRoot}: the APIS output contract is `
                + `${present ? 'PRESENT' : 'ABSENT'} in the assembled prompt but was expected `
                + `${expectPresent ? 'PRESENT' : 'ABSENT'}. Both arms would then be measuring the `
                + 'same prompt, and the A/B could only report "no effect" — the most expensive '
                + 'failure mode, because it looks like a result.'
        )
    }
    return prompt
}
