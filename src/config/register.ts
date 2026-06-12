import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {SettingsList} from '@earendil-works/pi-tui'
import type {SettingsListTheme} from '@earendil-works/pi-tui'
import {registerBridgeCommand} from '../remote/bridge.js'
import {getConfig, saveConfig, type PiTaskConfig} from './config.js'

type Theme = ExtensionCommandContext['ui']['theme']

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
        description: 'git commit after each /task-auto sub-task'
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

            return list
        },
        {overlay: true, overlayOptions: {width: 54}}
    )
}

export function registerConfig(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-config', {
        description: 'Configure pi-task settings (remote, compress reasoning, auto-commit).',
        handler: handleTaskConfig
    })
}
