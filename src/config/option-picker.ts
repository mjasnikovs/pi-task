/**
 * The two-step picker a /task-config step row opens on Enter.
 *
 * WHY A SUBMENU AND NOT `ctx.ui.select`
 * -------------------------------------
 * The settings panel already lives inside `ctx.ui.custom` with `overlay: true`.
 * Opening a second dialog from inside a component's input handler races two
 * overlays for focus. `SettingsList` already solves this: it renders the submenu
 * in place of the list and delegates input to it. And its `done(v)` calls
 * `onChange(id, v)` with exactly the returned value while `done(undefined)`
 * writes nothing — the same one-value contract every cycling row uses, so the
 * panel's dispatch needs no branch and a pair chosen out of two long lists costs
 * ONE write.
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

/** What the second stage offers, once the first has been answered. */
export interface PairStage {
    options: readonly SelectItem[]
    /**
     * The option to open on — the value that will ACTUALLY run.
     *
     * Supplied by the caller rather than derived here, because deciding it is
     * the clamp, and the clamp belongs to the config layer that owns the model's
     * declared ladder. It is what makes the auto-switch visible: pick a model
     * that cannot do `medium` and this stage opens on `off`.
     */
    preselect: string
}

export interface PairOptions {
    first: readonly SelectItem[]
    second: (firstValue: string) => PairStage
    /** Which half of the stored value stage one opens on. */
    firstOf: (value: string) => string
    /** How the two answers become the one string the row stores. */
    join: (first: string, second: string) => string
}

/**
 * A filterable list with a text filter above it.
 *
 * Split out because both stages are one of these and the routing is the part
 * that is easy to get wrong: `SelectList` owns four keys and drops the rest, so
 * everything else has to be handed to the `Input` and the filter re-applied.
 */
class FilterList extends Container {
    private readonly input = new Input()
    private readonly list: SelectList

    constructor(
        options: readonly SelectItem[],
        preselect: string,
        theme: Theme,
        private readonly onPick: (value: string) => void,
        private readonly onCancel: () => void
    ) {
        super()
        this.list = new SelectList([...options], PICKER_VISIBLE, selectTheme(theme))
        // A `preselect` matching no option is normal, not an error: a row can
        // hold a spec the catalog no longer offers, and it must still open.
        const at = options.findIndex(o => o.value === preselect)
        if (at !== -1) this.list.setSelectedIndex(at)
        this.list.onSelect = item => this.onPick(item.value)
        this.list.onCancel = () => this.onCancel()
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

/**
 * Model, then thinking level, as one choice.
 *
 * Two stages rather than one flat list of every legal pair: the pair space is
 * models × levels, and the common edit is "change the model, keep the level" —
 * a flat list would make that re-pick both every time.
 *
 * Escape at EITHER stage cancels the whole thing. Going back one step would be
 * friendlier, but a TUI select owns up, down, enter and escape and has no fifth
 * key to spare, and a half-answered pair must never reach `done`.
 */
export class PairPicker extends Container {
    private stage: FilterList

    constructor(
        private readonly options: PairOptions,
        currentValue: string,
        private readonly theme: Theme,
        private readonly done: (value?: string) => void
    ) {
        super()
        this.stage = new FilterList(
            options.first,
            options.firstOf(currentValue),
            theme,
            first => this.openSecond(first),
            () => done(undefined)
        )
        this.addChild(this.stage)
    }

    private openSecond(first: string): void {
        const {options: second, preselect} = this.options.second(first)
        this.stage = new FilterList(
            second,
            preselect,
            this.theme,
            level => this.done(this.options.join(first, level)),
            () => this.done(undefined)
        )
        this.clear()
        this.addChild(this.stage)
    }

    handleInput(data: string): void {
        this.stage.handleInput(data)
    }
}
