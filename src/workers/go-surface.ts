/**
 * go-surface — reducing Go source to the API a caller outside the package can
 * reach.
 *
 * Go ships no declarations file, so this is the `.d.ts` a Go package does not
 * have. It is the same job `rustSurface` does in eco-cargo.ts, and it needs the
 * same care, but three things about Go make a straight port wrong.
 *
 * There are no semicolons. A declaration ends where Go's lexer would insert one,
 * which is a property of the last token on the line, so the scanner has to track
 * that token rather than look for a terminator.
 *
 * A signature can hold a balanced brace pair before its body:
 * `func Bind(v interface{}) HandlerFunc {`. Splitting the head at the first `{`,
 * the way the Rust version does, cuts that one at `interface`. The body is the
 * group whose closer ENDS the declaration, not the first group that opens.
 *
 * And a doc comment has no marker at all. Adjacency is the marker: the comment
 * paragraph on the lines directly above, with no blank line between. Every Go
 * file also opens with a licence header, so "keep what came before" reprints the
 * licence into every chunk of every file.
 */

/** A Go identifier is Unicode, not `\w` — `Ünique` is a legal exported name. */
const ID = String.raw`[\p{L}_][\p{L}\p{Nd}_]*`

const GO_ITEM_HEAD_RE = /^(package|import|const|var|type|func)\b/

/** A func's name, and the base type of its receiver when it has one. */
const GO_FUNC_RE = new RegExp(
    String.raw`^func\s*(?:\(\s*(?:${ID}\s+)?\*?(${ID})(?:\[[^\]]*\])?\s*\)\s*)?(${ID})`,
    'u'
)

const GO_DECL_NAME_RE = new RegExp(String.raw`^(?:type|const|var)\s+(${ID})`, 'u')

/** The names a member line declares, before its type or `=`. */
const GO_MEMBER_NAME_RE = new RegExp(String.raw`^(${ID}(?:\s*,\s*${ID})*)\s*(?:[^\s,=]|=|$)`, 'u')

/** A qualified name alone on a line: an embedded field or interface. */
const GO_EMBEDDED_RE = new RegExp(String.raw`^\*?(?:${ID}\.)?(${ID})\s*(?:\x60[^\x60]*\x60)?$`, 'u')

/**
 * A named `struct`/`interface` head, for telling a type's BODY from a type whose
 * definition merely ends in a brace: `type Set[T comparable] map[T]struct{}`.
 */
const GO_TYPE_BODY_RE = new RegExp(
    String.raw`^type\s+${ID}(?:\[[\s\S]*\])?\s+(?:struct|interface)\s*$`,
    'u'
)

/**
 * Where a declaration begins. Column 0 only: `goSurface` indents struct fields
 * and interface methods, and an `^\s*` anchor would cut every field into its own
 * chunk. eco-cargo.ts records the same trap.
 */
export const GO_DECL_SPLIT_RE = /^(?:package|import|const|var|type|func)\b/m

/**
 * The same heads indented, plus the keyword-less members only Go has: a struct
 * field is `Name Type`, an interface method is `Name(args) ret`, a grouped const
 * is `Name Type = value`. Reached only when one declaration does not fit a
 * chunk, which `Context` and `IRoutes` in gin both fail to.
 */
export const GO_MEMBER_SPLIT_RE = new RegExp(
    String.raw`^[ \t]+(?:(?:const|var|type|func)\b|${ID}(?:\s*,\s*${ID})*\s*(?:\(|=|[*\[]|${ID}))`,
    'mu'
)

