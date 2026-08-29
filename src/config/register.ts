import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {getKeybindings, SettingsList, visibleWidth, wrapTextWithAnsi} from '@earendil-works/pi-tui'
import type {Component, SettingsListTheme} from '@earendil-works/pi-tui'
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
    REASONING_GROUPS,
    REASONING_MODES,
    sanitizeReasoningMode,
    REASONING_GROUP_HELP,
    REASONING_SETTINGS,
    effectiveReasoning,
    resolveReasoning,
    type GroupSetting,
    type ReasoningGroup
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
 * edit. Split across separate format and parse ladders, a missing arm compiles
 * fine and misbehaves at run time: an absent format arm renders
 * `String(cfg[id])`, and an absent parse arm writes the boolean
 * `newValue === 'on'` into an enum field.
 *
 * With both directions on the row, `format(apply(cfg, v)) === v` is a property
 * over the whole table, and the panel and the non-TUI listing cannot disagree
 * because both read `format`.
 */
export interface ConfigItem {
    /**
     * The row's id. A `keyof PiTaskConfig` for a fixed setting; a prefixed
     * string (`reason:`, `tool:`, `ext:`) for a DISCOVERED one.
     *
     * It is `string`, not `keyof PiTaskConfig`, and that is what lets the three
     * dynamic families BE rows instead of bypassing them. While the id was
     * narrow, each family re-invented both directions by hand — a builder, an
     * apply function, and an arm in a four-way prefix ladder 300 lines away —
     * and the round-trip property `config-items.test.ts` runs over `ITEMS`
     * covered none of them.
     */
    id: string
    /**
     * Which titled block of the menu this row sits under. Rows are grouped by
     * section in {@link panelItems}, in the order the sections first appear in
     * {@link ITEMS} — so moving a row between sections is a one-word edit and
     * the header follows it.
     */
    section: Section
    label: string
    description: string
    /** Offered values. Omitted for a boolean, which is always on/off. */
    values?: string[]
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
 * A flat list of ~30 rows — twelve settings, seven reasoning groups, one row per
 * live tool and one per installed extension — reads as a wall, and the rows that
 * belong together (a mode and the seven groups it controls; a timeout and the
 * per-tool exemptions from it) end up separated by rows that have nothing to do
 * with them. The headers are inert rows: no `values`, so Enter does nothing on
 * them.
 */
export type Section =
    | 'session'
    | 'checks'
    | 'research'
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
    {key: 'reasoning', title: 'reasoning'},
    {key: 'unattended', title: 'unattended'},
    {key: 'logging', title: 'logging'},
    {key: 'extensions', title: 'child extensions'},
    // Last on purpose. It is the longest block (a fixed timeout plus one row
    // per live tool, so it grows with the host) and the least often changed —
    // in front of `unattended` it pushed every short section off the screen.
    {key: 'timeouts', title: 'timeouts'}
]

/** Marks a header row, so onChange can ignore one and tests can find them. */
export const SECTION_ID_PREFIX = 'section:'

/**
 * An inert titled row. No `values` ⇒ SettingsList's Enter handler no-ops on it,
 * and {@link SkipInertRows} steps the cursor straight over it.
 *
 * Upper case, and styled muted by {@link makeTheme}, because the dashed
 * lower-case form it replaces was the same case, colour and weight as the
 * setting labels underneath it — eight headings that read as nine more rows.
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
 * Exported so the round-trip property below can be asserted over the WHOLE table
 * rather than per setting — the check that would have caught a forgotten arm in
 * either of the two ladders this replaced.
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
        section: 'reasoning',
        label: 'reasoning',
        description:
            'How much the helper sessions think before answering. "default" uses the '
            + 'per-step table pi-task has measured, "on" and "off" force one answer '
            + 'everywhere, and "custom" is whatever you set in the "think:" rows below. '
            + 'Those rows always show what each step actually runs at, and changing one '
            + 'switches this to custom. A step left on "inherit" uses whatever thinking '
            + 'level pi itself is set to, which is what every step did before this setting '
            + 'existed',
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
 *  - `SettingsList` fixes the overlay's body height from the descriptions it was
 *    constructed with (see createSettingsPanel), so rows that appear and vanish
 *    would leave the box sized for the wrong list.
 *  - The value displayed is what the group ACTUALLY runs at — resolveReasoning,
 *    not the stored custom table. In mode `off` every row reads `off` even
 *    though the custom table underneath is untouched, which is the honest
 *    answer to "what will my next child do".
 */
