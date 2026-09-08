/**
 * Every case here is a shape that broke a draft of `goSurface`, or one the Rust
 * extractor it is modelled on gets right for a reason that does not carry over.
 */
import {describe, expect, test} from 'bun:test'
import {
    goSurface,
    splitGoItems,
    buildConstraint,
    isExported,
    receiverType,
    keptPreamble,
    goContentFingerprint,
    GO_DECL_SPLIT_RE,
    GO_MEMBER_SPLIT_RE
} from '../../src/workers/go-surface.js'

const BACKTICK = '`'

describe('splitGoItems', () => {
    test('ends a declaration where Go would insert a semicolon', () => {
        const items = splitGoItems('package p\n\ntype H map[string]any\n\nconst A = 1\n')
        expect(items.map(i => i.text)).toEqual([
            'package p',
            'type H map[string]any',
            'const A = 1'
        ])
    })

    test('a wrapped signature is one item, not one per line', () => {
        const items = splitGoItems('func Foo(\n\ta int,\n\tb int,\n) error {\n\treturn nil\n}\n')
        expect(items).toHaveLength(1)
    })

    test('a brace inside a raw string does not desynchronise the scan', () => {
        const src = `package p\n\nvar Raw = ${BACKTICK}{"a": 1}${BACKTICK}\n\nfunc A() {}\n`
        expect(splitGoItems(src).map(i => i.text)).toEqual([
            'package p',
            `var Raw = ${BACKTICK}{"a": 1}${BACKTICK}`,
            'func A() {}'
        ])
    })

    test('a brace inside a comment does not desynchronise the scan', () => {
        const src = 'package p\n\n// closes with }\nfunc A() {}\n\nfunc B() {}\n'
        expect(splitGoItems(src)).toHaveLength(3)
    })

    test('a multi-line generic constraint stays inside its declaration', () => {
        const items = splitGoItems(
            'type N[T interface {\n\t~int | ~float64\n}] struct {\n\tV T\n}\n'
        )
        expect(items).toHaveLength(1)
    })
})

describe('goSurface', () => {
    test('keeps the package clause and drops the import block', () => {
        const out = goSurface('package gin\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc A() {}\n')
        expect(out).toContain('package gin')
        expect(out).not.toContain('"fmt"')
    })

    test('a signature with interface{} keeps its whole head', () => {
        const out = goSurface(
            'package p\n\nfunc Bind(val interface{}) HandlerFunc {\n\treturn nil\n}\n'
        )
        expect(out).toContain('func Bind(val interface{}) HandlerFunc')
        expect(out).not.toContain('return nil')
    })

    test('a bare signature carries no trailing semicolon', () => {
        expect(goSurface('package p\n\nfunc A() error {\n\treturn nil\n}\n')).toContain(
            'func A() error'
        )
        expect(goSurface('package p\n\nfunc A() error {\n\treturn nil\n}\n')).not.toContain(';')
    })

    test('drops a method whose receiver type is unexported', () => {
        const src =
            'package gin\n\n'
            + 'type onlyFilesFS struct{ fs http.FileSystem }\n\n'
            + 'func (fs onlyFilesFS) Open(name string) (http.File, error) { return nil, nil }\n\n'
            + 'func Dir(root string) http.FileSystem { return nil }\n'
        const out = goSurface(src)
        expect(out).toContain('func Dir(root string) http.FileSystem')
        expect(out).not.toContain('Open(name string)')
    })

    test('keeps a method on an exported receiver, pointer or not', () => {
        const src =
            'package p\n\ntype Params []Param\n\n'
            + 'func (ps Params) Get(name string) (string, bool) { return "", false }\n\n'
            + 'func (e *Error) SetType(f ErrorType) *Error { return e }\n'
        const out = goSurface(src)
        expect(out).toContain('func (ps Params) Get(name string) (string, bool)')
        expect(out).toContain('func (e *Error) SetType(f ErrorType) *Error')
    })

    test('keeps exported struct fields and says the rest are hidden', () => {
        const src =
            'package p\n\ntype Context struct {\n'
            + '\tRequest *http.Request\n'
            + '\twritermem responseWriter\n'
            + '\tKeys map[string]any\n'
            + '}\n'
        const out = goSurface(src)
        expect(out).toContain('Request *http.Request')
        expect(out).toContain('Keys map[string]any')
        expect(out).not.toContain('writermem')
    })

    test('a struct with nothing exported keeps its name and hides its fields', () => {
        const out = goSurface('package p\n\ntype Opaque struct {\n\ta int\n\tb string\n}\n')
        expect(out).toContain('type Opaque struct {')
        expect(out).toContain('contains filtered or unexported fields')
        expect(out).not.toContain('a int')
    })

    test('a field line declaring several names keeps only its exported half', () => {
        const out = goSurface('package p\n\ntype M struct {\n\tA, b int\n\tC string\n}\n')
        expect(out).toContain('A int')
        expect(out).toContain('C string')
        expect(out).not.toContain('A, b int')
    })

    test('an embedded field is kept by the exportedness of its last segment', () => {
        const src =
            'package p\n\ntype R struct {\n\tRouterGroup\n\thttp.File\n\t*sync.Mutex\n\tinternal\n}\n'
        const out = goSurface(src)
        expect(out).toContain('RouterGroup')
        expect(out).toContain('http.File')
        expect(out).toContain('*sync.Mutex')
        expect(out).not.toContain('\tinternal\n')
    })

    test('every interface member is kept, unexported ones included', () => {
        const src =
            'package p\n\ntype Reader interface {\n'
            + '\tRead(p []byte) (int, error)\n'
            + '\tprivate()\n'
            + '}\n'
        const out = goSurface(src)
        expect(out).toContain('Read(p []byte) (int, error)')
        expect(out).toContain('private()')
    })

    test('a generic constraint named interface does not exempt the struct fields', () => {
        const src =
            'package p\n\ntype N[T interface {\n\t~int | ~float64\n}] struct {\n\tV T\n\th int\n}\n'
        const out = goSurface(src)
        expect(out).toContain('V T')
        expect(out).not.toContain('h int')
    })

    test('a generic signature keeps its type parameters', () => {
        const out = goSurface(
            'package lo\n\nfunc Map[T, R any](c []T, f func(T, int) R) []R {\n\treturn nil\n}\n'
        )
        expect(out).toContain('func Map[T, R any](c []T, f func(T, int) R) []R')
    })

    test('a type whose definition merely ends in a brace is kept whole', () => {
        const out = goSurface('package p\n\ntype Set[T comparable] map[T]struct{}\n')
        expect(out).toContain('type Set[T comparable] map[T]struct{}')
    })
})

