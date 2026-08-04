import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SettingsList, visibleWidth, wrapTextWithAnsi} from '@earendil-works/pi-tui'
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
 * Every setting rendered by /task-config. Boolean settings omit `values` and
 * toggle on/off; enum settings list their values and cycle through them.
 */
const ITEMS: {id: keyof PiTaskConfig; label: string; description: string; values?: string[]}[] = [
    {
        id: 'remote',
        label: 'remote control',
        description:
            'Serve the task UI on your local network so you can follow and steer a run from '
            + 'your phone. Prints a QR code to scan when it starts'
    },
    {
        id: 'compressReasoning',
        label: 'compress thinking',
        description:
            "Shrink the model's thinking blocks once it has moved on, so a long run keeps more "
            + 'room for the work itself'
    },
    {
        id: 'autoCommit',
        label: 'auto-commit',
        description:
            'Make a git commit before and after every sub-task, so each step is a checkpoint '
            + 'you can read back or roll back to'
    },
    {
        id: 'verifyWork',
        label: 'verify work',
        description:
            'When a task says it is done, actually run the checks its spec asks for and report '
            + "PASS or FAIL instead of taking the model's word for it. This is also what lets "
            + '"enforce guidelines" fix things safely. /task waits for the work to finish'
    },
    {
        id: 'enforceGuidelines',
        label: 'enforce guidelines',
        description:
            'Check what each task committed against your AGENTS.md / CLAUDE.md rules. With '
            + '"verify work" on it also fixes what it finds, undoing any fix that breaks the '
            + 'checks; on its own it only reports. /task waits for the work to finish'
    },
    {
        id: 'orientation',
        label: 'project tour',
        description:
            'Show the research workers the shape of the project first — package manifest, '
            + 'types, schema — so they spend their steps on the question instead of on finding '
            + 'their way around'
    },
    {
        id: 'parallelResearchWorkers',
        label: 'parallel research',
        description:
            'Run the 4 research workers at once instead of one after another. Only faster if '
            + 'your model backend can answer several requests at the same time — on a single '
            + 'local GPU it is measurably slower, so leave it off there'
    },
    {
        id: 'researchCache',
        label: 'research cache',
        description:
            'Remember docs and web pages for the length of one run, so later tasks reuse what '
            + 'the first one already fetched instead of downloading it again. Only external '
            + 'sources, only successful fetches, and it is dropped when the run ends'
    },
    {
        id: 'searchProvider',
        label: 'search engine',
        description:
            'Which engine backs web search. Exa and DuckDuckGo work with no setup; Brave needs '
            + 'a BRAVE_SEARCH_API_KEY in your environment',
        // Display full engine names; the stored config value stays the short id.
        values: SEARCH_PROVIDERS.map(p => SEARCH_PROVIDER_LABELS[p])
    },
    {
        id: 'requestTimeoutMs',
        label: 'command timeout',
        description:
            'Give up on any single command that runs this long, and tell the model to set its '
            + 'own timeout next time. Stops a run from waiting forever on a dev server or a '
            + 'hung build. Covers the main session and the checking steps; "off" lets a stuck '
            + 'command hang the run until you notice',
        // Display human labels; the stored config value stays the ms number.
        values: COMMAND_TIMEOUT_OPTIONS.map(o => o.label)
    },
    {
        id: 'streamInactivityMs',
        label: 'stuck reply retry',
        description:
            'Give up on a model reply that has sent nothing for this long and ask again. A '
            + 'dropped connection looks exactly like a model thinking hard and reports no '
            + 'error, so a run can sit dead for hours. Only total silence counts, and the clock '
            + 'pauses while a command runs — local models go quiet for minutes on long prompts, '
            + 'so leave room',
        // Display human labels; the stored config value stays the ms number.
        values: STREAM_INACTIVITY_OPTIONS.map(o => o.label)
    },
    {
        id: 'yoloMode',
        label: 'yolo mode',
        description:
            'Stop asking you anything: every question takes the option pi recommends, a failed '
            + 'check is accepted and written down as debt, and a failed final check is retried '
            + 'until the budget runs out. Each auto-answer is marked (YOLO) in the task file. '
            + 'For throwaway projects you are not watching'
    },
    {
        id: 'debugLogs',
        label: 'debug logs',
        description:
            'How much of a run gets written to .pi-tasks/*-debug.log. "events" keeps the '
            + 'decisions and the guard actions — what a checking step changed, why something '
            + 'failed — a few lines per task. "full" adds everything the model said and every '
            + 'command it ran, which is most of the size and only useful while you are digging '
            + 'into a problem. "off" writes nothing, and nothing can be reconstructed later',
        values: [...DEBUG_LOG_OPTIONS]
    }
]

