import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {getKeybindings, SettingsList, visibleWidth, wrapTextWithAnsi} from '@earendil-works/pi-tui'
import type {Component, SettingItem, SettingsListTheme} from '@earendil-works/pi-tui'
import {
    clampToModel,
    supportedThinkingLevels,
    type LadderLevel,
    type ReasoningModelFacts
} from '../shared/reasoning-capability.js'
import {MODEL_INHERIT, splitSpec} from './group-models.js'
import {PairPicker, type PairOptions} from './option-picker.js'
import {registerBridgeCommand} from '../remote/bridge.js'
import {readPkgVersion} from '../shared/pkg-version.js'
import {
    SEARCH_PROVIDERS,
    SEARCH_PROVIDER_LABELS,
    providerForLabel
} from '../workers/search-types.js'
import {
    COMMAND_TIMEOUT_OPTIONS,
    DEBUG_LOG_OPTIONS,
    getConfig,
    sanitizeDebugLogs,
    saveConfig,
    STREAM_INACTIVITY_OPTIONS,
    type PiTaskConfig
} from './config.js'
import {listInstalledExtensions, type InstalledExtension} from './extension-list.js'
import {listGuardableTools, type GuardableTool} from './tool-list.js'
import {
    CHILD_GROUPS,
    REASONING_MODES,
    sanitizeReasoningMode,
    STEP_GROUP_HELP,
    REASONING_SETTINGS,
    effectiveReasoning,
    resolveReasoning,
    type GroupSetting,
    type ChildGroup
} from './reasoning.js'

type Theme = ExtensionCommandContext['ui']['theme']

// Version in the title so a bug report or screenshot says which build it came
// from without anyone having to go look it up.
const CONFIG_TITLE = `pi-task ${readPkgVersion()} settings`

/**
 * Frames a child component (the settings list) in a rounded border with a title
 * woven into the top edge. Without this the overlay's content sits flush against
 * the chat scrollback and reads as just more console text; the border gives it a
 * distinct panel. Layout mirrors {@link renderQuestionBox}'s box chrome: render
 * the child at the inner width, pad each line so the right edge lines up, then
 * frame. Input and invalidation are forwarded straight through to the child.
 */
class BorderedBox implements Component {
    constructor(
        private readonly child: Component & {handleInput(data: string): void},
        private readonly title: string,
        private readonly border: (s: string) => string,
        private readonly titleColor: (s: string) => string,
        /**
         * Body lines to pad out to. The settings list grows and shrinks with the
         * selected item's description, so without a floor the whole panel jumps
         * a few rows every time the cursor moves. Padding to the tallest layout
         * keeps the border still while the contents change.
         */
        private readonly minBodyLines = 0
    ) {}

    render(width: number): string[] {
        const innerWidth = Math.max(1, width - 4) // "│ " + content + " │"
        const dash = (n: number) => '─'.repeat(Math.max(0, n))

        // Top border with the title woven in: "╭─ pi-task settings ─…─╮".
        const tag = ` ${this.title} `
        const lead = 1 // one dash before the title
        const rest = width - 2 - lead - visibleWidth(tag)
        const top =
            rest >= 0 ?
                this.border(`╭${dash(lead)}`) + this.titleColor(tag) + this.border(`${dash(rest)}╮`)
            :   this.border(`╭${dash(width - 2)}╮`)

        // One blank row under the title so the first setting is not welded to
        // the border, then the child, then padding up to the stable height.
        const childLines = this.child.render(innerWidth)
        const raw = ['', ...childLines]
        while (raw.length < this.minBodyLines) raw.push('')

        const body = raw.map(line => {
            const pad = innerWidth - visibleWidth(line)
            const padded = pad > 0 ? line + ' '.repeat(pad) : line
            return this.border('│ ') + padded + this.border(' │')
        })

        const bottom = this.border(`╰${dash(width - 2)}╯`)
        return [top, ...body, bottom]
    }

    invalidate(): void {
        this.child.invalidate()
    }

    handleInput(data: string): void {
        this.child.handleInput(data)
    }
}

/**
 * One /task-config setting, and BOTH directions of its value.
 *
 * `format` renders the stored value for the panel; `apply` parses the chosen
 * label back into it. Both live on the row so adding an enum setting is ONE
 * edit, and a row that renders but cannot parse is impossible to write.
 *
 * With both directions on the row, `format(apply(cfg, v)) === v` is a property
 * over the whole table, and the panel and the non-TUI listing cannot disagree
 * because both read `format`.
 */
export interface ConfigItem {
    /**
     * The row's id. A `keyof PiTaskConfig` for a fixed setting; a prefixed
     * string (`step:`, `tool:`, `ext:`) for a DISCOVERED one.
     *
     * It is `string`, not `keyof PiTaskConfig`, and that is what lets the three
     * dynamic families BE rows instead of bypassing them — so the round-trip
     * property in `config-items.test.ts` covers them through the same row type
     * as the fixed settings.
     */
    id: string
    /**
     * Which titled block of the menu this row sits under. {@link renderRows}
     * walks {@link SECTIONS} and collects the rows claiming each key, so the
     * block order is SECTIONS' order and moving a row between blocks is a
     * one-word edit here.
     */
    section: Section
    label: string
    description: string
    /** Offered values. Omitted for a boolean, which is always on/off. */
    values?: string[]
    /**
     * Rows whose choice is a LIST, not a cycle. Present ⇒ Enter opens a picker
     * instead of stepping `values`.
     *
     * A FUNCTION of the draft config, evaluated at Enter-time, because what a row
     * may offer can depend on another row the user changed while the panel was
     * open: a group's thinking options narrow to what its chosen model declares.
     * `values` stays the STATIC complete vocabulary, because that is what the
     * round-trip property in config-items.test.ts quantifies over.
     */
    picker?: (cfg: PiTaskConfig) => PairOptions
    /** What the panel shows for the current value. */
    format: (cfg: PiTaskConfig) => string
    /** Write the chosen label back. A value it does not recognise is ignored. */
    apply: (cfg: PiTaskConfig, chosen: string) => void
    /**
     * What the headless one-line rendering calls this row, when `label` reads
     * only in the panel. See {@link PanelItem.headlessLabel}.
     */
    headlessLabel?: string
}

