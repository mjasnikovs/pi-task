/**
 * The submenu a /task-config row opens on Enter, when cycling is the wrong verb.
 *
 * WHY A SUBMENU AND NOT `ctx.ui.select`
 * -------------------------------------
 * The settings panel already lives inside `ctx.ui.custom` with `overlay: true`.
 * Opening a second dialog from inside a component's input handler races two
 * overlays for focus. `SettingsList` already solves this: it renders the submenu
 * in place of the list and delegates input to it. And its `done(v)` calls
 * `onChange(id, v)` with exactly the returned value while `done(undefined)`
 * writes nothing — the same one-value contract every cycling row uses, so the
 * panel's dispatch needs no branch and a model list of 200 costs one write
 * instead of 200.
 *
 * WHY NOT A BARE `SelectList`
 * ---------------------------
 * `SelectList.handleInput` matches up, down, confirm and cancel and DROPS every
 * other key, so it can never fill its own `setFilter`. `Container` has no
 * `handleInput` at all — it composes `render` and nothing else. pi's own model
 * picker (`modes/interactive/components/model-selector.js`) hand-rolls exactly
 * this: an `Input`, a filtered list, and a `handleInput` that routes between
 * them. The three components that DO use `SelectList` bare — theme, thinking,
 * show-images — are short fixed lists with no filter. A model list is not.
 */
import {Container, getKeybindings, Input, SelectList} from '@earendil-works/pi-tui'
import type {SelectItem, SelectListTheme} from '@earendil-works/pi-tui'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

type Theme = ExtensionCommandContext['ui']['theme']

/** Rows visible before the list scrolls. Matches the panel's own MAX_VISIBLE. */
const PICKER_VISIBLE = 11

function selectTheme(theme: Theme): SelectListTheme {
    return {
        selectedPrefix: text => theme.fg('accent', text),
        selectedText: text => theme.fg('accent', theme.bold(text)),
        description: text => theme.fg('muted', text),
        scrollInfo: text => theme.fg('dim', text),
        noMatch: text => theme.fg('dim', text)
    }
}

/**
 * A filterable one-of picker.
 *
 * `currentValue` may match NO option — that is the vanished-model case, where
 * the stored spec is still shown by the row and must still be openable. It
 * simply starts at the top rather than refusing to render.
 */
export class OptionPicker extends Container {
    private readonly input = new Input()
    private readonly list: SelectList

    constructor(
        options: readonly SelectItem[],
        currentValue: string,
        theme: Theme,
        done: (value?: string) => void
    ) {
        super()
        this.list = new SelectList([...options], PICKER_VISIBLE, selectTheme(theme))
        const at = options.findIndex(o => o.value === currentValue)
        if (at !== -1) this.list.setSelectedIndex(at)
        this.list.onSelect = item => done(item.value)
        this.list.onCancel = () => done(undefined)
        this.addChild(this.input)
        this.addChild(this.list)
    }

    handleInput(data: string): void {
        const kb = getKeybindings()
        const forList =
            kb.matches(data, 'tui.select.up')
            || kb.matches(data, 'tui.select.down')
            || kb.matches(data, 'tui.select.confirm')
            || kb.matches(data, 'tui.select.cancel')
        if (forList) {
            this.list.handleInput(data)
            return
        }
        // Everything else is typing. The list re-filters on every keystroke,
        // which is what `setFilter` is for and what nothing else calls.
        this.input.handleInput(data)
        this.list.setFilter(this.input.getValue())
    }
}