/** Human label for the stored command-timeout ms (falls back to the raw ms). */
function timeoutLabel(ms: number): string {
    return COMMAND_TIMEOUT_OPTIONS.find(o => o.ms === ms)?.label ?? `${ms}ms`
}

/** Human label for the stored stream-inactivity ms (falls back to the raw ms). */
function streamTimeoutLabel(ms: number): string {
    return STREAM_INACTIVITY_OPTIONS.find(o => o.ms === ms)?.label ?? `${ms}ms`
}

/** What /task-config shows for a setting's current value. */
function displayValue(cfg: PiTaskConfig, id: keyof PiTaskConfig, isEnum: boolean): string {
    if (id === 'searchProvider') return SEARCH_PROVIDER_LABELS[cfg.searchProvider]
    if (id === 'requestTimeoutMs') return timeoutLabel(cfg.requestTimeoutMs)
    if (id === 'streamInactivityMs') return streamTimeoutLabel(cfg.streamInactivityMs)
    if (isEnum) return String(cfg[id])
    return cfg[id] ? 'on' : 'off'
}

/**
 * One /task-config toggle per installed host extension (GitHub issue #4).
 * The id carries the entry path behind a prefix so the shared onChange handler
 * can tell an extension toggle from a PiTaskConfig field.
 */
const EXT_ID_PREFIX = 'ext:'

