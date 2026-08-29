/** Service worker source served at /sw.js (see server.ts's request handler). It
 *  must be a real same-origin URL — registering from a `data:` URL is refused
 *  with "The URL protocol of the script is not supported" — and serving it at
 *  the root path is what gives it root scope: a worker served at `/sw.js`
 *  registers with scope `/`, one at `/deep/sw.js` with scope `/deep/`.
 *
 *  Notifications go through this worker's push event rather than an in-page
 *  `new Notification()` so they reach a device whose page is not open. */
export function swJs(): string {
    return `self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'pi-task remote';
  var options = { body: data.body || '', tag: data.tag, renotify: !!data.tag };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      // Skip the banner if a window is already focused — the in-page UI shows it.
      for (var i = 0; i < cs.length; i++) {
        if (cs[i].visibilityState === 'visible' && cs[i].focused) return;
      }
      return self.registration.showNotification(title, options);
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (cs) {
      for (var i = 0; i < cs.length; i++) {
        if ('focus' in cs[i]) return cs[i].focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
`
}
