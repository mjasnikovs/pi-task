/**
 * content-tokens — the distinctive words of a phrase, and the one tokenizer that
 * decides them.
 *
 * Two consumers ask the same question of a string and must get the same answer:
 * the coverage guard, which grounds requirement/title ownership in shared
 * distinctive nouns, and the research cache, whose key is the sorted token set of
 * a query so two phrasings of one question share one digest. A second tokenizer
 * would be a second answer.
 */

// Ubiquitous words that carry no coverage signal: they appear across most task
// titles and requirement quotes, so overlap on them would falsely connect a
// requirement to any plan. Stopped so grounding keys on the DISTINCTIVE nouns
// (json, dead-letter, serialize, symlink…) that actually name a deliverable.
//
// Confirmed: titles built only from these words own NOTHING, while titles naming
// `JSON output` and `dead-letter queue` own the matching requirements.
//
// English function words + generic task verbs + generic project nouns — all
// domain-agnostic.
export const CONTENT_STOPWORDS = new Set([
    // function words
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
    'by',
    'at',
    'as',
    'is',
    'are',
    'be',
    'it',
    'its',
    'that',
    'this',
    'from',
    'into',
    'out',
    'up',
    'per',
    'via',
    'not',
    'no',
    'but',
    'if',
    'then',
    'than',
    'so',
    'such',
    'each',
    'any',
    'all',
    'every',
    'when',
    'where',
    'must',
    'should',
    'shall',
    'may',
    'can',
    'will',
    'end',
    'new',
    // generic task verbs
    'add',
    'implement',
    'create',
    'build',
    'scaffold',
    'setup',
    'set',
    'support',
    'handle',
    'apply',
    'use',
    'used',
    'using',
    'make',
    'makes',
    'made',
    'enable',
    'provide',
    'ensure',
    'allow',
    'run',
    'runs',
    'get',
    'gets',
    'define',
    'configure',
    'init',
    'update',
    'manage',
    // generic project nouns
    'cli',
    'tool',
    'app',
    'application',
    'project',
    'feature',
    'task',
    'tasks',
    'user',
    'users',
    'mode',
    'flag',
    'flags',
    'option',
    'options',
    'system',
    'code',
    'thing',
    'things',
    'work'
])

/** Distinctive content tokens of a phrase: lowercased alphanumeric words ≥3 chars,
 *  minus the ubiquitous stopwords. `--json` → `json`, `dead-letter` → `dead`,`letter`.
 *  A single trailing `s` is stripped (len ≥4) so `scan`/`scans`, `file`/`files`,
 *  `serialize`/`serializes` match — plain plural/3rd-person, no full stemmer. */
export function contentTokens(s: string): Set<string> {
    const out = new Set<string>()
    for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 3 || CONTENT_STOPWORDS.has(raw)) continue
        const w =
            raw.length >= 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw
        out.add(w)
    }
    return out
}