/**
 * The titled blocks the settings menu is divided into.
 *
 * One flat list — the fixed settings, one row per reasoning group, one per live
 * tool and one per installed extension — reads as a wall, and the rows that
 * belong together (a mode and the groups it controls; a timeout and the per-tool
 * exemptions from it) end up separated by rows that have nothing to do with
 * them. The headers are inert rows: no `values`, so Enter does nothing on them.
 */
export type Section =
    | 'session'
    | 'checks'
    | 'research'
    | 'profile'
    | 'reasoning'
    | 'timeouts'
    | 'unattended'
    | 'logging'
    | 'extensions'

/** Section order, and the label each header renders. */
export const SECTIONS: ReadonlyArray<{key: Section; title: string}> = [
    {key: 'session', title: 'session'},
    {key: 'checks', title: 'after each task'},
    {key: 'research', title: 'research'},
    // The global override gets its own heading, so it cannot be mistaken for a
    // twelfth step. It is one row, and `renderRows` drops an empty section, so
    // this costs a header and a blank line and nothing else.
    //
    // Both titles are SHORT on purpose. `SettingsList` sizes its label column
    // from the widest item it holds — headers included — so a long heading is
    // taken straight out of every row's value column, and the first thing to
    // fall off the right is the thinking level.
    {key: 'profile', title: 'profile'},
    // ONE block for both dials. They shipped as two parallel blocks of eleven,
    // which put a step's two settings eleven rows apart and hid the coupling
    // between them: choosing a model re-clamps that step's thinking level, and
    // nobody could see it happen.
    {key: 'reasoning', title: 'steps'},
    {key: 'unattended', title: 'unattended'},
    {key: 'logging', title: 'logging'},
    {key: 'extensions', title: 'child extensions'},
    // Last on purpose. It is the longest block (a fixed timeout plus one row
    // per live tool, so it grows with the host) and the least often changed.
    {key: 'timeouts', title: 'timeouts'}
]

/** Marks a header row, so onChange can ignore one and tests can find them. */
export const SECTION_ID_PREFIX = 'section:'

/**
 * Is this row scenery rather than a setting?
 *
 * Reads the ID, not `values`. Those two agreed only while every real row cycled
 * a list: a picker row has a `submenu` and may carry `values` purely for the
 * round-trip contract, so "no values" stopped meaning "not a row". Both
 * `sectionHeader` and `sectionGap` already stamp the prefix, so this is exact
 * rather than a heuristic, and all three consumers ask the same question.
 */
export const isSectionRow = (item: {id: string}): boolean => item.id.startsWith(SECTION_ID_PREFIX)

/**
 * An inert titled row. No `values` ⇒ SettingsList's Enter handler no-ops on it,
 * and {@link SkipInertRows} steps the cursor straight over it.
 *
 * Upper case, and styled muted by {@link makeTheme}, so a heading does not read
 * as one more setting row.
 */
function sectionHeader(title: string): PanelItem {
    return {
        id: SECTION_ID_PREFIX + title,
        label: title.toUpperCase(),
        description: '',
        currentValue: ''
    }
}

/**
 * A blank row between two sections.
 *
 * `SettingsList` renders exactly one line per item, so the only way to put air
 * above a heading is to hand it an empty row. It carries the header prefix so
 * everything that already treats a header as scenery — the inert check, the
 * cursor skip, the headless rendering — covers it with no second rule.
 */
function sectionGap(title: string): PanelItem {
    return {id: `${SECTION_ID_PREFIX}gap:${title}`, label: '', description: '', currentValue: ''}
}

/**
 * The shared pair for a boolean setting: shown as on/off, stored as a boolean.
 * Every non-enum row uses this, so a boolean cannot be given a bespoke parser by
 * accident.
 */
function booleanItem(
    section: Section,
    id: keyof PiTaskConfig,
    label: string,
    description: string
): ConfigItem {
    return {
        id,
        section,
        label,
        description,
        format: cfg => (cfg[id] ? 'on' : 'off'),
        apply: (cfg, chosen) => {
            ;(cfg as unknown as Record<string, boolean>)[id] = chosen === 'on'
        }
    }
}

/**
 * Every setting rendered by /task-config, in display order.
 *
 * Exported so the round-trip property in `config-items.test.ts` can be asserted
 * over the WHOLE table rather than per setting.
 */
