"""Locate comment text in a TypeScript source file.

Shared by the comment-debt tooling. Code and string literals are never
reported, so a `//` inside a template literal or a `mx5` inside test data does
not count as a comment.
"""


def comment_spans(src):
    """Yield (start, end) index pairs of comment text in src.

    Tracks ${ } interpolation inside template literals with a stack. A nested
    template inside an interpolation otherwise flips the quote state at the wrong
    backtick and desynchronises the rest of the file, after which real comments
    are invisible and string bodies can be read as comments.
    """
    out, i, n = [], 0, len(src)
    stack = []          # 'template' / 'interp' frames, innermost last
    str_ch = None       # open ' or " (never spans a line in valid TS)
    while i < n:
        c, nx = src[i], src[i+1] if i+1 < n else ''
        if str_ch:
            if c == '\\': i += 2; continue
            if c == str_ch: str_ch = None
            i += 1; continue
        in_template = bool(stack) and stack[-1] == 'template'
        if in_template:
            if c == '\\': i += 2; continue
            if c == '$' and nx == '{':
                stack.append('interp'); i += 2; continue
            if c == '`':
                stack.pop(); i += 1; continue
            i += 1; continue
        # Ordinary code, or the inside of a ${ } interpolation.
        if c == '/' and nx == '/':
            j = src.find('\n', i)
            j = n if j < 0 else j
            out.append((i, j)); i = j; continue
        if c == '/' and nx == '*':
            j = src.find('*/', i+2)
            j = n if j < 0 else j+2
            out.append((i, j)); i = j; continue
        if c == '`':
            stack.append('template'); i += 1; continue
        if c in '"\'':
            str_ch = c; i += 1; continue
        if c == '{' and stack and stack[-1] == 'interp':
            stack.append('interp')      # a nested brace, popped by its own }
        elif c == '}' and stack and stack[-1] == 'interp':
            stack.pop()
        i += 1
    return out
