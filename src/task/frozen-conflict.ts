/**
 * frozen-conflict — deterministic detection of an UNSATISFIABLE spec pair at
 * compose time (mx5 run 12 root cause, PROMPT 1 layer A).
 *
 * The failure this closes: compose authored TASK_0020 with a blanket freeze
 * ("Do not modify `tsconfig.json`, `eslint.config.js`, or `.prettierrc.cjs`;
 * those are handled in steps 1–2") while the deliverable — new
 * `playwright-ct.config.ts` + `playwright/index.ts` — needs exactly that
 * registration edit, and the spec "resolved" the contradiction with prose
 * surrender ("Accept that `playwright-ct.config.ts` will not be covered by
 * `tsc --noEmit` since `tsconfig.json` is not modified in this step"). Typed
 * ESLint does not "accept" anything: the moment the created files land,
 * `bun run lint` hard-errors REPO-WIDE and permanently — and the "owning"
 * steps 1–2 completed long ago, so NO task may ever perform the edit (every
 * spec carries the same freeze). Every subsequent task then burned its
 * unattended AUTOFIX rounds on a repo-health FAIL none of them was allowed to
 * fix, and the eventual "escape" was a child DELETING the deliverables.
 *
 * The contradiction is visible IN THE COMPOSED TEXT ITSELF, so it must die at
 * spec time. Like the skip-escape / synthesized-wiring / plan-contradiction
 * probes (prompt-only rules are A/B-proven ~0–1/5 on the weak model), the
 * detector is deterministic and its finding is FORCED into the critique
 * rewrite: the rewrite must either grant scoped ownership ("MAY edit `X` ONLY
 * to register the files this task creates") or drop the file creation.
 *
 * High-precision by construction (FP-swept over the 26 real mx5 run-12 specs):
 *   - the freeze side must be BLANKET — a `Do NOT modify` line with no
 *     exception clause; a scoped freeze ("MAY edit … ONLY to register",
 *     "Only edit `X` …", "… except to add …") is already the resolution shape
 *     and must never re-fire;
 *   - the statement side is judged per SENTENCE, not per line (real GOALs are
 *     one giant line — line scoping false-fired on `must include` in a
 *     response-shape sentence three paths away from the frozen one);
 *   - a sentence that is itself prohibition-shaped ("Preserve … do not
 *     remove or modify …") is the freeze side restated, never a statement;
 *   - the sentence must NAME the frozen path (pathNamedIn) AND match one of
 *     the measured phrasing families: passive registration ("must also be
 *     included"), unless-added ("won't be type-checked unless added"),
 *     directional active ("requires adding … to" / "must add … to"), or the
 *     prose SURRENDER itself ("will not be covered … since `X` is not
 *     modified" — the exact line the live TASK_0020 spec shipped).
 * Mere co-mention never fires.
 */
import {extractProhibitions, PROHIBITION_RE} from './prohibition-probe.js'
import {pathNamedIn} from './frozen-path-guard.js'

/** One unsatisfiable freeze/requires-edit pair found in a composed spec. */
export interface FrozenPathConflict {
    /** The frozen path (normalized: no leading ./, no trailing /). */
    path: string
    /** The freeze line, verbatim (the `Do NOT modify` constraint). */
    constraint: string
    /** The sentence stating the deliverable requires changing that path
     *  (or surrendering to the consequences of not being allowed to). */
    statement: string
    /** Where the statement was found: the spec's own body, or the task's
     *  research (the compose INPUT — live drafts sometimes drop the research
     *  nuance from the spec text while the contradiction remains real). */
    source: 'spec' | 'research'
}

/**
 * A freeze that carves out its own exception is SCOPED, not blanket — it is
 * exactly the resolution shape the probe demands ("MAY edit `X` ONLY to
 * register…", "Only edit `X` (add the search route)…", "Do not modify `X`
 * except to add…"), so it never counts as the freeze side of a conflict, or
 * the recomposed spec would re-fire forever.
 */
const EXCEPTION_RE =
    /\b(?:except|unless|beyond|other\s+than|apart\s+from|only\s+(?:to|for|if|when|where|edit|modify|change|touch|update)|may\s+(?:edit|modify|change|update|add))\b/i

/** Passive registration: "must (also) be included/added/registered/…". */
const PASSIVE_REG_RE =
    /\b(?:must|needs?\s+to|has\s+to|should)\s+(?:also\s+)?be\s+(?:includ|add|regist|list|referenc|declar|updat)\w*/i

