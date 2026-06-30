import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SettingsList, visibleWidth} from '@earendil-works/pi-tui'
import type {Component, SettingsListTheme} from '@earendil-works/pi-tui'
import {registerBridgeCommand} from '../remote/bridge.js'
import {getConfig, saveConfig, type PiTaskConfig} from './config.js'

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

const ITEMS: {id: keyof PiTaskConfig; label: string; description: string}[] = [
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
    }
]

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
    const cfg = {...getConfig()}

    if (ctx.mode !== 'tui') {
        const lines = ITEMS.map(({id, label}) => `${label.padEnd(22)} ${cfg[id] ? 'on' : 'off'}`)
        ctx.ui.notify(lines.join('  |  '), 'info')
        return
    }

    await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
            const listTheme = makeTheme(theme)
            const items = ITEMS.map(({id, label, description}) => ({
                id,
                label,
                description,
                currentValue: cfg[id] ? 'on' : 'off',
                values: ['on', 'off']
            }))

            const list = new SettingsList(
                items,
                10,
                listTheme,
                (id, newValue) => {
                    cfg[id as keyof PiTaskConfig] = newValue === 'on'
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
            'Configure pi-task settings (remote, compress reasoning, auto-commit, orientation, enforce guidelines).',
        handler: handleTaskConfig
    })
}
