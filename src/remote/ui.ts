import {STYLES} from './ui-styles.js'
import {clientScript} from './ui-script.js'
import {renderModule} from './ui-render.js'
import {highlightModule} from './ui-highlight.js'
import {toolsModule} from './ui-tools.js'

export function html(wsUrl: string): string {
    const iconSvg = encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">`
            + `<rect width="180" height="180" rx="38" fill="#1e1e2e"/>`
            + `<text x="90" y="130" font-family="Georgia,serif" font-size="100" `
            + `text-anchor="middle" fill="#cba6f7">π</text></svg>`
    )
    const iconUrl = `data:image/svg+xml,${iconSvg}`
    const manifest = encodeURIComponent(
        JSON.stringify({
            name: 'pi-task remote',
            short_name: 'pi-task remote',
            display: 'standalone',
            background_color: '#1e1e2e',
            theme_color: '#1e1e2e',
            icons: [{src: iconUrl, sizes: 'any', type: 'image/svg+xml'}]
        })
    )
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="pi-task remote">
  <meta name="theme-color" content="#1e1e2e">
  <link rel="apple-touch-icon" href="${iconUrl}">
  <link rel="manifest" href="data:application/manifest+json,${manifest}">
  <title>pi-task remote</title>
  <style>
${STYLES}
  </style>
</head>
<body>
  <div id="context-bar"><div id="context-bar-fill"></div></div>
  <div id="header">
    <span class="title">pi-task remote</span>
    <div class="hgroup">
      <span id="status-chip" title="Connection · model · context">
        <span id="status-dot" class="disconnected"></span>
        <span id="status-model"></span>
        <span id="status-ctx"></span>
      </span>
      <button id="bell" aria-label="Notifications" title="Notifications">&#x25EF;</button>
    </div>
  </div>
  <div id="notif-panel" aria-hidden="true">
    <div id="notif-toggle-row">
      <span id="notif-title">Notifications</span>
      <button id="notif-toggle" type="button"></button>
    </div>
    <div id="notif-list"></div>
  </div>
  <div id="chat-wrap">
    <div id="chat-log"></div>
    <button id="scroll-bottom" aria-label="Scroll to latest" title="Scroll to latest">&#x2193;</button>
  </div>
  <div id="status-panel"></div>
  <div id="held-bar" style="display:none">
    <span id="held-label"></span>
    <span id="held-text"></span>
    <button id="held-clear" type="button" title="Discard">&#x2715;</button>
  </div>
  <div id="input-bar">
    <div id="cmd-suggestions"></div>
    <textarea id="input" placeholder="type a message… (/ for commands)" rows="1" disabled></textarea>
    <button id="send" disabled>Send</button>
  </div>
  <div id="reconnect-overlay"><span id="reconnect-msg">reconnecting…</span></div>
  <div id="prompt-card">
    <div class="q-label">pi needs your input</div>
    <div class="q" id="prompt-q"></div>
    <div class="rec-panel" id="prompt-rec" style="display:none">
      <div class="rec-label">Recommended answer</div>
      <div class="rec-text" id="prompt-rec-text"></div>
    </div>
    <textarea id="prompt-input" rows="3" placeholder="Type your answer…" style="display:none"></textarea>
    <div class="row" id="prompt-buttons"></div>
  </div>
  <script>
${renderModule()}
${highlightModule()}
${toolsModule()}
${clientScript(wsUrl)}
  </script>
</body>
</html>`
}