/** Go inserts a semicolon after a token of one of these shapes. */
const STMT_END_CHAR_RE = /[\p{L}\p{Nd}_"'\x60)\]}]/u

/**
 * Keywords that end a line without ending a declaration. Go's own rule lists
 * only `break`, `continue`, `fallthrough` and `return`, which cannot appear at
 * the top level; these six can, and a wrapped `type\n\tX int` would otherwise
 * split into two items.
 */
const CONTINUING_KEYWORDS = new Set(['package', 'import', 'const', 'var', 'type', 'func'])

/** A value longer than this is elided; below it the value IS the documentation. */
const INITIALIZER_LIMIT = 120

const LICENCE_RE = /copyright|licen[sc]e|all rights reserved|SPDX-/i

/** `//go:` directives that describe the declaration rather than the build. */
const KEPT_DIRECTIVES = new Set([
    'noescape',
    'linkname',
    'embed',
    'nosplit',
    'noinline',
    'uintptrescapes',
    'wasmimport'
])

export interface GoItem {
    /** Comments and directives between the previous item and this one. */
    pending: string
    text: string
}

/** Advance past whitespace and comments, to the next code character. */
function skipToCode(src: string, from: number): number {
    let i = from
    while (i < src.length) {
        const c = src[i]
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            i++
        } else if (c === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i)
            i = nl < 0 ? src.length : nl + 1
        } else if (c === '/' && src[i + 1] === '*') {
            const close = src.indexOf('*/', i + 2)
            i = close < 0 ? src.length : close + 2
        } else {
            return i
        }
    }
    return src.length
}

/** Past a string, rune or raw-string literal, given its opening quote. */
function skipLiteral(src: string, from: number): number {
    const quote = src[from]
    let i = from + 1
    while (i < src.length) {
        const c = src[i]
        // A raw string has no escapes at all, so a lone backslash inside one is
        // just a byte. `var x = `a\`` ends at the backtick, not after it.
        if (c === '\\' && quote !== '`') i += 2
        else if (c === quote) return i + 1
        else i++
    }
    return src.length
}

/**
 * Where the declaration starting at `from` ends.
 *
 * Depth counts `{}`, `()` and `[]` together: a generic constraint list puts a
 * brace group inside a bracket group, and a multi-line one must not terminate
 * the declaration halfway through.
 */
function scanItem(src: string, from: number): number {
    let depth = 0
    let word = ''
    let lastChar = ''
    let i = from
    while (i < src.length) {
        const c = src[i]
        if (c === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i)
            i = nl < 0 ? src.length : nl
            continue
        }
        if (c === '/' && src[i + 1] === '*') {
            const close = src.indexOf('*/', i + 2)
            i = close < 0 ? src.length : close + 2
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            i = skipLiteral(src, i)
            lastChar = src[i - 1] ?? c
            word = ''
            continue
        }
        if (c === '\n') {
            if (depth <= 0 && endsStatement(word, lastChar)) return i + 1
            i++
            continue
        }
        if (c === '{' || c === '(' || c === '[') depth++
        else if (c === '}' || c === ')' || c === ']') depth--
        if (c !== ' ' && c !== '\t' && c !== '\r') {
            lastChar = c
            word = /[\p{L}\p{Nd}_]/u.test(c) ? word + c : ''
        }
        i++
    }
    return src.length
}

function endsStatement(word: string, lastChar: string): boolean {
    if (word !== '') return !CONTINUING_KEYWORDS.has(word)
    return STMT_END_CHAR_RE.test(lastChar)
}

/**
 * Split source into declarations. Works unchanged on a struct body or a const
 * group, whose members obey the same semicolon rule with no keyword in front.
 */
export function splitGoItems(src: string): GoItem[] {
    const items: GoItem[] = []
    let from = 0
    while (from < src.length) {
        const start = skipToCode(src, from)
        if (start >= src.length) break
        const end = scanItem(src, start)
        items.push({pending: src.slice(from, start), text: src.slice(start, end).trimEnd()})
        from = end
    }
    return items
}

/**
 * The top-level group whose closer is the last character of `text` — the
 * declaration's body, if it has one.
 */
function trailingGroup(text: string): number | null {
    let depth = 0
    let open = -1
    let found: number | null = null
    let i = 0
    while (i < text.length) {
        const c = text[i]
        if (c === '/' && text[i + 1] === '/') {
            const nl = text.indexOf('\n', i)
            i = nl < 0 ? text.length : nl
            continue
        }
        if (c === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2)
            i = close < 0 ? text.length : close + 2
            continue
        }
        if (c === '"' || c === "'" || c === '`') {
            i = skipLiteral(text, i)
            continue
        }
        if (c === '{' || c === '(' || c === '[') {
            if (depth === 0) open = i
            depth++
        } else if (c === '}' || c === ')' || c === ']') {
            depth--
            if (depth === 0 && i === text.length - 1) found = open
        }
        i++
    }
    return found
}

