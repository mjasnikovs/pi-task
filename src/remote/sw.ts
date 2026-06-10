/** Service worker source served at /sw.js. It must be a real same-origin URL
 *  (a SW cannot be registered from a data: URL), and serving it at the root path
 *  gives it root scope so it controls the whole app.
 *
 *  iOS home-screen PWAs deliver notifications ONLY through a service worker's
 *  push event — the in-page `new Notification()` constructor is unavailable — so
 *  this is the only path that reaches a backgrounded iPhone. */
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