export function extensionItems(
    extensions: InstalledExtension[],
    whitelist: readonly string[]
): {id: string; label: string; description: string; currentValue: string; values: string[]}[] {
    return extensions.map(e => ({
        id: EXT_ID_PREFIX + e.path,
        label: `ext: ${e.label}`,
        description:
            `Load this ${e.origin} extension in the helper sessions pi-task spawns. They run `
            + 'with extensions off by default, so turn this on when the extension provides the '
            + 'model they need (pi-lmstudio, for example). They also inherit its tools and '
            + `hooks, so only enable ones you trust. ${e.path}`,
        currentValue: whitelist.includes(e.path) ? 'on' : 'off',
        values: ['on', 'off']
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

export function toolItems(
    tools: readonly GuardableTool[],
    exempt: readonly string[]
): {id: string; label: string; description: string; currentValue: string; values: string[]}[] {
    return tools.map(t => ({
        id: TOOL_ID_PREFIX + t.name,
        label: `watch: ${t.name}`,
        description:
            `Apply the command timeout to this tool. Leave it on unless the tool runs its own `
            + `bounded, cancellable work for longer than the timeout — turning it off means a `
            + `genuine hang in this tool will never be caught, and nothing else is watching `
            + `while a tool runs. ${t.origin}`,
        // Stored inverted: the config records the EXEMPTIONS, so an empty list
        // (and any tool pi-task has never heard of) stays guarded by default.
        currentValue: exempt.includes(t.name) ? 'off' : 'on',
        values: ['on', 'off']
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

/** Overlay width; the list gets `- 4` of it, the description `- 4` again. */
const OVERLAY_WIDTH = 68
/** Settings rows shown at once before the list scrolls. */
const MAX_VISIBLE = 9

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

function makeTheme(theme: Theme): SettingsListTheme {
    return {
        label: (text, selected) =>
            selected ? theme.fg('accent', theme.bold(text)) : theme.fg('text', text),
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
    values: string[]
}

/**
 * Builds the framed settings panel. Split out of the command handler so the
 * exact component the overlay shows can be rendered to a string in a test or a
 * preview script, rather than only being inspectable by opening the TUI.
 */
export function createSettingsPanel(
    items: PanelItem[],
    theme: Theme,
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void
): BorderedBox {
    const list = new SettingsList(items, MAX_VISIBLE, makeTheme(theme), onChange, onCancel)
    return new BorderedBox(
        list,
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

/** The full settings row list for the current config, in menu order. */
export function panelItems(
    cfg: PiTaskConfig,
    installed: InstalledExtension[],
    tools: readonly GuardableTool[] = []
): PanelItem[] {
    return [
        ...ITEMS.map(({id, label, description, values}) => ({
            id: id as string,
            label,
            description,
            currentValue: displayValue(cfg, id, Boolean(values)),
            values: values ?? ['on', 'off']
        })),
        ...toolItems(tools, cfg.commandTimeoutExemptTools),
        ...extensionItems(installed, cfg.extensionWhitelist)
    ]
}

async function handleTaskConfig(
    _args: string,
    ctx: ExtensionCommandContext,
    getTools: () => GuardableTool[] = () => []
): Promise<void> {
    const cfg = {
        ...getConfig(),
        extensionWhitelist: [...getConfig().extensionWhitelist],
        commandTimeoutExemptTools: [...getConfig().commandTimeoutExemptTools]
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
        const lines = ITEMS.map(
            ({id, label, values}) => `${label.padEnd(22)} ${displayValue(cfg, id, Boolean(values))}`
        )
        for (const t of tools) {
            const state = cfg.commandTimeoutExemptTools.includes(t.name) ? 'off' : 'on'
            lines.push(`${('watch: ' + t.name).padEnd(22)} ${state}`)
        }
        for (const e of installed) {
            const state = cfg.extensionWhitelist.includes(e.path) ? 'on' : 'off'
            lines.push(`${('ext: ' + e.label).padEnd(22)} ${state}`)
        }
        ctx.ui.notify(lines.join('  |  '), 'info')
        return
    }

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) =>
            createSettingsPanel(
                panelItems(cfg, installed, tools),
                theme,
                (id, newValue) => {
                    if (id.startsWith(EXT_ID_PREFIX)) {
                        cfg.extensionWhitelist = applyExtensionToggle(
                            cfg.extensionWhitelist,
                            id.slice(EXT_ID_PREFIX.length),
                            newValue === 'on'
                        )
                    } else if (id.startsWith(TOOL_ID_PREFIX)) {
                        cfg.commandTimeoutExemptTools = applyToolToggle(
                            cfg.commandTimeoutExemptTools,
                            id.slice(TOOL_ID_PREFIX.length),
                            newValue === 'on'
                        )
                    } else if (id === 'searchProvider') {
                        const provider = providerForLabel(newValue)
                        if (provider) cfg.searchProvider = provider
                    } else if (id === 'requestTimeoutMs') {
                        const opt = COMMAND_TIMEOUT_OPTIONS.find(o => o.label === newValue)
                        if (opt) cfg.requestTimeoutMs = opt.ms
                    } else if (id === 'streamInactivityMs') {
                        const opt = STREAM_INACTIVITY_OPTIONS.find(o => o.label === newValue)
                        if (opt) cfg.streamInactivityMs = opt.ms
                    } else if (id === 'debugLogs') {
                        // The stored value IS the label here, but it must still go
                        // through the sanitizer — the generic `else` below would
                        // write the boolean `newValue === 'on'` into an enum field.
                        cfg.debugLogs = sanitizeDebugLogs(newValue)
                    } else {
                        ;(cfg as unknown as Record<string, boolean>)[id] = newValue === 'on'
                    }
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
