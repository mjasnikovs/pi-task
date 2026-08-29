// Generalized single-pass syntax highlighter, shipped as a JS string and
// concatenated into the page by ui.ts. One string/comment/number/identifier
// tokenizer, parameterized by a per-language config in HL_LANGS (keyword set +
// comment markers + string flavors). A language with no entry there falls back
// to escaped plain text with no spans at all.
//
// Depends on escHtml (ui-render.ts) — ui.ts emits renderModule() immediately
// before highlightModule(), inside one <script>.

/** Emitted client JS (top-level function declarations + language tables). */
export function highlightModule(): string {
    return `    var HL_JS_KW = new Set(('break case catch class const continue debugger default delete do else export '
      + 'extends finally for from function if import in instanceof let new of return static super switch this '
      + 'throw try typeof var void while with yield async await type interface enum implements abstract as declare '
      + 'namespace readonly undefined null true false override satisfies public private protected get set').split(' '));
    var HL_PY_KW = new Set(('def return if elif else for while in not and or import from as class try except finally '
      + 'raise with lambda yield pass break continue global nonlocal assert del None True False async await is print self').split(' '));
    var HL_SH_KW = new Set(('if then else elif fi for while do done case esac in function return echo export local read '
      + 'cd set unset source alias exit test').split(' '));
    var HL_SQL_KW = new Set(('select from where insert into values update set delete create table drop alter add column '
      + 'join left right inner outer full on group by order having limit offset union and or not null is as distinct '
      + 'count sum avg min max primary key foreign references index unique default int integer text varchar char boolean '
      + 'timestamp date time serial begin commit rollback').split(' '));
    var HL_GO_KW = new Set(('func package import var const type struct interface map chan go defer return if else for range '
      + 'switch case default break continue select nil true false make new append len cap string int int64 float64 bool byte rune error').split(' '));
    var HL_RUST_KW = new Set(('fn let mut const static struct enum impl trait pub use mod match if else for while loop return '
      + 'break continue self Self super crate as where move ref dyn async await unsafe true false None Some Ok Err String Vec Option Result Box').split(' '));
    var HL_YAML_KW = new Set('true false null yes no on off'.split(' '));
    var HL_JSON_KW = new Set('true false null'.split(' '));

    var HL_LANGS = {
      js:     {kw: HL_JS_KW,   line: '//', block: ['/*', '*/'], tmpl: true},
      ts:     {kw: HL_JS_KW,   line: '//', block: ['/*', '*/'], tmpl: true},
      python: {kw: HL_PY_KW,   line: '#',  block: null,         triple: true},
      sh:     {kw: HL_SH_KW,   line: '#',  block: null},
      sql:    {kw: HL_SQL_KW,  line: '--', block: ['/*', '*/'], ci: true},
      go:     {kw: HL_GO_KW,   line: '//', block: ['/*', '*/'], tmpl: true},
      rust:   {kw: HL_RUST_KW, line: '//', block: ['/*', '*/']},
      yaml:   {kw: HL_YAML_KW, line: '#',  block: null},
      json:   {kw: HL_JSON_KW, line: null, block: null},
      css:    {kw: null,       line: null, block: ['/*', '*/']}
    };
    var HL_ALIAS = {javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', node: 'js', typescript: 'ts', tsx: 'ts',
      py: 'python', python3: 'python', bash: 'sh', shell: 'sh', shellscript: 'sh', zsh: 'sh', console: 'sh',
      yml: 'yaml', rs: 'rust', golang: 'go', htm: 'html', xml: 'html', svg: 'html', scss: 'css'};

    function hlSpan(cls, text) { return '<span class="' + cls + '">' + escHtml(text) + '</span>'; }

    function tokenize(code, cfg) {
      var BT = String.fromCharCode(96);
      var r = '', i = 0, n = code.length;
      while (i < n) {
        var ch = code[i];
        if (cfg.block && code.startsWith(cfg.block[0], i)) {
          var end = code.indexOf(cfg.block[1], i + cfg.block[0].length);
          var je = end < 0 ? n : end + cfg.block[1].length;
          r += hlSpan('hl-cmt', code.slice(i, je)); i = je; continue;
        }
        if (cfg.line && code.startsWith(cfg.line, i)) {
          var jl = i; while (jl < n && code[jl] !== '\\n') jl++;
          r += hlSpan('hl-cmt', code.slice(i, jl)); i = jl; continue;
        }
        if (ch === '"' || ch === "'" || (cfg.tmpl && ch === BT)) {
          if (cfg.triple && code[i + 1] === ch && code[i + 2] === ch) {
            var close = code.indexOf(ch + ch + ch, i + 3);
            var jt = close < 0 ? n : close + 3;
            r += hlSpan('hl-str', code.slice(i, jt)); i = jt; continue;
          }
          var js = i + 1;
          while (js < n) { if (code[js] === '\\\\') { js += 2; continue; } if (code[js] === ch || code[js] === '\\n') break; js++; }
          if (code[js] === ch) js++;
          r += hlSpan('hl-str', code.slice(i, js)); i = js; continue;
        }
        if (ch >= '0' && ch <= '9') {
          var jn = i;
          if (code[i] === '0' && /[xXoObB]/.test(code[i + 1] || '')) {
            jn += 2; while (jn < n && /[0-9a-fA-F_]/.test(code[jn])) jn++;
          } else {
            while (jn < n && ((code[jn] >= '0' && code[jn] <= '9') || code[jn] === '_')) jn++;
            if (code[jn] === '.') { jn++; while (jn < n && code[jn] >= '0' && code[jn] <= '9') jn++; }
            if (code[jn] === 'e' || code[jn] === 'E') { jn++; if (code[jn] === '+' || code[jn] === '-') jn++; while (jn < n && code[jn] >= '0' && code[jn] <= '9') jn++; }
            if (code[jn] === 'n') jn++;
          }
          r += hlSpan('hl-num', code.slice(i, jn)); i = jn; continue;
        }
        if (/[a-zA-Z_$]/.test(ch)) {
          var jw = i; while (jw < n && /[a-zA-Z0-9_$]/.test(code[jw])) jw++;
          var word = code.slice(i, jw);
          var kwHit = cfg.kw && (cfg.kw.has(word) || (cfg.ci && cfg.kw.has(word.toLowerCase())));
          if (kwHit) r += hlSpan('hl-kw', word);
          else if (code[jw] === '(') r += hlSpan('hl-fn', word);
          else r += escHtml(word);
          i = jw; continue;
        }
        r += escHtml(ch); i++;
      }
      return r;
    }

    // Markup languages don't fit the identifier tokenizer; highlight tag names and
    // attribute names off the already-escaped text.
    function highlightMarkup(code) {
      var e = escHtml(code);
      // Attribute names first (before any spans exist), then tag names — otherwise
      // the attribute pass would re-match the class="" inside the spans it inserted.
      e = e.replace(/([a-zA-Z-]+)=("|&quot;)/g, function (_, a, q) { return '<span class="hl-fn">' + a + '</span>=' + q; });
      e = e.replace(/(&lt;\\/?)([a-zA-Z][\\w-]*)/g, function (_, p, t) { return p + '<span class="hl-kw">' + t + '</span>'; });
      return e;
    }

    function syntaxHighlight(code, lang) {
      code = String(code == null ? '' : code);
      lang = (lang || '').toLowerCase();
      lang = HL_ALIAS[lang] || lang;
      if (lang === 'html') return highlightMarkup(code);
      var cfg = HL_LANGS[lang];
      if (!cfg) return escHtml(code);
      return tokenize(code, cfg);
    }
`
}