const REASON_ID_PREFIX = 'reason:'

/**
 * The label for one `think:` row.
 *
 * A group whose name carries a colon is a CHILD of the group before the colon —
 * `research:files` is one of the four workers `research` fans out to. Rendered
 * flat, those four read as four more peers of `research`, and the menu's one
 * genuine hierarchy is invisible: the four are the only rows in the list whose
 * parent is also a row.
 *
 * So a child is drawn as a tree branch under its parent and loses the repeated
 * `think: research:` prefix, which is 15 columns of the same text on four
 * consecutive lines. `└─` on the last child, `├─` on the rest, decided from the
 * group's position in {@link REASONING_GROUPS} rather than a hand-kept list —
 * adding a fifth worker moves the corner on its own.
 *
 * Leading spaces survive: SettingsList pads the label right, never trims it.
 */
export function reasoningRowLabel(group: ReasoningGroup): string {
    const colon = group.indexOf(':')
    if (colon < 0) return `think: ${group}`
    const parent = group.slice(0, colon)
    const nextIsSibling = REASONING_GROUPS[REASONING_GROUPS.indexOf(group) + 1]?.startsWith(
        `${parent}:`
    )
    return `   ${nextIsSibling ? '├─' : '└─'} ${group.slice(colon + 1)}`
}

export function reasoningItems(): ConfigItem[] {
    return REASONING_GROUPS.map(group => ({
        id: REASON_ID_PREFIX + group,
        section: 'reasoning' as Section,
        label: reasoningRowLabel(group),
        headlessLabel: `think: ${group}`,
        description: REASONING_GROUP_HELP[group],
        values: [...REASONING_SETTINGS],
        // The EFFECTIVE level, not cfg.reasoningLevels[group]: in default/on/off
        // the stored table is not what runs, and a row that shows a value the
        // run does not use is worse than no row. As a FUNCTION rather than a
        // snapshot, so `syncRows` can re-ask after any change.
        format: cfg => resolveReasoning(group, cfg),
        apply: (cfg, chosen) => applyReasoningLevel(cfg, group, chosen)
    }))
}

/**
 * Apply one group row's new value.
 *
 * Setting any group necessarily means "custom" — there is nowhere else to store
 * a per-group choice. The seeding step is what stops that from being a trap: on
 * the way out of `default`/`on`/`off` every OTHER group is first pinned to the
 * level it was already running at, so changing one row changes one row. Without
 * it, nudging `research` while in `off` would silently return the other six to
 * whatever the stored table happened to hold.
 */