describe('goSurface const and var groups', () => {
    test('an iota group with nothing exported goes whole', () => {
        const src = 'package p\n\nconst (\n\tdebugCode = iota\n\treleaseCode\n\ttestCode\n)\n'
        const out = goSurface(src)
        expect(out).not.toContain('releaseCode')
        expect(out).not.toContain('const (')
    })

    test('an iota group with an exported member keeps every member', () => {
        const src = 'package p\n\nconst (\n\tDebugCode = iota\n\treleaseCode\n\ttestCode\n)\n'
        const out = goSurface(src)
        // Dropping `releaseCode` would silently renumber `testCode`.
        expect(out).toContain('releaseCode')
        expect(out).toContain('testCode')
    })

    test('an explicit group keeps its exported members and their values', () => {
        const src = 'package p\n\nconst (\n\tMIMEJSON = "application/json"\n\tinternalX = "no"\n)\n'
        const out = goSurface(src)
        expect(out).toContain('MIMEJSON = "application/json"')
        expect(out).not.toContain('internalX')
    })

    test('a long value is elided and a short one is not', () => {
        const src = 'package p\n\nvar Short = 1\n\n' + `var Long = []string{"${'x'.repeat(200)}"}\n`
        const out = goSurface(src)
        expect(out).toContain('var Short = 1')
        expect(out).toContain('var Long = /* value elided */')
    })

    test('keeps the blank-identifier assertion that names an implementation', () => {
        const src =
            'package render\n\nvar (\n\t_ Render = (*JSON)(nil)\n\t_ Render = (*XML)(nil)\n)\n'
        const out = goSurface(src)
        expect(out).toContain('_ Render = (*JSON)(nil)')
        expect(out).toContain('_ Render = (*XML)(nil)')
    })

    test('a type group keeps its exported members only', () => {
        const src = 'package p\n\ntype (\n\tPublic struct {\n\t\tA int\n\t}\n\tprivate int\n)\n'
        const out = goSurface(src)
        expect(out).toContain('type Public struct {')
        expect(out).toContain('A int')
        expect(out).not.toContain('private')
    })
})