export const ITEMS: ConfigItem[] = [
    booleanItem(
        'session',
        'remote',
        'remote control',
        'Serve the task UI on your local network so you can follow and steer a run from '
            + 'your phone. Prints a QR code to scan when it starts'
    ),
    booleanItem(
        'checks',
        'autoCommit',
        'auto-commit',
        'Make a git commit before and after every sub-task, so each step is a checkpoint '
            + 'you can read back or roll back to'
    ),
    booleanItem(
        'checks',
        'verifyWork',
        'verify work',
        'When a task says it is done, actually run the checks its spec asks for and report '
            + "PASS or FAIL instead of taking the model's word for it. This is also what lets "
            + '"enforce guidelines" fix things safely. /task waits for the work to finish'
    ),
    booleanItem(
        'checks',
        'enforceGuidelines',
        'enforce guidelines',
        'Check what each task committed against your AGENTS.md / CLAUDE.md rules. With '
            + '"verify work" on it also fixes what it finds, undoing any fix that breaks the '
            + 'checks; on its own it only reports. /task waits for the work to finish'
    ),
    booleanItem(
        'research',
        'orientation',
        'project tour',
        'Show the research workers the shape of the project first — package manifest, '
            + 'types, schema — so they spend their steps on the question instead of on finding '
            + 'their way around'
    ),
    booleanItem(
        'research',
        'parallelResearchWorkers',
        'parallel research',
        'Run the 4 research workers at once instead of one after another. Only faster if '
            + 'your model backend can answer several requests at the same time — on a single '
            + 'local GPU it is measurably slower, so leave it off there'
    ),
    booleanItem(
        'research',
        'researchCache',
        'research cache',
        'Remember docs and web pages for the length of one run, so later tasks reuse what '
            + 'the first one already fetched instead of downloading it again. Only external '
            + 'sources, only successful fetches, and it is dropped when the run ends'
    ),
    {
        id: 'searchProvider',
        section: 'research',
        label: 'search engine',
        description:
            'Which engine backs web search. Exa and DuckDuckGo work with no setup; Brave needs '
            + 'a BRAVE_SEARCH_API_KEY in your environment',
        // Display full engine names; the stored config value stays the short id.
        values: SEARCH_PROVIDERS.map(p => SEARCH_PROVIDER_LABELS[p]),
        format: cfg => SEARCH_PROVIDER_LABELS[cfg.searchProvider],
        apply: (cfg, chosen) => {
            const provider = providerForLabel(chosen)
            if (provider) cfg.searchProvider = provider
        }
    },
    {
        id: 'requestTimeoutMs',
        section: 'timeouts',
        label: 'command timeout',
        description:
            'Give up on any single command that runs this long, and tell the model to set its '
            + 'own timeout next time. Stops a run from waiting forever on a dev server or a '
            + 'hung build. Covers the main session and the checking steps; "off" lets a stuck '
            + 'command hang the run until you notice',
        // Display human labels; the stored config value stays the ms number.
        values: COMMAND_TIMEOUT_OPTIONS.map(o => o.label),
        format: cfg =>
            COMMAND_TIMEOUT_OPTIONS.find(o => o.ms === cfg.requestTimeoutMs)?.label
            ?? `${cfg.requestTimeoutMs}ms`,
        apply: (cfg, chosen) => {
            const opt = COMMAND_TIMEOUT_OPTIONS.find(o => o.label === chosen)
            if (opt) cfg.requestTimeoutMs = opt.ms
        }
    },
    {
        id: 'streamInactivityMs',
        section: 'timeouts',
        label: 'stuck reply retry',
        description:
            'Give up on a model reply that has sent nothing for this long and ask again. A '
            + 'dropped connection looks exactly like a model thinking hard and reports no '
            + 'error, so a run can sit dead for hours. Only total silence counts, and the clock '
            + 'pauses while a command runs — local models go quiet for minutes on long prompts, '
            + 'so leave room',
        // Display human labels; the stored config value stays the ms number.
        values: STREAM_INACTIVITY_OPTIONS.map(o => o.label),
        format: cfg =>
            STREAM_INACTIVITY_OPTIONS.find(o => o.ms === cfg.streamInactivityMs)?.label
            ?? `${cfg.streamInactivityMs}ms`,
        apply: (cfg, chosen) => {
            const opt = STREAM_INACTIVITY_OPTIONS.find(o => o.label === chosen)
            if (opt) cfg.streamInactivityMs = opt.ms
        }
    },
    booleanItem(
        'unattended',
        'yoloMode',
        'yolo mode',
        'Stop asking you anything: every question takes the option pi recommends, a failed '
            + 'check is accepted and written down as debt, and a failed final check is retried '
            + 'until the budget runs out. Each auto-answer is marked (YOLO) in the task file. '
            + 'For throwaway projects you are not watching'
    ),
    {
        id: 'reasoningMode',
        // Its OWN section, above the per-step block it governs. Sitting inside
        // that block it read as a twelfth step called `reasoning` — a global
        // override disguised as one more per-step row.
        section: 'profile',
        label: 'profile',
        description:
            'How much every step below thinks, in one word. "default" uses the per-step '
            + 'table pi-task has measured, "on" and "off" force one answer everywhere and '
            + 'IGNORE the rows below, and "custom" is whatever those rows say. They always '
            + 'show what each step actually runs at, so changing one switches this to '
            + 'custom. A step left on "inherit" uses whatever thinking level pi itself is '
            + 'set to, which is what every step did before this setting existed',
        values: [...REASONING_MODES],
        format: cfg => String(cfg.reasoningMode),
        apply: (cfg, chosen) => {
            cfg.reasoningMode = sanitizeReasoningMode(chosen)
        }
    },
    {
        id: 'debugLogs',
        section: 'logging',
        label: 'debug logs',
        description:
            'How much of a run gets written to .pi-tasks/*-debug.log. "events" keeps the '
            + 'decisions and the guard actions — what a checking step changed, why something '
            + 'failed — a few lines per task. "full" adds everything the model said and every '
            + 'command it ran, which is most of the size and only useful while you are digging '
            + 'into a problem. "off" writes nothing, and nothing can be reconstructed later',
        values: [...DEBUG_LOG_OPTIONS],
        // The stored value IS the label here, but it still goes through the
        // sanitizer rather than being written raw.
        format: cfg => String(cfg.debugLogs),
        apply: (cfg, chosen) => {
            cfg.debugLogs = sanitizeDebugLogs(chosen)
        }
    }
]

/**
 * One /task-config toggle per installed host extension (GitHub issue #4).
 * The id carries the entry path behind a prefix so the shared onChange handler
 * can tell an extension toggle from a PiTaskConfig field.
 */
const EXT_ID_PREFIX = 'ext:'

export function extensionItems(extensions: InstalledExtension[]): ConfigItem[] {
    return extensions.map(e => ({
        id: EXT_ID_PREFIX + e.path,
        section: 'extensions' as Section,
        label: `ext: ${e.label}`,
        description:
            `Load this ${e.origin} extension in the helper sessions pi-task spawns. They run `
            + 'with extensions off by default, so turn this on when the extension provides the '
            + 'model they need (pi-lmstudio, for example). They also inherit its tools and '
            + `hooks, so only enable ones you trust. ${e.path}`,
        values: ['on', 'off'],
        format: cfg => (cfg.extensionWhitelist.includes(e.path) ? 'on' : 'off'),
        apply: (cfg, chosen) => {
            if (chosen !== 'on' && chosen !== 'off') return
            cfg.extensionWhitelist = applyExtensionToggle(
                cfg.extensionWhitelist,
                e.path,
                chosen === 'on'
            )
        }
    }))
}

/** Apply an extension toggle to the config's whitelist (idempotent both ways). */
export function applyExtensionToggle(
    whitelist: readonly string[],
    entryPath: string,
    on: boolean
): string[] {
    const rest = whitelist.filter(p => p !== entryPath)
    return on ? [...rest, entryPath] : rest
}