/** "unless (it is) added/included/registered/updated". */
const UNLESS_ADDED_RE =
    /\bunless\s+(?:it\s+is\s+|it'?s\s+|they\s+are\s+|first\s+)?(?:add|includ|regist|updat)\w*/i

/** "won't be type-checked/compiled/linted/covered … unless …". */
const NOT_CHECKED_UNLESS_RE =
    /\b(?:won'?t|will\s+not|cannot|can'?t|does\s+not|doesn'?t|is\s+not|isn'?t)\s+(?:be\s+)?[\w\s-]{0,40}?(?:type-?check|compil|lint|cover|resolv|recogni[sz]|includ|pick)\w*[^;]{0,80}?\bunless\b/i

/** Directional active: "requires adding … to …" / "must add … to/into/in …".
 *  The preposition requirement is what keeps a response-shape "must include
 *  `field`" sentence from counting as a registration edit. */
const REQUIRES_DIRECTIONAL_RE =
    /\brequires?\s+(?:add|includ|regist|updat|edit|modify|chang)\w*[^;]{0,80}?\b(?:to|into|in)\b/i
const MUST_ADD_DIRECTIONAL_RE =
    /\bmust\s+(?:also\s+)?(?:add|includ|regist|updat)\w*[^;]{0,80}?\b(?:to|into|in)\b/i

/** The prose-surrender pair: an artifact "will not be covered/type-checked/…"
 *  BECAUSE the (frozen) path "is not modified". Both halves must be present —
 *  this is the exact contradiction shape the live TASK_0020 spec shipped. */
const NOT_COVERED_RE =
    /\b(?:will\s+not|won'?t|cannot|can'?t|is\s+not|isn'?t)\s+(?:be\s+)?(?:covered|type-?checked|checked|compiled|linted|validated|included)\b/i
const BECAUSE_NOT_MODIFIED_RE =
    /\b(?:since|because|as)\b[^;]{0,80}?\b(?:is\s+|are\s+|was\s+|were\s+)?not\s+(?:be(?:ing)?\s+)?(?:modif|edit|chang|updat|touch)\w*/i

function isRequiresEditStatement(sentence: string): boolean {
    return (
        PASSIVE_REG_RE.test(sentence)
        || UNLESS_ADDED_RE.test(sentence)
        || NOT_CHECKED_UNLESS_RE.test(sentence)
        || REQUIRES_DIRECTIONAL_RE.test(sentence)
        || MUST_ADD_DIRECTIONAL_RE.test(sentence)
        || (NOT_COVERED_RE.test(sentence) && BECAUSE_NOT_MODIFIED_RE.test(sentence))
    )
}

/**
 * Split a spec line into sentences: a `.` or `;` followed by whitespace and a
 * capital/backtick/bracket opener ends a sentence. The opener requirement
 * keeps `e.g. foo` and mid-path dots intact; backtick paths carry no `. ` so
 * they never split. Judging per sentence is what makes one-giant-line GOALs
 * scannable without cross-sentence false fires.
 */
function splitSentences(line: string): string[] {
    return line.split(/[.;]\s+(?=[A-Z`([-])/)
}

interface Blanket {
    path: string
    constraint: string
}

/** Backtick-quoted path-shaped tokens in a sentence (the same shape rule the
 *  prohibition extractor applies), minus surrounding quotes. */
function pathTokensIn(sentence: string): string[] {
    const out: string[] = []
    for (const m of sentence.matchAll(/`([^`]+)`/g)) {
        const token = m[1].trim().replace(/^["']|["']$/g, '')
        if (!/^[\w.@~/-]+$/.test(token)) continue
        if (token.includes('/') || /\.[A-Za-z0-9]+$/.test(token) || token.startsWith('.')) {
            out.push(token)
        }
    }
    return out
}

/** Scan one text's sentences for requires-edit statements naming a blanket
 *  frozen path, appending each new pair to `out`.
 *
 *  `anchorSpec` (research scans only): a research statement counts ONLY when,
 *  besides the frozen path, it names at least one other path that still
 *  appears in the SPEC. That anchor is what makes resolution (b) terminal:
 *  when the rewrite DROPS the file creation, the created file vanishes from
 *  the spec, the research statement about it loses its anchor, and the
 *  detector goes quiet instead of re-firing forever on stale research. */
function scanForStatements(
    text: string,
    blanket: Blanket[],
    source: 'spec' | 'research',
    out: FrozenPathConflict[],
    seen: Set<string>,
    anchorSpec?: string
): void {
    for (const raw of text.split('\n')) {
        for (const fragment of splitSentences(raw)) {
            const sentence = fragment.trim()
            if (sentence.length === 0) continue
            // A prohibition-shaped sentence IS the freeze side (the constraint
            // itself, or a "Preserve/do not remove or modify" restatement) -
            // never the requires-edit side.
            if (PROHIBITION_RE.test(sentence)) continue
            if (!isRequiresEditStatement(sentence)) continue
            for (const p of blanket) {
                if (!pathNamedIn(sentence, p.path)) continue
                if (anchorSpec !== undefined) {
                    const anchors = pathTokensIn(sentence).filter(
                        t => t !== p.path && !pathNamedIn(p.path, t)
                    )
                    if (!anchors.some(a => pathNamedIn(anchorSpec, a))) continue
                }
                const key = `${p.path} ${sentence}`
                if (seen.has(key)) continue
                seen.add(key)
                out.push({path: p.path, constraint: p.constraint, statement: sentence, source})
            }
        }
    }
}

/**
 * Find every unsatisfiable pair in the composed spec: a BLANKET frozen path
 * whose registration/edit is declared necessary by the spec's own body (or
 * explicitly surrendered to), or - when `research` is given - by the task's
 * research the spec was composed FROM. The frozen paths always come from the
 * SPEC alone; research contributes only the statement side (live compose
 * sometimes drops the research's "must also be included" nuance from the spec
 * text while shipping the freeze and the file creation - the contradiction is
 * then visible only across the compose boundary). Deterministic, pure text -
 * the same extraction the live A/B grounds its measurements in, so the model
 * cannot self-report its way past it. Empty on a null spec or one that froze
 * nothing.
 */
export function findFrozenPathConflicts(
    spec: string | null | undefined,
    research?: string | null
): FrozenPathConflict[] {
    if (!spec) return []
    const blanket: Blanket[] = extractProhibitions(spec)
        .filter(p => !EXCEPTION_RE.test(p.constraint))
        .map(p => ({
            path: p.path.replace(/^\.\//, '').replace(/\/+$/, ''),
            constraint: p.constraint
        }))
        .filter(p => p.path.length > 0)
    if (blanket.length === 0) return []
    const out: FrozenPathConflict[] = []
    const seen = new Set<string>()
    scanForStatements(spec, blanket, 'spec', out, seen)
    if (research) scanForStatements(research, blanket, 'research', out, seen, spec)
    return out
}

/**
 * The forced critique-rewrite defect text (skip-escape pattern: MANDATORY,
 * self-contained, names the exact resolution options). The two permitted
 * resolutions come straight from the incident analysis: scoped ownership or
 * dropping the creation — prose acknowledging the gap is called out as a
 * non-resolution because that is precisely what the live model shipped.
 */
export function frozenConflictProbeText(conflicts: FrozenPathConflict[]): string {
    const items = conflicts.map(
        c =>
            `- the spec FREEZES \`${c.path}\` ("${c.constraint.slice(0, 160)}") yet `
            + (c.source === 'research' ?
                `the task's own RESEARCH (the input this spec was composed from) states the `
                + `deliverable REQUIRES changing it ("${c.statement.slice(0, 160)}") — the spec `
                + `omitting this fact does not remove the requirement`
            :   `its own body states the deliverable REQUIRES changing it `
                + `("${c.statement.slice(0, 160)}")`)
    )
    return [
        'UNSATISFIABLE-CONSTRAINT FINDING (deterministic; MUST be resolved, it overrides a CLEAN triage):',
        ...items,
        'This pair is self-contradictory: the files this task creates need a registration edit',
        'that the spec itself forbids, and the step that "owns" the frozen file has already',
        'completed — no task will ever be allowed to perform the edit. The moment the created',
        'files land, the repo-wide static check fails PERMANENTLY and every later task burns',
        'its autofix rounds on a defect none of them may touch. Prose acknowledging the gap',
        '("accept that it will not be covered…") is NOT a resolution.',
        'REWRITE the spec to resolve it in exactly ONE of these two ways:',
        '  (a) SCOPED OWNERSHIP — replace the blanket freeze on the conflicting path with:',
        '      "You MAY edit `<path>` ONLY to register the files this task creates (e.g. add',
        '      them to its include list); any other change to `<path>` is forbidden." Keep the',
        '      blanket freeze for the other frozen paths.',
        '  (b) DROP the creation of the files that would require the frozen edit (and remove',
        '      the acceptance/verify steps that depend on them), stating why.',
        'Never ship both the blanket freeze and the requires-edit statement.'
    ].join('\n')
}