describe('keptPreamble', () => {
    test('keeps the paragraph directly above the declaration', () => {
        expect(keptPreamble('// Dir returns a FileSystem.\n// It is used by Static().\n')).toBe(
            '// Dir returns a FileSystem.\n// It is used by Static().'
        )
    })

    test('a blank line between the comment and the declaration detaches it', () => {
        expect(keptPreamble('// Not attached.\n\n')).toBe('')
    })

    test('drops a licence header rather than reprinting it into every chunk', () => {
        expect(keptPreamble('// Copyright 2014 Manu. All rights reserved.\n// MIT style\n')).toBe(
            ''
        )
    })

    test('drops a banner comment and build tooling, keeps a semantic directive', () => {
        expect(keptPreamble('//go:generate stringer -type=X\n')).toBe('')
        expect(keptPreamble('//nolint: errcheck\n')).toBe('')
        expect(keptPreamble('/*******************/\n')).toBe('')
        expect(keptPreamble('//go:embed static\n')).toBe('//go:embed static')
    })

    test('keeps a doc comment that does not begin with the declaration name', () => {
        // Enforcing the convention deletes real documentation: gin's `// Trusted
        // platforms` sits above a `const (` group that names nothing.
        expect(keptPreamble('// Trusted platforms\n')).toBe('// Trusted platforms')
    })

    test('keeps an adjacent block comment', () => {
        expect(keptPreamble('/*\nPackage gin implements a web framework.\n*/\n')).toContain(
            'Package gin'
        )
    })

    test('a doc comment survives onto the declaration it belongs to', () => {
        const src = '// A does a thing.\nfunc A() {}\n'
        expect(goSurface(`package p\n\n${src}`)).toContain('// A does a thing.\nfunc A()')
    })

    test('the licence header does not migrate onto the package clause', () => {
        const src =
            '// Copyright 2014 Manu.\n// Use of this source code is governed by MIT.\n\npackage gin\n\nfunc A() {}\n'
        expect(goSurface(src)).not.toContain('Copyright')
    })
})

describe('buildConstraint', () => {
    test('reads the file-level constraint and hoists it into the surface', () => {
        const src = '//go:build !nomsgpack\n\npackage binding\n\nfunc A() {}\n'
        expect(buildConstraint(src)).toBe('//go:build !nomsgpack')
        expect(goSurface(src).startsWith('//go:build !nomsgpack')).toBe(true)
    })

    test('no constraint on a file that declares none', () => {
        expect(buildConstraint('package p\n\nfunc A() {}\n')).toBeNull()
    })

    test('a //go:build below the package clause is not the file constraint', () => {
        expect(buildConstraint('package p\n\n//go:build linux\nfunc A() {}\n')).toBeNull()
    })
})

describe('isExported and receiverType', () => {
    test('the first rune decides, by code point and not by byte', () => {
        expect(isExported('Dir')).toBe(true)
        expect(isExported('dir')).toBe(false)
        expect(isExported('_x')).toBe(false)
        expect(isExported('Ünique')).toBe(true)
        expect(isExported('ünique')).toBe(false)
        expect(isExported('')).toBe(false)
    })

    test('finds the receiver base type through every spelling', () => {
        expect(receiverType('func (c *Context) JSON(code int) {}')).toBe('Context')
        expect(receiverType('func (Foo) Bar() {}')).toBe('Foo')
        expect(receiverType('func (s *Stack[T]) Push(v T) {}')).toBe('Stack')
        expect(receiverType('func Dir(root string) {}')).toBeNull()
    })
})

describe('split regexes', () => {
    test('declarations anchor at column zero only', () => {
        expect(GO_DECL_SPLIT_RE.test('func A()')).toBe(true)
        expect(GO_DECL_SPLIT_RE.test('type H int')).toBe(true)
        // An indented field must not be cut into a chunk of its own.
        expect(new RegExp(GO_DECL_SPLIT_RE.source, 'm').test('\tvar x int')).toBe(false)
    })

    test('members anchor on the keyword-less shapes Go alone has', () => {
        const member = (s: string): boolean => new RegExp(GO_MEMBER_SPLIT_RE.source, 'mu').test(s)
        expect(member('\tRequest *http.Request')).toBe(true)
        expect(member('\tRead(p []byte) (int, error)')).toBe(true)
        expect(member('\tMIMEJSON = "application/json"')).toBe(true)
        expect(member('\tKey, Value string')).toBe(true)
    })
})

describe('goContentFingerprint', () => {
    test('carries the helpers below the entry point, not just goSurface', () => {
        const fp = goContentFingerprint()
        expect(fp).toContain('structMembers')
        expect(fp).toContain('interfaceMembers')
        expect(fp).toContain('trailingGroup')
        expect(fp.length).toBeGreaterThan(String(goSurface).length * 4)
    })
})