/**
 * One /task-config toggle per tool in the live session, so the command watchdog
 * can be turned off for a single tool without unguarding `bash` with it.
 *
 * The list is DISCOVERED (see tool-list.ts), never typed: the id carries the
 * exact tool name pi reports, which is the same string the watchdog matches on.
 * A tool that is uninstalled simply stops being listed, and a stale name left in
 * the config matches nothing.
 */
const TOOL_ID_PREFIX = 'tool:'

export function toolItems(tools: readonly GuardableTool[]): ConfigItem[] {
    return tools.map(t => ({
        id: TOOL_ID_PREFIX + t.name,
        section: 'timeouts' as Section,
        label: `watch: ${t.name}`,
        description:
            `Apply the command timeout to this tool. Leave it on unless the tool runs its own `
            + `bounded, cancellable work for longer than the timeout — turning it off means a `
            + `genuine hang in this tool will never be caught, and nothing else is watching `
            + `while a tool runs. ${t.origin}`,
        values: ['on', 'off'],
        // Stored inverted: the config records the EXEMPTIONS, so an empty list
        // (and any tool pi-task has never heard of) stays guarded by default.
        format: cfg => (cfg.commandTimeoutExemptTools.includes(t.name) ? 'off' : 'on'),
        apply: (cfg, chosen) => {
            if (chosen !== 'on' && chosen !== 'off') return
            cfg.commandTimeoutExemptTools = applyToolToggle(
                cfg.commandTimeoutExemptTools,
                t.name,
                chosen === 'on'
            )
        }
    }))
}

/** Apply a per-tool watchdog toggle to the exemption list (idempotent both ways). */
export function applyToolToggle(
    exempt: readonly string[],
    toolName: string,
    watched: boolean
): string[] {
    const rest = exempt.filter(n => n !== toolName)
    return watched ? rest : [...rest, toolName]
}

/**
 * One /task-config row per reasoning group, so a group's thinking level can be
 * set without hand-editing config.json.
 *
 * SHOWN IN EVERY MODE, not only `custom`. Two reasons, and the second is the
 * real one:
 *  - {@link createSettingsPanel} pads the box to a height computed from the
 *    descriptions it was handed, so rows that appear and vanish would leave the
 *    box sized for the wrong list.
 *  - The value displayed is what the group ACTUALLY runs at — resolveReasoning,
 *    not the stored custom table. In mode `off` every row reads `off` even
 *    though the custom table underneath is untouched, which is the honest
 *    answer to "what will my next child do".
 */
const STEP_ID_PREFIX = 'step:'

/**
 * The label for one step row.
 *
 * A group whose name carries a colon is a CHILD of the group before the colon —
 * `research:files` is one of the four workers `research` fans out to. Rendered
 * flat, those four read as four more peers of `research`, and the menu's one
 * genuine hierarchy is invisible: the four are the only rows in the list whose
 * parent is also a row.
 *
 * So a child is drawn as a tree branch under its parent and loses the repeated
 * `research:` prefix, the same text at the head of four consecutive lines. `└─`
 * on the last child, `├─` on the rest, decided from the group's position in
 * {@link CHILD_GROUPS} rather than a hand-kept list — adding a fifth worker
 * moves the corner on its own.
 *
 * A parentless group is its own bare name. It carried a `think: ` prefix while
 * there were two families to tell apart; with one row per step there is nothing
 * to disambiguate, and the prefix was the widest thing in the column.
 *
 * Leading spaces survive: SettingsList pads the label right, never trims it.
 */
export function stepRowLabel(group: ChildGroup): string {
    const colon = group.indexOf(':')
    if (colon < 0) return group
    const parent = group.slice(0, colon)
    const nextIsSibling = CHILD_GROUPS[CHILD_GROUPS.indexOf(group) + 1]?.startsWith(`${parent}:`)
    return `   ${nextIsSibling ? '├─' : '└─'} ${group.slice(colon + 1)}`
}

/**
 * What this machine can offer a model row, and what each offer can DO.
 *
 * `facts` is what lets the thinking rows narrow: a group pinned to a
 * `reasoning: false` model may only be offered `off`. It answers `undefined` for
 * a spec it cannot resolve — a vanished model, or `inherit` before a session
 * exists — and every consumer reads that as "offer everything", which is exactly
 * today's behaviour.
 */
export interface ModelCatalog {
    /** Offerable `provider/id` specs, without `inherit`. */
    specs: readonly string[]
    /** Human note per spec, e.g. an extension-provided provider's warning. */
    note?: (spec: string) => string | undefined
    facts: (spec: string) => ReasoningModelFacts | undefined
}

/** No registry reachable. Every row still renders; nothing narrows. */
export const EMPTY_CATALOG: ModelCatalog = {specs: [], facts: () => undefined}

/**
 * The levels a row may offer, given the model that row's group will run on.
 *
 * The INTERSECTION with `REASONING_SETTINGS`, not `supportedThinkingLevels`
 * directly: that returns the whole ladder including `xhigh` and `max`, which
 * this menu excludes on purpose (see reasoning.ts) because pi's own UI may not
 * offer them. A model declaring `xhigh` must not smuggle it in here.
 */
export function offeredLevels(facts: ReasoningModelFacts | undefined): GroupSetting[] {
    if (facts === undefined) return [...REASONING_SETTINGS]
    const supported = supportedThinkingLevels(facts)
    return REASONING_SETTINGS.filter(s => s === 'inherit' || supported.includes(s as LadderLevel))
}

/** The separator between a step row's two halves. */
const PAIR_SEP = ' \u00b7 '

/**
 * `level · provider/id`, the one string a step row shows and accepts.
 *
 * THE LEVEL COMES FIRST, and that is a display decision with teeth.
 * `SettingsList` truncates a value from the RIGHT, so whatever is last is what
 * silently disappears — and a real local model id (`local/Qwen3.8-27B-UD-Q4_K_XL
 * .gguf`) is wide enough to consume the whole column on its own. Level-first
 * means the half that falls off is the one still identifiable from its head, and
 * the levels line up as a column you can read down.
 */
export function formatStepValue(spec: string, level: GroupSetting): string {
    return `${level}${PAIR_SEP}${spec}`
}

/**
 * The two halves back out, or `undefined` for anything not of that shape.
 *
 * Split on the FIRST separator, because the level leads and is a closed set,
 * while a `provider/id` could conceivably contain one.
 */
