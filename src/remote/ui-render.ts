// Pure string→HTML render helpers, shipped to the browser as a JS string and
// concatenated into the page by ui.ts BEFORE clientScript. Splitting these out
// of the 900-line client template gives them a testability seam: each emitted
// function is `new Function`-eval'd in a unit test and asserted on its return
// value, with no DOM needed. (The shipped fence bug survived because the client
// JS was never executed by any test — only string-matched.)
//
// Exposes (as top-level fn declarations in the page's single <script>):
//   escHtml(s)           — HTML-escape & < >
//   parseBlocks(text)    — line-based fence scanner (text vs code segments)
//   renderInline(s)      — inline markdown (bold/italic/strike/code/links)
//   renderMarkdown(text) — full block-level markdown → HTML string
// renderMarkdown calls syntaxHighlight (ui-highlight.ts); both land in the same
// <script>, so declaration order across the concatenated modules doesn't matter.

/** Emitted client JS (top-level function declarations). */
export function renderModule(): string {
    return `    function escHtml(s) {
      return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Split text into ordered {type:'text'|'code', ...} blocks by scanning lines
    // for a fenced code marker at line start. This replaces a RegExp that was built
    // from a string where '[\\\\s\\\\S]' collapsed to '[sS]', so it matched nothing
    // and every code block rendered as raw text. A line scanner also tolerates an
    // unclosed trailing fence, which the regex never could.
    function parseBlocks(text) {
      var FENCE = String.fromCharCode(96, 96, 96);
      var lines = String(text == null ? '' : text).split('\\n');
      var blocks = [];
      var textBuf = [];
      function flushText() {
        if (textBuf.length) { blocks.push({type: 'text', content: textBuf.join('\\n')}); textBuf = []; }
      }
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        if (line.slice(0, 3) === FENCE) {
          flushText();
          var lang = line.slice(3).trim();
          var codeLines = [];
          i++;
          while (i < lines.length && lines[i].trim() !== FENCE) { codeLines.push(lines[i]); i++; }
          if (i < lines.length) i++; // consume the closing fence; tolerate EOF (unclosed)
          blocks.push({type: 'code', lang: lang, content: codeLines.join('\\n')});
        } else {
          textBuf.push(line);
          i++;
        }
      }
      flushText();
      return blocks;
    }

    // Inline formatting on ONE line's worth of text. Code spans are extracted first
    // (and protected with a NUL placeholder) so emphasis inside them is left alone.
    function renderInline(s) {
      s = escHtml(String(s == null ? '' : s));
      var BT = String.fromCharCode(96);
      var codes = [];
      var codeRe = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
      s = s.replace(codeRe, function (_, c) { codes.push(c); return '\\u0000' + (codes.length - 1) + '\\u0000'; });
      s = s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, function (_, t, u) {
        var safe = /^(https?:|mailto:)/i.test(u) ? u : '#';
        return '<a href="' + safe + '" target="_blank" rel="noopener">' + t + '</a>';
      });
      s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
      s = s.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
      s = s.replace(/\\u0000(\\d+)\\u0000/g, function (_, n) { return '<code class="md-code">' + codes[n] + '</code>'; });
      return s;
    }

    // A line that begins a block-level construct — used to stop paragraph grouping.
    function mdIsSpecial(l) {
      return /^(#{1,6})\\s+/.test(l)
        || /^\\s*>\\s?/.test(l)
        || /^\\s*([-*+]|\\d+\\.)\\s+/.test(l)
        || /^\\s*([-*_])\\s*(\\1\\s*){2,}$/.test(l);
    }

    function mdParseList(lines, i) {
      var ordered = /^\\s*\\d+\\.\\s+/.test(lines[i]);
      var tag = ordered ? 'ol' : 'ul';
      var items = '';
      while (i < lines.length && /^\\s*([-*+]|\\d+\\.)\\s+/.test(lines[i])) {
        var content = lines[i].replace(/^\\s*([-*+]|\\d+\\.)\\s+/, '');
        var task = /^\\[([ xX])\\]\\s+(.*)$/.exec(content);
        if (task) {
          var checked = task[1].toLowerCase() === 'x';
          items += '<li class="md-task"><span class="md-check">' + (checked ? '\\u2611' : '\\u2610') + '</span> ' + renderInline(task[2]) + '</li>';
        } else {
          items += '<li>' + renderInline(content) + '</li>';
        }
        i++;
      }
      return {html: '<' + tag + ' class="md-list">' + items + '</' + tag + '>', next: i};
    }

    function mdParseTable(lines, i) {
      function cells(l) {
        var s = l.trim().replace(/^\\|/, '').replace(/\\|$/, '');
        return s.split('|').map(function (c) { return c.trim(); });
      }
      var head = cells(lines[i]);
      i += 2; // skip the header row and the |---| separator
      var body = '';
      while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim() !== '') {
        var row = cells(lines[i]);
        var tds = '';
        for (var c = 0; c < row.length; c++) tds += '<td>' + renderInline(row[c]) + '</td>';
        body += '<tr>' + tds + '</tr>';
        i++;
      }
      var ths = '';
      for (var c2 = 0; c2 < head.length; c2++) ths += '<th>' + renderInline(head[c2]) + '</th>';
      return {html: '<table class="md-table"><thead><tr>' + ths + '</tr></thead><tbody>' + body + '</tbody></table>', next: i};
    }

    // Block-level markdown for one text segment (no fences — those are split off by
    // renderMarkdown first). Headers, hr, blockquotes, tables, lists, paragraphs.
    function renderProse(src) {
      var lines = String(src == null ? '' : src).split('\\n');
      var html = '';
      var i = 0;
      while (i < lines.length) {
        var line = lines[i];
        if (line.trim() === '') { i++; continue; }
        var h = /^(#{1,6})\\s+(.*)$/.exec(line);
        if (h) { var lvl = h[1].length; html += '<h' + lvl + ' class="md-h md-h' + lvl + '">' + renderInline(h[2]) + '</h' + lvl + '>'; i++; continue; }
        if (/^\\s*([-*_])\\s*(\\1\\s*){2,}$/.test(line)) { html += '<hr class="md-hr">'; i++; continue; }
        if (/^\\s*>\\s?/.test(line)) {
          var q = [];
          while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) { q.push(lines[i].replace(/^\\s*>\\s?/, '')); i++; }
          html += '<blockquote class="md-quote">' + renderProse(q.join('\\n')) + '</blockquote>';
          continue;
        }
        if (/\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|?[\\s:|-]*-[\\s:|-]*\\|?\\s*$/.test(lines[i + 1])) {
          var t = mdParseTable(lines, i); html += t.html; i = t.next; continue;
        }
        if (/^\\s*([-*+]|\\d+\\.)\\s+/.test(line)) {
          var lst = mdParseList(lines, i); html += lst.html; i = lst.next; continue;
        }
        var para = [];
        while (i < lines.length && lines[i].trim() !== '' && !mdIsSpecial(lines[i])) { para.push(lines[i]); i++; }
        var inner = [];
        for (var p = 0; p < para.length; p++) inner.push(renderInline(para[p]));
        html += '<p class="md-p">' + inner.join('<br>') + '</p>';
      }
      return html;
    }

    function renderMarkdown(text) {
      var blocks = parseBlocks(text);
      var out = '';
      for (var k = 0; k < blocks.length; k++) {
        var b = blocks[k];
        if (b.type === 'code') {
          out += '<div class="code-block">'
            + (b.lang ? '<div class="code-lang">' + escHtml(b.lang) + '</div>' : '')
            + '<pre><code>' + syntaxHighlight(b.content, b.lang) + '</code></pre></div>';
        } else {
          out += renderProse(b.content);
        }
      }
      return out;
    }
`
}
