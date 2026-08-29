/**
 * Anti-synthesis guard for grill/clarify auto-answers.
 *
 * The grill auto-answer channel invented `Bun.mkdirSync` (does not exist) while
 * the task's own research APIS section carried the correct list (Bun.build,
 * Bun.spawn). Nothing cross-checked the answer against it, so the invention was
 * promoted into the task's title, requirements, acceptance criteria AND VERIFY
 * block, and the implementer shipped a fake ambient declare to compile it.
 *
 * Lever: the same verbatim-substring anti-synthesis check as the F3 contract
 * registry. Extract API-shaped identifiers (`Namespace.member`) from the answer;
 * an identifier is SYNTHESIZED when
 *   (a) the full identifier appears nowhere in the research (APIS/docs/context
 *       sections, verbatim substring, case-sensitive) and nowhere in the
 *       question itself, AND
 *   (b) the research DOES mention that namespace's API surface (`Bun.` appears
 *       somewhere) — i.e. research claims coverage of the namespace, so a
 *       member absent from it is suspicious rather than merely uncovered.
 * Gate (b) is the step-aside rule: when research never mentions the namespace
 * at all (React.StrictMode in a task whose research covered no React API), the
 * check is INCONCLUSIVE and must not fire — the guard may only cost time,
 * never work. Same for the clarify-triage seam, whose research slot is a stub:
 * no namespace coverage ⇒ no findings ⇒ guard inert by construction.
 *
 * Caller contract (phaseAutoAnswer): findings ⇒ re-ask ONCE with the research
 * API lines injected (belt); a re-asked answer that still carries a flagged
 * identifier is surfaced to the user as UNKNOWN instead of being promoted.
 */

export interface SynthesizedApiFinding {
    /** The full flagged identifier, e.g. "Bun.mkdirSync". */
    identifier: string
    /** Its namespace, e.g. "Bun" — research mentions `Bun.` but not this member. */
    namespace: string
}

/**
 * `Namespace.member` where the namespace starts uppercase (Bun, React, Deno —
 * the global/imported-namespace API shape; a TP is exactly this) and
 * both sides are ≥2 chars (kills "U.S.", "e.G" prose shapes). Member may start
 * either case: `Bun.mkdirSync` and `React.StrictMode` are both API-shaped.
 */
const API_IDENT_RE = /\b([A-Z][A-Za-z0-9_$]+)\.([A-Za-z_$][A-Za-z0-9_$]+)\b/g

/**
 * Member names that make the match a file name, domain, or version-ish token
 * rather than an API (Node.js, App.tsx, README.md, Fly.io, Express.com). All
 * lowercase-compared, so `INDEX.HTML` is excluded too.
 */
const NON_API_MEMBERS = new Set([
    'js',
    'ts',
    'jsx',
    'tsx',
    'mjs',
    'cjs',
    'mts',
    'cts',
    'json',
    'jsonc',
    'md',
    'html',
    'htm',
    'css',
    'scss',
    'less',
    'svg',
    'png',
    'jpg',
    'jpeg',
    'gif',
    'ico',
    'txt',
    'yml',
    'yaml',
    'toml',
    'lock',
    'map',
    'env',
    'sh',
    'sql',
    'db',
    'sqlite',
    'wasm',
    'node',
    'exe',
    'com',
    'org',
    'net',
    'io',
    'dev',
    'app',
    'ai',
    'co',
    'gg'
])

/** All API-shaped identifiers in a text, deduped, first-seen order. */
export function extractApiIdentifiers(text: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(API_IDENT_RE)) {
        const [full, , member] = m
        if (NON_API_MEMBERS.has(member.toLowerCase())) continue
        if (seen.has(full)) continue
        seen.add(full)
        out.push(full)
    }
    return out
}

/**
 * The synthesized identifiers in an auto-answer: API-shaped, absent from the
 * research and the question, in a namespace the research claims to cover.
 * Verbatim-substring membership — never a model judgement.
 */
export function findSynthesizedApis(
    answer: string,
    question: string,
    research: string
): SynthesizedApiFinding[] {
    const out: SynthesizedApiFinding[] = []
    for (const identifier of extractApiIdentifiers(answer)) {
        if (research.includes(identifier) || question.includes(identifier)) continue
        const namespace = identifier.slice(0, identifier.indexOf('.'))
        // Step-aside gate: research must claim this namespace's API surface.
        if (!research.includes(`${namespace}.`)) continue
        out.push({identifier, namespace})
    }
    return out
}

/** Research lines that mention any flagged namespace — the verified API list to inject. */
function verifiedApiLines(findings: SynthesizedApiFinding[], research: string): string[] {
    const namespaces = new Set(findings.map(f => f.namespace))
    const lines: string[] = []
    for (const line of research.split('\n')) {
        const t = line.trim()
        if (t.length === 0) continue
        for (const ns of namespaces) {
            if (t.includes(`${ns}.`)) {
                lines.push(t)
                break
            }
        }
    }
    return lines.slice(0, 20)
}

/**
 * Re-ask hint (SYSTEM NOTE shape, mirrors GRILL_AUTO_FORMAT_HINT): names the
 * unverified identifiers, injects the research lines that ARE verified for
 * those namespaces, and demands an answer grounded in them — or UNKNOWN.
 */
export function synthesizedApiReaskHint(
    findings: SynthesizedApiFinding[],
    research: string
): string {
    const flagged = findings.map(f => `\`${f.identifier}\``).join(', ')
    const verified = verifiedApiLines(findings, research)
    return (
        `[SYSTEM NOTE: Your previous answer named ${flagged} — NOT present in this task's `
        + 'verified research API list, so it may not exist (a plausible-looking invented API '
        + 'poisons the whole task: it gets promoted into requirements and VERIFY, and the '
        + 'implementation fakes type declarations to compile it). The VERIFIED research lines '
        + 'for that namespace are:\n'
        + verified.map(l => `  ${l}`).join('\n')
        + '\nAnswer again using ONLY APIs from the research or the question. If the behavior '
        + 'needs an API the research does not list, do NOT invent one — describe the behavior '
        + 'without naming a concrete API, or tag UNKNOWN.]'
    )
}