export function parseStepValue(value: string): {spec: string; level: GroupSetting} | undefined {
    const at = value.indexOf(PAIR_SEP)
    if (at <= 0) return undefined
    const level = value.slice(0, at)
    const spec = value.slice(at + PAIR_SEP.length)
    if (spec === '' || !REASONING_SETTINGS.includes(level as GroupSetting)) return undefined
    return {spec, level: level as GroupSetting}
}

/**
 * One row per step, carrying BOTH dials.
 *
 * They were two parallel blocks of eleven, and the coupling between them was
 * invisible: choosing a model re-clamps that step's thinking level, but the row
 * that moved was eleven rows away from the row you touched. One row shows the
 * pair, and the two-step picker shows the clamp happening.
 *
 * `values` is the LEGAL cross product — every model against only the levels that
 * model declares. Nothing renders it: the picker offers two short lists, and the
 * round-trip property in config-items.test.ts is its only reader. Building it
 * from `offeredLevels` rather than the full ladder is what makes the property
 * true, because a pair the model cannot honour would be clamped by `apply` and
 * would not round-trip.
 */
export function stepItems(catalog: ModelCatalog = EMPTY_CATALOG): ConfigItem[] {
    const specs = [MODEL_INHERIT, ...catalog.specs]
    return CHILD_GROUPS.map(group => ({
        id: STEP_ID_PREFIX + group,
        section: 'reasoning' as Section,
        label: stepRowLabel(group),
        headlessLabel: `step: ${group}`,
        description: STEP_GROUP_HELP[group],
        values: specs.flatMap(spec =>
            offeredLevels(catalog.facts(spec)).map(level => formatStepValue(spec, level))
        ),
        // Built at ENTER-time from the LIVE draft, not when the rows were made:
        // stage two narrows to the model chosen in stage one, and the user can
        // have changed another row since the panel opened.
        picker: cfg => stepPicker(group, cfg, catalog),
        // The model half VERBATIM even when the catalog no longer offers it — the
        // vanished-model case, where the row is the only place the user can see
        // what their config actually holds. The thinking half is the EFFECTIVE
        // level, not the stored cell: in mode default/on/off the stored table is
        // not what runs, and a row showing a value the run does not use is worse
        // than no row.
        format: cfg => formatStepValue(cfg.groupModels[group], resolveReasoning(group, cfg)),
        apply: (cfg, chosen) => applyStepValue(cfg, group, chosen, catalog)
    }))
}

/**
 * The two lists behind one step row.
 *
 * Stage two is where the coupling becomes visible. It offers only the levels the
 * chosen model declares, and it OPENS on the level that will actually run — the
 * current one when that model can honour it, otherwise the clamp, with the
 * reason written beside it. Picking a model that cannot think is therefore not a
 * silent downgrade discovered later; it is the option the cursor is already on.
 */
function stepPicker(group: ChildGroup, cfg: PiTaskConfig, catalog: ModelCatalog): PairOptions {
    const held = cfg.groupModels[group]
    // The row's CURRENT model leads stage one when the catalog cannot offer it.
    // Without this, opening the row to nudge only the level would silently
    // rewrite the model to `inherit`: `FilterList` falls back to index 0 when
    // the preselect matches nothing, and the two dials are one row now, so there
    // is no way to touch the level without confirming a model. That would erase
    // a spec set on the user's other machine — the one thing the loader, the
    // format function and the startup hint all go out of their way to preserve.
    const missing = held !== MODEL_INHERIT && !catalog.specs.includes(held)
    return {
        first: [
            ...(missing ?
                [{value: held, label: held, description: 'not available here — kept as-is'}]
            :   []),
            {value: MODEL_INHERIT, label: MODEL_INHERIT, description: "pi's own default"},
            ...catalog.specs.map(spec => ({
                value: spec,
                label: spec,
                ...(catalog.note?.(spec) === undefined ? {} : {description: catalog.note(spec)!})
            }))
        ],
        second: spec => {
            const facts = catalog.facts(spec)
            const offered = offeredLevels(facts)
            const wanted = resolveReasoning(group, cfg)
            const clamped =
                facts === undefined || wanted === 'inherit' ?
                    wanted
                :   (clampToModel(facts, wanted) as GroupSetting)
            // Back inside the menu's own vocabulary. `clampToModel` walks UP
            // first and knows the whole ladder, so a model declaring `xhigh`
            // can land on a level `offeredLevels` deliberately excludes — and
            // then stage two would open on `inherit` with the explanation
            // attached to no row at all.
            const runs = offered.includes(clamped) ? clamped : (offered.at(-1) ?? 'inherit')
            return {
                options: offered.map(level => ({
                    value: level,
                    label: level,
                    ...(level === runs && runs !== wanted ?
                        {description: `${spec} cannot do ${wanted}`}
                    :   {})
                })),
                preselect: runs
            }
        },
        firstOf: value => parseStepValue(value)?.spec ?? value,
        join: (spec, level) => formatStepValue(spec, level as GroupSetting)
    }
}

/**
 * Write both halves of a step row, atomically.
 *
 * Atomically matters for the round-trip property, which starts from a FRESH
 * config every iteration: a value that wrote only one half would leave the other
 * at its default and render as something else.
 *
 * The level is re-clamped even though the picker only ever offers legal pairs.
 * The picker is not the only door — `values` is built when the panel opens, and
 * a registry that moved underneath it would otherwise let an unhonourable level
 * through.
 */
export function applyStepValue(
    cfg: PiTaskConfig,
    group: ChildGroup,
    chosen: string,
    catalog: ModelCatalog
): void {
    const pair = parseStepValue(chosen)
    if (pair === undefined) return
    // MEMBERSHIP, not just shape: the panel may only ever write what the picker
    // showed. That is `inherit`, the catalog's own specs, and — when the catalog
    // cannot offer it — the spec this cell ALREADY holds, which stage one keeps
    // at its head precisely so the level can be changed without discarding it.
    // Re-writing the value that is already there is not a new unresolvable spec.
    if (
        pair.spec !== MODEL_INHERIT
        && pair.spec !== cfg.groupModels[group]
        && !catalog.specs.includes(pair.spec)
    ) {
        return
    }
    cfg.groupModels = {...cfg.groupModels, [group]: pair.spec}
    const facts = catalog.facts(pair.spec)
    const level =
        facts === undefined || pair.level === 'inherit' ?
            pair.level
        :   (clampToModel(facts, pair.level) as GroupSetting)
    // Only when it MOVES something: `applyReasoningLevel` flips the whole table
    // to `custom`, and picking a pair the config already runs must not do that
    // as a side effect.
    if (level !== resolveReasoning(group, cfg)) applyReasoningLevel(cfg, group, level)
}

