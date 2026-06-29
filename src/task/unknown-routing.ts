/**
 * Surviving-unknown routing.
 *
 * The grill phase generates one clarifying question per KNOWN-UNKNOWN and lets a
 * `grill-auto` child either auto-answer it (ANSWER → the user never sees it) or
 * surface it (UNKNOWN → asked). The dangerous class is an integration / build-
 * wiring unknown — "how is this plugin wired into the build", "should the import
 * structure in the HTML entry change" — which `grill-auto` happily auto-answers
 * with a GUESS that then ships as a silent landmine (a real run shipped an
 * unstyled build this way).
 *
 * This classifier identifies that class so the orchestrator can route it: try to
 * resolve it from fetched docs first, and if nothing grounded the answer, surface
 * it to the user instead of letting the guess stand. Pure + deterministic so it
 * is unit-tested independently of the model.
 *
 * Deliberately GENERIC: it keys on build/tooling CATEGORIES (plugin, bundler,
 * loader, build pipeline, entry point, …) and wiring INTENT (wire, integrate,
 * configure, set up, how/where to …), never on any specific tool or project.
 */

// Factor A — the question concerns a build/tooling integration surface, not a
// value, a name, an output format, or a file location.
const TOOLING_CONCERN_RE =
    /\b(?:plugins?|bundlers?|loaders?|middlewares?|adapters?|toolchains?|transpilers?|compilers?|build\s+(?:pipeline|step|process|chain|config|tool|system)|import\s+structure|entry[\s-]*points?|dev[\s-]*servers?|module\s+resolution|build\s+wiring|wiring)\b/i

// Factor B — the question is about HOW to connect/configure that surface (or
// expresses uncertainty about where something hooks in), not which value to pick.
const WIRING_INTENT_RE =
    /\b(?:wir(?:e|ed|ing)|integrat(?:e|ed|es|ing|ion)|hook(?:ed|s|ing)?\s+(?:it\s+|them\s+)?(?:up|in|into)|plug(?:ged|s|ging)?\s+(?:it\s+|them\s+)?(?:in|into)|configur(?:e|ed|es|ing|ation)|set[\s-]*up|register(?:ed|s|ing)?|mount(?:ed|s|ing)?|how\s+(?:to|do|does|should|is|are)|where\s+(?:to|should|does|is))\b/i

/**
 * True when `question` is an integration / build-wiring unknown — one whose
 * wrong guess is a structural landmine, so it must be resolved by a worker or
 * surfaced to the user rather than auto-answered. Requires BOTH a tooling-surface
 * mention and wiring intent, so benign questions ("which log format?", "what
 * default page size?", "which file holds the auth handler?") do not trip it.
 */
export function isIntegrationUnknown(question: string): boolean {
    if (!question) return false
    return TOOLING_CONCERN_RE.test(question) && WIRING_INTENT_RE.test(question)
}
