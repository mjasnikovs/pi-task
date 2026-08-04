import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'

/**
 * The tools /task-config offers a command-watchdog toggle for, discovered from
 * the live session rather than named by hand.
 *
 * WHY DISCOVERY AND NOT A HAND-EDITED NAME LIST: the watchdog arms on ANY tool
 * (see task/command-watchdog.ts), which is correct for `bash` — pi's bash takes
 * an OPTIONAL `timeout` with no default, so an unbounded command runs forever —
 * but wrong for an extension tool that already owns a longer, bounded contract
 * of its own. Those tools get aborted mid-transaction at the generic ceiling.
 * The operator has to be able to say "not this one", and the only identity that
 * survives a rename or an uninstall is the one pi itself reports.
 *
 * MEASURED against pi 0.83.0 (`pi.getAllTools()`), not assumed:
 *   - built-ins report `source: "builtin"`, `path: "<builtin:bash>"`
 *   - extension tools report the extension's real entry-point path — the SAME
 *     identity `extensionWhitelist` keys on (see extension-list.ts)
 *   - `getAllTools()` THROWS during extension loading ("Extension runtime not
 *     initialized"); it is only callable from `session_start` onward, which is
 *     why this is read when the menu opens and never at registration.
 *   - `getActiveTools()` is a strict SUBSET (4 of 7 built-ins in a plain
 *     session), so it is the wrong source: a tool the model isn't currently
 *     offered is still a tool the watchdog would arm on if it ran.
 */
export interface GuardableTool {
    /** Exact tool name — the watchdog's key, and what the config stores. */
    name: string
    /** Provenance shown in the menu, e.g. "built in" or "npm:pi-fable". */
    origin: string
}

/** `source` values pi reports for its own tools rather than an extension's. */
const BUILTIN_SOURCE = 'builtin'

/**
 * Human provenance for a tool's source metadata. `source` is pi's own word for
 * where the owner came from ("builtin", "npm:...", "auto", "cli"); the two
 * discovery-shaped values are spelled out because "auto" tells the operator
 * nothing about which extension they are about to unguard.
 */
function toolOrigin(source: string, path: string): string {
    if (source === BUILTIN_SOURCE) return 'built in'
    if (source === 'auto') return `discovered (${path})`
    if (source === 'cli') return `-e flag (${path})`
    return `${source} (${path})`
}

/**
 * Every tool in the live session, built-ins first and each extension's tools in
 * registration order after them, so the menu reads owner-by-owner.
 *
 * Pure over the ToolInfo list so the ordering and labelling are unit-testable
 * without a running pi; {@link listGuardableTools} supplies the live one.
 */
export function toGuardableTools(
    tools: readonly {name: string; sourceInfo: {source: string; path: string}}[]
): GuardableTool[] {
    const builtins: GuardableTool[] = []
    const rest: GuardableTool[] = []
    const seen = new Set<string>()
    for (const t of tools) {
        // A duplicate name cannot be told apart by the watchdog (it only ever
        // sees `toolName`), so a second registration must not add a second row
        // that silently toggles the first one's guard.
        if (seen.has(t.name)) continue
        seen.add(t.name)
        const entry = {name: t.name, origin: toolOrigin(t.sourceInfo.source, t.sourceInfo.path)}
        ;(t.sourceInfo.source === BUILTIN_SOURCE ? builtins : rest).push(entry)
    }
    return [...builtins, ...rest]
}

/**
 * The live tool list, or `[]` if pi cannot answer. Enumeration failing must cost
 * only the per-tool rows, never the whole settings menu — the same contract
 * listInstalledExtensions() has in the command handler.
 */
export function listGuardableTools(pi: ExtensionAPI): GuardableTool[] {
    try {
        return toGuardableTools(pi.getAllTools())
    } catch {
        return []
    }
}
