import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SettingsList, visibleWidth} from '@earendil-works/pi-tui'
import type {Component, SettingsListTheme} from '@earendil-works/pi-tui'
import {registerBridgeCommand} from '../remote/bridge.js'
import {
    SEARCH_PROVIDERS,
    SEARCH_PROVIDER_LABELS,
    providerForLabel
} from '../workers/search-types.js'
import {getConfig, saveConfig, type PiTaskConfig} from './config.js'
import {listInstalledExtensions, type InstalledExtension} from './extension-list.js'

type Theme = ExtensionCommandContext['ui']['theme']

const CONFIG_TITLE = 'pi-task settings'

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
        private readonly titleColor: (s: string) => string
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

        const body = this.child.render(innerWidth).map(line => {
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
    {id: 'remote', label: 'remote', description: 'Remote UI server (QR code, phone access)'},
    {
        id: 'compressReasoning',
        label: 'compress reasoning',
        description: 'Compress <think> blocks after each message'
    },
    {
        id: 'autoCommit',
        label: 'auto-commit',
        description:
            'git commit around each /task-auto sub-task (checkpoint before, snapshot after)'
    },
    {
        id: 'orientation',
        label: 'orientation',
        description:
            'Pre-supply the project core (manifest, types, schema…) to the read-heavy research workers'
    },
    {
        id: 'verifyWork',
        label: 'verify work',
        description:
            "After each /task (and /task-auto task), RUN its spec's VERIFY block in the workspace and report a PASS/FAIL verdict (also the signal that lets 'enforce guidelines' fix safely). Enabling it makes /task wait for the implementation"
    },
    {
        id: 'enforceGuidelines',
        label: 'enforce guidelines',
        description:
            "Check each /task and /task-auto commit against AGENTS.md/CLAUDE.md. Needs 'verify work' to FIX drift (fixes are reverted if they regress verification); without it, only reports violations. Enabling it makes /task wait for the implementation"
    },
    {
        id: 'parallelResearchWorkers',
        label: 'parallel research',
        description:
            'Run the 4 research workers concurrently. Leave OFF on a single-GPU local server (serial is measurably faster there); turn on only for a parallel-capable model backend'
    },
    {
        id: 'researchCache',
        label: 'research cache',
        description:
            'Cache docs/search/fetch results within one /task-auto run so sibling tasks reuse the first pipeline’s digest instead of re-fetching the same external docs. Per-run isolated, external-only, success-only'
    },
    {
        id: 'searchProvider',
        label: 'search provider',
        description:
            'Engine behind web search (pi-worker-search + freshness checks). Exa and DuckDuckGo need no API key; Brave needs BRAVE_SEARCH_API_KEY',
        // Display full engine names; the stored config value stays the short id.
        values: SEARCH_PROVIDERS.map(p => SEARCH_PROVIDER_LABELS[p])
    }
]

/** What /task-config shows for a setting's current value. */
function displayValue(cfg: PiTaskConfig, id: keyof PiTaskConfig, isEnum: boolean): string {
    if (id === 'searchProvider') return SEARCH_PROVIDER_LABELS[cfg.searchProvider]
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
            `Also load this extension (${e.origin}) in pi-task child sessions — needed when it `
            + 'registers the model provider the children must use (e.g. pi-lmstudio). Children '
            + 'otherwise run with extensions off; whitelist only provider-type extensions you '
            + `trust, since children also get its tools and hooks. ${e.path}`,
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

function makeTheme(theme: Theme): SettingsListTheme {
    return {
        label: (text, selected) => (selected ? theme.fg('accent', text) : text),
        value: text => (text === 'on' ? theme.fg('success', text) : theme.fg('muted', text)),
        description: text => theme.fg('muted', text),
        cursor: theme.fg('accent', '>'),
        hint: text => theme.fg('dim', text)
    }
}

async function handleTaskConfig(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const cfg = {...getConfig(), extensionWhitelist: [...getConfig().extensionWhitelist]}

    // Enumerated live at open so an installed extension appears and an
    // uninstalled one vanishes without pi-task doing any bookkeeping. A failed
    // enumeration only costs the extension toggles, never the whole menu.
    const installed = await listInstalledExtensions({cwd: ctx.cwd}).catch(() => [])

    if (ctx.mode !== 'tui') {
        const lines = ITEMS.map(
            ({id, label, values}) => `${label.padEnd(22)} ${displayValue(cfg, id, Boolean(values))}`
        )
        for (const e of installed) {
            const state = cfg.extensionWhitelist.includes(e.path) ? 'on' : 'off'
            lines.push(`${('ext: ' + e.label).padEnd(22)} ${state}`)
        }
        ctx.ui.notify(lines.join('  |  '), 'info')
        return
    }

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
            const listTheme = makeTheme(theme)
            const items = [
                ...ITEMS.map(({id, label, description, values}) => ({
                    id: id as string,
                    label,
                    description,
                    currentValue: displayValue(cfg, id, Boolean(values)),
                    values: values ?? ['on', 'off']
                })),
                ...extensionItems(installed, cfg.extensionWhitelist)
            ]

            const list = new SettingsList(
                items,
                10,
                listTheme,
                (id, newValue) => {
                    if (id.startsWith(EXT_ID_PREFIX)) {
                        cfg.extensionWhitelist = applyExtensionToggle(
                            cfg.extensionWhitelist,
                            id.slice(EXT_ID_PREFIX.length),
                            newValue === 'on'
                        )
                    } else if (id === 'searchProvider') {
                        const provider = providerForLabel(newValue)
                        if (provider) cfg.searchProvider = provider
                    } else {
                        ;(cfg as unknown as Record<string, boolean>)[id] = newValue === 'on'
                    }
                    saveConfig(cfg).catch(() => {})
                },
                () => done(undefined)
            )

            return new BorderedBox(
                list,
                CONFIG_TITLE,
                s => theme.fg('borderMuted', s),
                s => theme.fg('accent', theme.bold(s))
            )
        },
        {overlay: true, overlayOptions: {width: 58}}
    )
}

export function registerConfig(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-config', {
        description:
            'Configure pi-task settings (remote, compress reasoning, auto-commit, orientation, '
            + 'enforce guidelines, extension whitelist for child sessions).',
        handler: handleTaskConfig
    })
}