/**
 * Apply one group row's new value.
 *
 * Setting any group necessarily means "custom" — there is nowhere else to store
 * a per-group choice. The seeding step is what stops that from being a trap: on
 * the way out of `default`/`on`/`off` every OTHER group is first pinned to the
 * level it was already running at, so changing one row changes one row. Without
 * it, nudging `research` while in `off` would silently return every other group
 * to whatever the stored table happened to hold.
 */
export function applyReasoningLevel(cfg: PiTaskConfig, group: ChildGroup, chosen: string): void {
    if (!REASONING_SETTINGS.includes(chosen as GroupSetting)) return
    if (cfg.reasoningMode !== 'custom') {
        // Freeze the table exactly as it runs today, then switch to custom, so
        // opening one row cannot silently move the rest.
        cfg.reasoningLevels = effectiveReasoning(cfg)
        cfg.reasoningMode = 'custom'
    }
    cfg.reasoningLevels = {...cfg.reasoningLevels, [group]: chosen as GroupSetting}
}

/** Overlay width; the list gets `- 4` of it, the description `- 4` again. */
const OVERLAY_WIDTH = 68
/** Settings rows shown at once before the list scrolls. */
const MAX_VISIBLE = 11

/**
 * Tallest body the settings list can render, so {@link BorderedBox} can pad
 * every frame to it and hold the border still. Mirrors SettingsList's own
 * layout: one pad row, the visible rows, the scroll counter, a blank, the
 * selected item's wrapped description, a blank, the key hint.
 */
export function settingsBodyHeight(
    descriptions: string[],
    maxVisible: number,
    wrapWidth: number
): number {
    const tallestDescription = Math.max(
        0,
        ...descriptions.map(d => wrapTextWithAnsi(d, wrapWidth).length)
    )
    return 1 + maxVisible + 1 + 1 + tallestDescription + 1 + 1
}

function makeTheme(theme: Theme, isHeader: (label: string) => boolean): SettingsListTheme {
    return {
        label: (text, selected) => {
            // Headers are scenery, so they are rendered quieter than the rows
            // they title rather than louder. `isHeader` is asked by text
            // because SettingsListTheme only ever sees the padded label —
            // matching on the text is what keeps the styling in one place
            // instead of pre-colouring the string back in panelItems, which
            // has no theme to colour it with.
            if (isHeader(text)) return theme.fg('muted', theme.bold(text))
            return selected ? theme.fg('accent', theme.bold(text)) : theme.fg('text', text)
        },
        // A filled/hollow dot makes the on/off column scannable at a glance
        // without reading a word on every row. Enum values (an engine name, a
        // duration) are real content, so they stay readable rather than muted.
        value: (text, selected) => {
            if (text === 'on') return theme.fg('success', '● on')
            if (text === 'off') return theme.fg('dim', '○ off')
            return theme.fg(selected ? 'accent' : 'muted', text)
        },
        description: text => theme.fg('muted', text),
        // Two cells wide to match the unselected row's "  " indent — a
        // single-cell cursor shifts the selected label one column left.
        cursor: theme.fg('accent', '❯') + ' ',
        hint: text => theme.fg('dim', text)
    }
}

/** A settings row as {@link SettingsList} wants it. */
export type PanelItem = {
    id: string
    label: string
    description: string
    currentValue: string
    /**
     * The values a cycling row steps through. A section header carries none.
     *
     * It is NOT what marks a header any more — {@link isSectionRow} reads the id
     * for that. A model row legitimately has both a `values` list and a
     * `submenu`, so "no values" and "not a row" stopped being the same fact the
     * moment pickers existed.
     */
    values?: string[]
    /**
     * Enter-time options for a picker row, already closed over the draft config
     * by {@link renderRows}.
     *
     * Deliberately NOT called `submenu`: pi-tui's `SettingItem.submenu` is a
     * COMPONENT FACTORY, and a PanelItem is handed to `SettingsList` directly by
     * tests and by the headless path. Two different things under one name would
     * make PanelItem stop being assignable to SettingItem, for no gain.
     * {@link createSettingsPanel} is where a theme exists, so it is where these
     * options become a component.
     */
    pickerOptions?: () => PairOptions
    /**
     * What the headless one-line rendering calls this row, when `label` reads
     * only in the panel. A tree branch means nothing on a line of `|`-joined
     * rows: `├─ files` there names no parent, where `step: research:files`
     * does. Set by the step rows; every other row leaves it off and its `label`
     * is used.
     */
    headlessLabel?: string
}

/** The arrow key SettingsList moves down on, under the default bindings. */
const DOWN_KEY = '\x1b[B'

/**
 * Moves the cursor over the section headers and the blank rows between them.
 *
 * Those rows are decoration: they carry no `values`, so Enter already does
 * nothing on them. Without this they were still stops on the way down — a
 * heading AND a blank line for every section — and the panel opens with the
 * cursor parked on a heading that has no description to show.
 *
 * It drives the list through its own public `handleInput` — pressing the very
 * key the user pressed, N times — rather than reaching for the private
 * `selectedIndex`. With search off, up and down are the only two things that
 * move that index — EXCEPT while a submenu is open, when `SettingsList` forwards
 * everything to the submenu and returns without moving it at all. So a picker
 * suspends this entirely; see `suspended`.
 */
class SkipInertRows implements Component {
    private index = 0

    constructor(
        private readonly list: SettingsList,
        /** True where a row can be selected, in the list's own order. */
        private readonly selectable: boolean[],
        /**
         * True while a picker is open. The list then owns every key, so this
         * must not intercept — see the flag's own comment in
         * {@link createSettingsPanel}. Defaulted so the constructor's own
         * opening walk, and every existing test, are unaffected.
         */
        private readonly suspended: () => boolean = () => false
    ) {
        // The first row is a header, so the panel would open on it. Only
        // synthesise the keypress if it is actually bound to "down" — feeding
        // a key the list ignores would move the mirror and not the cursor.
        if (!getKeybindings().matches(DOWN_KEY, 'tui.select.down')) return
        while (this.index < selectable.length && !selectable[this.index]) {
            this.list.handleInput(DOWN_KEY)
            this.index++
        }
    }