export function applyReasoningLevel(
    cfg: PiTaskConfig,
    group: ReasoningGroup,
    chosen: string
): void {
    if (!REASONING_SETTINGS.includes(chosen as GroupSetting)) return
    if (cfg.reasoningMode !== 'custom') {
        // Freeze the table exactly as it runs today, then switch to custom, so
        // opening one row cannot silently move the other six.
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
     * Omitted ONLY by a section header. SettingsList cycles a row on Enter when
     * this is a non-empty array, so leaving it off is what makes a header inert
     * — the header does not need its own branch anywhere.
     */
    values?: string[]
    /**
     * What the headless one-line rendering calls this row, when `label` reads
     * only in the panel. A tree branch means nothing on a line of `|`-joined
     * rows: `├─ files` there names no parent, where `think: research:files`
     * does. Set by the reasoning rows; every other row leaves it off and its
     * `label` is used.
     */
    headlessLabel?: string
}

/** The arrow key SettingsList moves down on, under the default bindings. */
const DOWN_KEY = '\x1b[B'

/**
 * Moves the cursor over the section headers and the blank rows between them.
 *
 * Those rows are decoration: they carry no `values`, so Enter already does
 * nothing on them. Without this they were still stops on the way down — with a
 * heading AND a blank line per section that is sixteen dead keypresses in a
 * thirty-row menu, and the panel opens with the cursor parked on a heading that
 * has no description to show.
 *
 * It drives the list through its own public `handleInput` — pressing the very
 * key the user pressed, N times — rather than reaching for the private
 * `selectedIndex`. The mirror it keeps cannot drift: with search off and no
 * submenus, up and down are the only two things that move that index.
 */
class SkipInertRows implements Component {
    private index = 0

    constructor(
        private readonly list: SettingsList,
        /** True where a row can be selected, in the list's own order. */
        private readonly selectable: boolean[]
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
            kb.matches(data, 'tui.select.down') ? 1
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
     * flipping `reasoning` to off means all seven `think:` rows now run at off,
     * and a row's `currentValue` is a snapshot taken when the panel was built.
     * Without a way to write the others back, the menu shows `reasoning off`
     * beside seven rows still claiming `inherit` — which is what it did.
     */
    onChange: (id: string, newValue: string, list: SettingsList) => void,
    onCancel: () => void
): BorderedBox {
    // A row with no `values` is a header or the blank line above one.
    const headerLabels = new Set(items.filter(i => i.values === undefined).map(i => i.label))
    const list: SettingsList = new SettingsList(
        items,
        MAX_VISIBLE,
        makeTheme(theme, label => headerLabels.has(label.trimEnd())),
        (id, newValue) => onChange(id, newValue, list),
        onCancel
    )
    return new BorderedBox(
        new SkipInertRows(
            list,
            items.map(i => (i.values?.length ?? 0) > 0)
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
    tools: readonly GuardableTool[] = []
): ConfigItem[] {
    // The discovered rows carry a section like every other row — the per-tool
    // watchdog exemptions under `timeouts` (they are exemptions FROM that
    // timeout), and the per-extension toggles under their own heading.
    return [...ITEMS, ...reasoningItems(), ...toolItems(tools), ...extensionItems(installed)]
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
    tools: readonly GuardableTool[] = []
): PanelItem[] {
    return renderRows(cfg, configRows(installed, tools))
}

/**
 * Re-ask every row what it now displays, and write the answers back.
 *
 * A row's `currentValue` in the live list is a snapshot taken when the panel was
 * built, and rows describe each other: cycling `reasoning` to `off` changes what
 * all seven `think:` rows run at, and cycling one group row flips the mode,
 * which changes the other six.
 *
 * This runs after ANY change, over EVERY row. Its predecessor,
 * `refreshReasoningRows`, ran after any change too — but hard-coded the seven
 * reasoning ids plus `reasoningMode` and touched none of the other ~30 rows, so
 * the next cross-row dependency would have needed a fifth function. Re-reading a
 * `format` costs nothing, which is why there is still no list of "changes that
 * need a refresh" to keep correct.
 */
export function syncRows(cfg: PiTaskConfig, rows: readonly ConfigItem[], list: SettingsList): void {
    for (const row of rows) list.updateValue(row.id, row.format(cfg))
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
        reasoningLevels: {...getConfig().reasoningLevels}
    }

    // Enumerated live at open so an installed extension appears and an
    // uninstalled one vanishes without pi-task doing any bookkeeping. A failed
    // enumeration only costs the extension toggles, never the whole menu.
    const installed = await listInstalledExtensions({cwd: ctx.cwd}).catch(() => [])
    // Same contract for tools, and for the same reason — plus one pi-specific
    // one: getAllTools() throws until the extension runtime is initialized, so
    // it can only be read here, when the menu opens, never at registration.
    const tools = getTools()

    if (ctx.mode !== 'tui') {
        // Built from panelItems and reading the SAME `format` the panel does,
        // so the two renderings cannot disagree about what a setting says. A
        // second walk of the same tables is the one place nobody would notice
        // them drifting, because a headless run has no panel to compare against.
        const lines = panelItems(cfg, installed, tools)
            // The blank rows between sections are there to give the TUI air.
            // One line of `|`-joined text has none to give, and an empty label
            // would print as a stray `[]`.
            .filter(i => i.label !== '')
            .map(i =>
                i.values === undefined ?
                    `[${i.label.trim()}]`
                :   `${(i.headlessLabel ?? i.label).padEnd(22)} ${i.currentValue}`
            )
        ctx.ui.notify(lines.join('  |  '), 'info')
        return
    }

    // Built ONCE and shared by the renderer, the dispatch and the refresh, so
    // all three necessarily agree about which rows exist.
    const rows = configRows(installed, tools)

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
            createSettingsPanel(
                renderRows(cfg, rows),
                theme,
                (id, newValue, list) => {
                    // Every row parses its own value. There is no generic
                    // fallback and no prefix ladder: the ladder this replaces
                    // ended in one that wrote `newValue === 'on'` into whatever
                    // field it was handed, so a new enum setting silently became
                    // a boolean until someone noticed. A header row carries no
                    // `values`, so SettingsList never cycles it and it matches
                    // no row here anyway.
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
