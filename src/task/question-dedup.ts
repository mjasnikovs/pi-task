/**
 * Detects when a freshly-generated clarifying question is a near-duplicate of one
 * already asked. The clarify/grill loops re-call the generator after every answer
 * and rely on a prompt instruction ("Never re-ask something already answered") to
 * stop repeats. A weaker local model ignores that and re-asks the same fork worded
 * differently (observed: a "Bun bundler vs Vite" question asked four ways across a
 * single run). This is a deterministic backstop so a model that won't self-police
 * can't barrage the user with the same decision.
 *
 * Pure logic, no I/O — trivially unit-testable, and validated against the actual
 * repeated questions from a real /task-auto run (see question-dedup.test.ts).
 */

// Function words plus the boilerplate the prompt makes every question share
// ("should we use", "or should", "this determines whether the task", …). Stripping
// these keeps the comparison on the salient nouns that actually identify a topic
// (vite, bundler, sharp, multer) instead of the scaffolding common to all of them.
const STOPWORDS = new Set([
    'the',
    'a',
    'an',
    'and',
    'or',
    'of',
    'to',
    'in',
    'on',
    'for',
    'with',
    'as',
    'by',
    'at',
    'be',
    'is',
    'are',
    'should',
    'we',
    'use',
    'used',
    'using',
    'it',
    'its',
    'this',
    'that',
    'these',
    'those',
    'into',
    'from',
    'than',
    'then',
    'so',
    'if',
    'whether',
    'which',
    'what',
    'how',
    'do',
    'does',
    'add',
    'added',
    'also',
    'only',
    'just',
    'like',
    'such',
    'them',
    'they',
    'their',
    'there',
    'here',
    'will',
    'would',
    'can',
    'could',
    'instead',
    'rather',
    'either',
    'both',
    'each',
    'all',
    'any',
    'some',
    'more',
    'most',
    'over',
    'up',
    'out',
    'no',
    'not',
    'without',
    'before',
    'after',
    'while',
    'during',
    'team',
    'want',
    'wants',
    'approach',
    'simpler',
    'simple',
    'specified',
    'mentioned',
    'set',
    'sets',
    'task',
    'tasks',
    'whole',
    'entire',
    'single',
    'separate',
    'new',
    'extra',
    'changes',
    'change',
    'determines',
    'critical',
    'because',
    'mode',
    'forks',
    'fork',
    'header',
    'stack',
    'lighter',
    'built'
])

/**
 * Lowercase, drop markdown emphasis/backticks, split on non-alphanumeric, then
 * drop stopwords and 1-char tokens. `pg_trgm` → `pg`,`trgm`; `bun:sql` → `bun`,`sql`.
 */
export function tokenizeQuestion(q: string): Set<string> {
    const cleaned = q.toLowerCase().replace(/\*\*/g, ' ').replace(/`/g, ' ')
    const tokens = cleaned.split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOPWORDS.has(t))
    return new Set(tokens)
}

/** Jaccard similarity of two token sets: |A∩B| / |A∪B|. 0 when either is empty. */
export function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0
    let inter = 0
    for (const t of a) if (b.has(t)) inter++
    const union = a.size + b.size - inter
    return union === 0 ? 0 : inter / union
}

// Validated against the real mx5 run (question-dedup.test.ts): the re-asked
// SPA-build/serve forks scored 0.152 / 0.275 / 0.421 against an earlier question,
// while every genuinely-distinct subsystem question topped out at 0.077. 0.12 sits
// in that gap — above the distinct ceiling, below the lowest true duplicate — so
// it catches the repeats without suppressing a real question.
export const DEFAULT_DUP_THRESHOLD = 0.12

/**
 * True when `next` is a near-duplicate of any question in `prior` (Jaccard of
 * salient tokens ≥ threshold). Compares against the actual question text already
 * asked, so a re-worded re-ask of an already-answered fork is caught.
 */
export function isDuplicateQuestion(
    prior: readonly string[],
    next: string,
    threshold = DEFAULT_DUP_THRESHOLD
): boolean {
    const nextTokens = tokenizeQuestion(next)
    if (nextTokens.size === 0) return false
    return prior.some(p => jaccard(tokenizeQuestion(p), nextTokens) >= threshold)
}

// After this many consecutive near-duplicate questions, the question loop stops:
// a model that can't produce a novel question after being told to move on has
// nothing genuinely new left to ask. Shared by /task-auto's clarify loop and
// /task's grill loop.
export const MAX_DUP_STRIKES = 2

// Reprompt injected when a duplicate is caught — tells the model the topic is
// settled and to either move to a different open fork or finish.
export const DUP_REPROMPT_HINT =
    'You just re-asked a decision that is ALREADY answered above. Do not ask about '
    + 'it again, even reworded. Ask about a DIFFERENT subsystem or fork that remains '
    + 'genuinely open, or output the termination token if nothing decision-changing '
    + 'is left.'
