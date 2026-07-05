// Tool-call presentation helpers, shipped as a JS string and concatenated into
// the page by ui.ts. Turns raw {toolName, args} into a readable one-line summary,
// a +N −M diff badge, and an expandable line-diff body for edit/write tools —
// replacing the old "name + JSON.stringify(args) hard-sliced at 64 chars".
//
// Depends on escHtml (ui-render.ts) — both land in the same <script>.

/** Emitted client JS (top-level function declarations). */
export function toolsModule(): string {
    return `    // args arrives as an object (live tool_start / snapshot part) or a JSON string.
    function toolArgs(args) {
      if (args && typeof args === 'object') return args;
      if (typeof args === 'string') { try { return JSON.parse(args); } catch (e) { return null; } }
      return null;
    }

    // A readable one-line summary. Falls back to the old name+JSON form (but with NO
    // hard 64-char slice — the summary line ellipsizes via CSS, full text on hover).
    function toolSummary(toolName, args) {
      var name = (toolName || '').toLowerCase();
      var a = toolArgs(args);
      function s(v) { return v == null ? '' : String(v); }
      if (a) {
        var path = a.path != null ? a.path : a.file_path;
        if (name.indexOf('bash') >= 0 && a.command != null) return '$ ' + s(a.command);
        if (name === 'read' && path != null) return 'read ' + s(path);
        if ((name === 'edit' || name === 'multiedit' || name === 'write' || name === 'str_replace') && path != null) return s(path);
        if (name === 'grep' || name === 'find' || name === 'glob' || name === 'search') {
          var pat = a.pattern != null ? a.pattern : (a.query != null ? a.query : a.glob);
          var loc = a.path != null ? a.path : a.glob;
          return name + ' ' + s(pat) + (loc && loc !== pat ? '  ' + s(loc) : '');
        }
      }
      var argStr = typeof args === 'string' ? args : (args === undefined ? '' : JSON.stringify(args));
      return toolName + (argStr ? ': ' + argStr : '');
    }

    // Line diff via LCS. Bounded: a huge pair falls back to "all removed / all added"
    // rather than allocating an O(m*n) table that could hang the tab.
    function lcsDiff(oldText, newText) {
      // Treat '' / null as ZERO lines (not one empty line) so a new-file write shows
      // as all-added with no phantom "removed blank line".
      var a = (oldText == null || oldText === '') ? [] : String(oldText).split('\\n');
      var b = (newText == null || newText === '') ? [] : String(newText).split('\\n');
      var m = a.length, n = b.length;
      var rows = [];
      if (m * n > 250000) {
        for (var x = 0; x < m; x++) rows.push({t: '-', s: a[x]});
        for (var y = 0; y < n; y++) rows.push({t: '+', s: b[y]});
        return rows;
      }
      var dp = [];
      for (var i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
      for (var i2 = m - 1; i2 >= 0; i2--)
        for (var j2 = n - 1; j2 >= 0; j2--)
          dp[i2][j2] = a[i2] === b[j2] ? dp[i2 + 1][j2 + 1] + 1 : Math.max(dp[i2 + 1][j2], dp[i2][j2 + 1]);
      var i = 0, j = 0;
      while (i < m && j < n) {
        if (a[i] === b[j]) { rows.push({t: ' ', s: a[i]}); i++; j++; }
        else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({t: '-', s: a[i]}); i++; }
        else { rows.push({t: '+', s: b[j]}); j++; }
      }
      while (i < m) { rows.push({t: '-', s: a[i++]}); }
      while (j < n) { rows.push({t: '+', s: b[j++]}); }
      return rows;
    }

    function diffStats(oldText, newText) {
      var rows = lcsDiff(oldText, newText), add = 0, rem = 0;
      for (var k = 0; k < rows.length; k++) { if (rows[k].t === '+') add++; else if (rows[k].t === '-') rem++; }
      return {added: add, removed: rem};
    }

    function renderDiff(oldText, newText) {
      var rows = lcsDiff(oldText, newText);
      var html = '<div class="diff">';
      for (var k = 0; k < rows.length; k++) {
        var r = rows[k];
        var cls = r.t === '+' ? 'diff-add' : (r.t === '-' ? 'diff-del' : 'diff-ctx');
        html += '<div class="diff-line ' + cls + '"><span class="diff-sign">' + (r.t === ' ' ? ' ' : r.t) + '</span>' + escHtml(r.s) + '</div>';
      }
      return html + '</div>';
    }

    // The old/new text for an edit/write tool's diff, or null if not a diffable tool.
    function toolDiffPair(toolName, args) {
      var name = (toolName || '').toLowerCase();
      var a = toolArgs(args);
      if (!a) return null;
      if (name === 'edit' || name === 'multiedit' || name === 'str_replace') {
        if (a.old_string != null || a.new_string != null) return {old: a.old_string, neu: a.new_string};
      }
      if (name === 'write' && a.content != null) return {old: '', neu: a.content};
      return null;
    }

    function toolBadge(toolName, args) {
      var pair = toolDiffPair(toolName, args);
      return pair ? diffStats(pair.old, pair.neu) : null;
    }

    function toolDiffHtml(toolName, args) {
      var pair = toolDiffPair(toolName, args);
      return pair ? renderDiff(pair.old, pair.neu) : null;
    }

    function fmtElapsed(ms) {
      if (ms == null || isNaN(ms)) return '';
      if (ms < 1000) return Math.round(ms) + 'ms';
      var sec = ms / 1000;
      return (sec < 10 ? sec.toFixed(1) : Math.round(sec)) + 's';
    }
`
}