    render(width: number): string[] {
        return this.list.render(width)
    }

    invalidate(): void {
        this.list.invalidate()
    }

    handleInput(data: string): void {
        const kb = getKeybindings()
        const step =
            this.suspended() ? 0
            : kb.matches(data, 'tui.select.down') ? 1
            : kb.matches(data, 'tui.select.up') ? -1
            : 0
        if (step === 0) {
            this.list.handleInput(data)
            return
        }
        const n = this.selectable.length
        let target = this.index
        for (let moved = 1; moved <= n; moved++) {
            target = (target + step + n) % n
            if (this.selectable[target]) {
                for (let i = 0; i < moved; i++) this.list.handleInput(data)
                this.index = target
                return
            }
        }
        // Every row is scenery. Nothing to select, so nothing to move.
    }
}

/**
 * Builds the framed settings panel. Split out of the command handler so the
 * exact component the overlay shows can be rendered to a string in a test or a
 * preview script, rather than only being inspectable by opening the TUI.
 */
export function createSettingsPanel(
    items: PanelItem[],
    theme: Theme,
    /**
     * Called with the row's id, its new value, and the LIST ITSELF.
     *
     * The list is handed back because some rows change what OTHER rows display:
     * flipping `profile` to off means every `step:` row now runs at off, and a
     * row's `currentValue` is a snapshot taken when the panel was built. Without
     * a way to write the others back, the menu would show `profile off` beside
     * rows still claiming `inherit`.
     */
    onChange: (id: string, newValue: string, list: SettingsList) => void,
    onCancel: () => void
): BorderedBox {
    const headerLabels = new Set(items.filter(isSectionRow).map(i => i.label))
    /**
     * True while a picker is open, so SkipInertRows stops intercepting arrows.
     *
     * `SettingsList.handleInput` delegates to an open submenu and RETURNS, so
     * `selectedIndex` never moves while one is up. SkipInertRows keeps its own
     * mirror of that index and replays the key once per row it skips — so
     * without this flag, one arrow press inside a picker moves the mirror off
     * the real cursor AND arrives in the picker two or three times when the walk
     * crosses a section boundary.
     */
    let submenuOpen = false
    const settingItems: SettingItem[] = items.map(({pickerOptions, ...row}) =>
        pickerOptions === undefined ? row : (
            {
                ...row,
                submenu: (currentValue, done) => {
                    submenuOpen = true
                    return new PairPicker(pickerOptions(), currentValue, theme, v => {
                        submenuOpen = false
                        done(v)
                    })
                }
            }
        )
    )
    const list: SettingsList = new SettingsList(
        settingItems,
        MAX_VISIBLE,
        makeTheme(theme, label => headerLabels.has(label.trimEnd())),
        (id, newValue) => onChange(id, newValue, list),
        onCancel
    )
    return new BorderedBox(
        new SkipInertRows(
            list,
            items.map(
                i =>
                    !isSectionRow(i)
                    && ((i.values?.length ?? 0) > 0 || i.pickerOptions !== undefined)
            ),
            () => submenuOpen
        ),
        CONFIG_TITLE,
        s => theme.fg('borderMuted', s),
        s => theme.fg('accent', theme.bold(s)),
        settingsBodyHeight(
            items.map(i => i.description),
            MAX_VISIBLE,
            OVERLAY_WIDTH - 8
        )
    )
}

/**
 * Every settings row for this session, fixed and DISCOVERED, in menu order.
 *
 * One list of `ConfigItem`s — so a row's display, its write-back and its section
 * are one object, the dispatch is a lookup by id, and the round-trip properties
 * in `config-items.test.ts` cover the reasoning, tool and extension families
 * through the same row type as everything else.
 *
 * Fixed rows come before discovered ones within a section, so a freshly
 * installed extension appends rather than reshuffling the menu.
 */
export function configRows(
    installed: InstalledExtension[],
    tools: readonly GuardableTool[] = [],
    // A third positional with a default, exactly like `tools`, so every existing
    // test stays deterministic and no test has to know a registry exists.
    catalog: ModelCatalog = EMPTY_CATALOG
): ConfigItem[] {
    // The discovered rows carry a section like every other row — the per-tool
    // watchdog exemptions under `timeouts` (they are exemptions FROM that
    // timeout), and the per-extension toggles under their own heading.
    return [...ITEMS, ...stepItems(catalog), ...toolItems(tools), ...extensionItems(installed)]
}

/** Render `rows` for the current config, grouped under their section headers. */
export function renderRows(cfg: PiTaskConfig, rows: readonly ConfigItem[]): PanelItem[] {
    const out: PanelItem[] = []
    for (const {key, title} of SECTIONS) {
        const inSection = rows
            .filter(i => i.section === key)
            .map(i => ({
                id: i.id,
                label: i.label,
                description: i.description,
                currentValue: i.format(cfg),
                values: i.values ?? ['on', 'off'],
                ...(i.picker === undefined ? {} : {pickerOptions: () => i.picker!(cfg)}),
                ...(i.headlessLabel === undefined ? {} : {headlessLabel: i.headlessLabel})
            }))
        // An empty section prints no header. `extensions` has no fixed rows at
        // all, so with nothing installed the heading would otherwise sit alone.
        if (inSection.length === 0) continue
        if (out.length > 0) out.push(sectionGap(title))
        out.push(sectionHeader(title), ...inSection)
    }
    return out
}

/** The full settings row list for the current config, in menu order. */
export function panelItems(
    cfg: PiTaskConfig,
    installed: InstalledExtension[],
    tools: readonly GuardableTool[] = [],
    catalog: ModelCatalog = EMPTY_CATALOG
): PanelItem[] {
    return renderRows(cfg, configRows(installed, tools, catalog))
}