/** True when the first rune of `name` is an uppercase letter. */
export function isExported(name: string): boolean {
    const first = name.codePointAt(0)
    if (first === undefined) return false
    const c = String.fromCodePoint(first)
    return c !== c.toLowerCase() && c === c.toUpperCase()
}

/** The base type of a method's receiver, or null for a plain function. */
export function receiverType(text: string): string | null {
    return GO_FUNC_RE.exec(text)?.[1] ?? null
}

const RULE_CHARS = '[*=#+\\-_~/]'

/**
 * A decorative separator: a rule of punctuation, or a caption fenced by one on
 * both sides. A line reading `***** CONTEXT CREATION ****` documents nothing.
 */
function isBanner(line: string): boolean {
    const body = line
        .trim()
        .replace(/^\/\*|^\/\//, '')
        .replace(/\*\/$/, '')
        .trim()
    if (body.length < 4) return false
    return (
        new RegExp(`^${RULE_CHARS}+$`).test(body)
        || new RegExp(`^${RULE_CHARS}{3,}.*${RULE_CHARS}{3,}$`).test(body)
    )
}

/**
 * The comment paragraph attached to this declaration, or nothing.
 *
 * Only the last paragraph, and only when it ends on the line directly above —
 * the blank line before a licence header is what separates it from the code.
 */
export function keptPreamble(pending: string): string {
    if (pending === '' || /\n[ \t]*\n[ \t]*$/.test(pending)) return ''
    const text = pending.replace(/\s+$/, '')
    if (text === '') return ''

    let raw: string[]
    if (text.endsWith('*/')) {
        const open = text.lastIndexOf('/*')
        if (open < 0) return ''
        raw = text.slice(open).split('\n')
    } else {
        raw = []
        for (const line of text.split('\n').reverse()) {
            if (!line.trim().startsWith('//')) break
            raw.unshift(line.trim())
        }
    }

    const kept = raw.filter(line => {
        const directive = /^\/\/go:([a-z]+)/.exec(line.trim())
        if (directive) return KEPT_DIRECTIVES.has(directive[1])
        if (/^\/\/\s*nolint/i.test(line.trim())) return false
        return !isBanner(line)
    })
    if (kept.length === 0 || kept.some(l => LICENCE_RE.test(l))) return ''
    return kept.join('\n')
}

/**
 * The file's `//go:build` constraint, which applies to every declaration in it.
 *
 * `binding.go` and `binding_nomsgpack.go` declare the same twelve names under
 * opposite constraints, so a reader shown one without the banner cannot tell
 * which build they are reading.
 */
export function buildConstraint(src: string): string | null {
    for (const line of src.split('\n')) {
        const trimmed = line.trim()
        if (/^\/\/go:build\s/.test(trimmed)) return trimmed
        if (GO_ITEM_HEAD_RE.test(trimmed)) return null
    }
    return null
}

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function indent(lines: readonly string[]): string {
    return lines.map(l => `\t${l}`).join('\n')
}

/** A member with its doc comment above it, ready to sit inside a body. */
function renderMember(item: GoItem, body: string): string[] {
    const doc = keptPreamble(item.pending)
    return doc ? [...doc.split('\n'), body] : [body]
}

/** Strip a trailing line comment, leaving the code that carries the names. */
function withoutTrailingComment(text: string): string {
    const at = text.indexOf('//')
    if (at < 0) return text
    // A `//` inside a struct tag or a string is code, not a comment.
    const before = text.slice(0, at)
    const backticks = (before.match(/`/g) ?? []).length
    const quotes = (before.match(/"/g) ?? []).length
    return backticks % 2 === 0 && quotes % 2 === 0 ? before.trimEnd() : text
}

interface MemberNames {
    names: string[]
    /** What follows the names: the type, and the value when there is one. */
    rest: string
    embedded: boolean
}

function memberNames(text: string): MemberNames | null {
    const code = withoutTrailingComment(text)
    const embedded = GO_EMBEDDED_RE.exec(code)
    if (embedded) return {names: [embedded[1]], rest: '', embedded: true}
    const named = GO_MEMBER_NAME_RE.exec(code)
    if (!named) return null
    const names = named[1].split(',').map(s => s.trim())
    return {names, rest: code.slice(named[1].length).trim(), embedded: false}
}

/**
 * Keep the exported fields of a struct.
 *
 * A field line can declare several names (`Key, Value string`), so a mixed line
 * is rewritten to its exported half rather than kept or dropped whole.
 */
function structMembers(body: string): string[] {
    const out: string[] = []
    let dropped = false
    for (const item of splitGoItems(body)) {
        const parsed = memberNames(item.text)
        if (!parsed) continue
        const kept = parsed.names.filter(isExported)
        if (kept.length === 0) {
            dropped = true
            continue
        }
        const text =
            kept.length === parsed.names.length ? item.text : `${kept.join(', ')} ${parsed.rest}`
        out.push(...renderMember(item, text))
    }
    // godoc's own phrase, and the type is still worth naming: an opaque struct is
    // passed around by callers who never touch a field.
    if (out.length === 0) return dropped ? ['// contains filtered or unexported fields'] : []
    return out
}

/**
 * Every member of an interface, exported or not.
 *
 * The method set IS the contract, and an unexported method is the seal that
 * makes the interface unimplementable from outside — which a caller has to be
 * told about, not shielded from.
 */
function interfaceMembers(body: string): string[] {
    const out: string[] = []
    for (const item of splitGoItems(body)) {
        out.push(...renderMember(item, item.text))
    }
    return out
}

function elideInitializer(text: string): string {
    if (text.length <= INITIALIZER_LIMIT && !text.includes('\n')) return text
    const at = text.indexOf('=')
    return at < 0 ? collapse(text) : `${text.slice(0, at).trimEnd()} = /* value elided */`
}

/** `var _ Render = (*JSON)(nil)` — the only machine-readable "X implements Y". */
function isInterfaceAssertion(text: string): boolean {
    return new RegExp(String.raw`^(?:var\s+)?_\s+(${ID})\s*=\s*\(\*?(${ID})\)`, 'u').test(text)
}

/**
 * Members of a `const` or `var` group.
 *
 * An `iota` group is all-or-nothing: its members without `=` take positional
 * values, so dropping one silently renumbers every survivor.
 */
function groupMembers(body: string): string[] {
    const items = splitGoItems(body)
    const positional = /\biota\b/.test(body)
    const exported = (item: GoItem): boolean => {
        if (isInterfaceAssertion(item.text)) return true
        const parsed = memberNames(item.text)
        return parsed !== null && parsed.names.some(isExported)
    }
    if (positional) {
        return items.some(exported) ?
                items.flatMap(item => renderMember(item, elideInitializer(item.text)))
            :   []
    }
    return items.filter(exported).flatMap(item => renderMember(item, elideInitializer(item.text)))
}

interface Body {
    head: string
    inner: string
}

function splitBody(text: string): Body | null {
    const open = trailingGroup(text)
    if (open === null) return null
    return {head: text.slice(0, open + 1), inner: text.slice(open + 1, text.length - 1)}
}

function renderType(text: string): string | null {
    const name = GO_DECL_NAME_RE.exec(text)?.[1]
    if (name === undefined || !isExported(name)) return null
    const body = splitBody(text)
    if (!body || !GO_TYPE_BODY_RE.test(body.head.slice(0, -1))) return elideInitializer(text)
    const head = collapse(body.head)
    // The keyword immediately before the brace, never a substring search: a
    // generic constraint puts `interface` inside the type parameter list, and
    // `type Number[T interface{ ~int }] struct` would then keep every private
    // field an interface's members are exempt from.
    const members =
        /\binterface\s*\{$/.test(head) ? interfaceMembers(body.inner) : structMembers(body.inner)
    return members.length === 0 ? `${head}}` : `${head}\n${indent(members)}\n}`
}

/** A `type ( … )` group: each member is a whole declaration missing its keyword. */
function renderTypeGroup(inner: string): string[] {
    return splitGoItems(inner).flatMap(item => {
        const rendered = renderType(`type ${item.text}`)
        return rendered === null ? [] : renderMember(item, rendered)
    })
}

function renderFunc(text: string): string | null {
    const match = GO_FUNC_RE.exec(text)
    if (!match) return null
    const [, receiver, name] = match
    // A method on an unexported type cannot be called from outside the package,
    // however uppercase its own name is. gin's `fs.go` publishes two such calls
    // that do not compile, and `binding/` about thirty.
    if (receiver !== undefined && !isExported(receiver)) return null
    if (!isExported(name)) return null
    const body = splitBody(text)
    // No trailing `;`. Rust needs one to stay valid Rust; a bare Go signature is
    // exactly what `go doc` prints.
    return collapse(body ? text.slice(0, body.head.length - 1) : text)
}

function renderConstOrVar(text: string, kind: 'const' | 'var'): string[] {
    const body = splitBody(text)
    if (body && body.head.trimEnd().endsWith('(')) {
        const members = groupMembers(body.inner)
        return members.length === 0 ? [] : [`${kind} (\n${indent(members)}\n)`]
    }
    if (isInterfaceAssertion(text)) return [elideInitializer(text)]
    const name = GO_DECL_NAME_RE.exec(text)?.[1]
    if (name === undefined || !isExported(name)) return []
    return [elideInitializer(text)]
}

/**
 * One Go file reduced to the declarations a caller outside the package can use.
 */
export function goSurface(src: string): string {
    const out: string[] = []
    const constraint = buildConstraint(src)
    if (constraint) out.push(constraint, '')

    for (const item of splitGoItems(src)) {
        const kind = GO_ITEM_HEAD_RE.exec(item.text)?.[1]
        // Import paths are not API, and a file's own imports say nothing a caller
        // of it can act on.
        if (kind === undefined || kind === 'import') continue

        const doc = keptPreamble(item.pending)
        const push = (body: string): void => {
            if (doc) out.push(doc)
            out.push(body, '')
        }

        if (kind === 'package') {
            push(item.text)
            continue
        }
        if (kind === 'func') {
            const rendered = renderFunc(item.text)
            if (rendered) push(rendered)
            continue
        }
        if (kind === 'type') {
            const body = splitBody(item.text)
            if (body && /^type\s*\($/.test(body.head.trim())) {
                for (const member of renderTypeGroup(body.inner)) out.push(member, '')
                continue
            }
            const rendered = renderType(item.text)
            if (rendered) push(rendered)
            continue
        }
        for (const rendered of renderConstOrVar(item.text, kind as 'const' | 'var')) push(rendered)
    }

    return out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd()
}

/**
 * Everything reachable from {@link goSurface}, by source.
 *
 * `String(fn)` sees one level, and a helper left out of a list like this has
 * three times frozen every cached package on the rule it replaced.
 */
export function goContentFingerprint(): string {
    return [
        goSurface,
        splitGoItems,
        scanItem,
        endsStatement,
        skipToCode,
        skipLiteral,
        trailingGroup,
        splitBody,
        buildConstraint,
        keptPreamble,
        isBanner,
        isExported,
        receiverType,
        memberNames,
        withoutTrailingComment,
        structMembers,
        interfaceMembers,
        groupMembers,
        renderType,
        renderTypeGroup,
        renderFunc,
        renderConstOrVar,
        renderMember,
        elideInitializer,
        isInterfaceAssertion,
        collapse,
        indent
    ]
        .map(String)
        .concat([
            GO_ITEM_HEAD_RE.source,
            GO_FUNC_RE.source,
            GO_DECL_NAME_RE.source,
            GO_MEMBER_NAME_RE.source,
            GO_EMBEDDED_RE.source,
            GO_TYPE_BODY_RE.source,
            STMT_END_CHAR_RE.source,
            LICENCE_RE.source,
            RULE_CHARS,
            [...CONTINUING_KEYWORDS].join(','),
            [...KEPT_DIRECTIVES].join(','),
            String(INITIALIZER_LIMIT)
        ])
        .join(' ')
}