/**
 * Re-ask every row what it now displays, and write the answers back.
 *
 * A row's `currentValue` in the live list is a snapshot taken when the panel was
 * built, and rows describe each other: cycling `reasoning` to `off` changes what
 * every `step:` row runs at, and setting one step row flips the profile, which
 * changes all the others.
 *
 * This runs after ANY change, over EVERY row. Re-reading a `format` costs
 * nothing, which is why there is no list of "changes that need a refresh" to
 * keep correct.
 */
export function syncRows(cfg: PiTaskConfig, rows: readonly ConfigItem[], list: SettingsList): void {
    for (const row of rows) list.updateValue(row.id, row.format(cfg))
}

/**
 * The step rows' model offer list, read live when the menu opens.
 *
 * `getAvailable()`, never `getAll()`: an unauthed model would spawn a child that
 * exits 1 on every phase of that group, and offering it would be offering a
 * config that cannot work.
 *
 * A provider registered by a host EXTENSION is offered with a note rather than
 * hidden. Children run `--no-extensions`, which disables discovery only — pi
 * still loads every explicit `-e` path, and `childBaseArgs` injects one per
 * whitelisted extension. So such a model works in a child exactly when its
 * extension is whitelisted, and we cannot tell which extension that is:
 * `getRegisteredProviderIds()` gives ids, and the `{name, config, extensionPath}`
 * triples live in the runner's internal state, drained at bind. Choosing it with
 * the wrong whitelist fails LOUDLY — the child sees no such provider, so pi's
 * resolver reports "not found" and exits 1 — which is why a note is enough.
 */
function liveCatalog(ctx: ExtensionCommandContext): ModelCatalog {
    // Same contract as the tool enumeration above, for the same reason: the
    // model runtime is not guaranteed usable at the moment a command runs, and a
    // registry that cannot answer must cost the model rows, never the menu.
    // Every row below still renders; `EMPTY_CATALOG` offers only `inherit` and
    // narrows nothing, which is exactly the pre-feature panel.
    let registry: ExtensionCommandContext['modelRegistry']
    let available: ReturnType<ExtensionCommandContext['modelRegistry']['getAvailable']>
    let fromExtension: Set<string>
    try {
        registry = ctx.modelRegistry
        available = registry.getAvailable()
        fromExtension = new Set(registry.getRegisteredProviderIds())
    } catch {
        return EMPTY_CATALOG
    }
    return {
        specs: available.map(m => `${m.provider}/${m.id}`),
        note: spec => {
            const parts = splitSpec(spec)
            return parts && fromExtension.has(parts.provider) ?
                    'provider comes from an extension — whitelist it under child extensions, '
                        + "or this group's children exit 1"
                :   undefined
        },
        facts: spec => {
            // `inherit` means the session's own model, which is what a child
            // resolves today. Its facts are what the thinking row must narrow to.
            if (spec === MODEL_INHERIT) return ctx.model
            const parts = splitSpec(spec)
            return parts ? registry.find(parts.provider, parts.id) : undefined
        }
    }
}

async function handleTaskConfig(
    _args: string,
    ctx: ExtensionCommandContext,
    getTools: () => GuardableTool[] = () => []
): Promise<void> {
    const cfg = {
        ...getConfig(),
        extensionWhitelist: [...getConfig().extensionWhitelist],
        commandTimeoutExemptTools: [...getConfig().commandTimeoutExemptTools],
        // Copied for the same reason as the two arrays above: the panel mutates
        // its own draft, and sharing the live object would apply half-made
        // choices to running children before the user finished choosing.
        reasoningLevels: {...getConfig().reasoningLevels},
        groupModels: {...getConfig().groupModels}
    }

    // Enumerated live at open so an installed extension appears and an
    // uninstalled one vanishes without pi-task doing any bookkeeping. A failed
    // enumeration only costs the extension toggles, never the whole menu.
    const installed = await listInstalledExtensions({cwd: ctx.cwd}).catch(() => [])
    // Same contract for tools, and for the same reason — plus one pi-specific
    // one: getAllTools() throws until the extension runtime is initialized, so
    // it can only be read here, when the menu opens, never at registration.
    const tools = getTools()
    const catalog = liveCatalog(ctx)

    if (ctx.mode !== 'tui') {
        // Built from panelItems and reading the SAME `format` the panel does,
        // so the two renderings cannot disagree about what a setting says. A
        // second walk of the same tables is the one place nobody would notice
        // them drifting, because a headless run has no panel to compare against.
        const lines = panelItems(cfg, installed, tools, catalog)
            // The blank rows between sections are there to give the TUI air.
            // One line of `|`-joined text has none to give, and an empty label
            // would print as a stray `[]`.
            .filter(i => i.label !== '')
            .map(i =>
                isSectionRow(i) ?
                    `[${i.label.trim()}]`
                :   `${(i.headlessLabel ?? i.label).padEnd(22)} ${i.currentValue}`
            )
        ctx.ui.notify(lines.join('  |  '), 'info')
        return
    }

    // Built ONCE and shared by the renderer, the dispatch and the refresh, so
    // all three necessarily agree about which rows exist.
    const rows = configRows(installed, tools, catalog)

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
            createSettingsPanel(
                renderRows(cfg, rows),
                theme,
                (id, newValue, list) => {
                    // Every row parses its own value. There is no generic
                    // fallback and no prefix ladder, so a row that forgets to
                    // parse cannot fall through to something that guesses. A
                    // header row carries no `values`, so SettingsList never
                    // cycles it and it matches no row here anyway.
                    rows.find(row => row.id === id)?.apply(cfg, newValue)
                    syncRows(cfg, rows, list)
                    saveConfig(cfg).catch(() => {})
                },
                () => done(undefined)
            ),
        {overlay: true, overlayOptions: {width: OVERLAY_WIDTH}}
    )
}

export function registerConfig(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-config', {
        description:
            'Configure pi-task settings (remote control, auto-commit, verify work, enforce '
            + 'guidelines, research, timeouts, per-tool command watchdog, extensions for helper '
            + 'sessions).',
        // `pi` is closed over rather than taken from ctx: ExtensionCommandContext
        // has no tool accessor, and the read must happen inside the handler
        // anyway (getAllTools throws until the runtime is initialized).
        handler: (args, ctx) => handleTaskConfig(args, ctx, () => listGuardableTools(pi))
    })
}
