// SellHub service worker: lets the site install like an app and shows a friendly page when offline.
// It never stores accounts, orders or API data.
const CACHE = 'sellhub-shell-v4';
const OFFLINE = '/offline.html';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll([OFFLINE, '/icon-192.png?v=4'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});
// Push: a notification from SellHub arrives even when the site is closed. If a SellHub tab is
// open and on screen, the page already shows its own pop-up, so the worker stays quiet then.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'SellHub', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    if (!d.force && list.some(c => c.visibilityState === 'visible' && c.focused !== false)) return;
    return self.registration.showNotification(d.title || 'SellHub', {
      body: d.body || '',
      icon: '/icon-192.png?v=4',
      badge: '/icon-32.png?v=4',
      tag: d.id ? 'sh-' + d.id : undefined,
      data: { url: d.url || '/' }
    });
  }));
});

// Tapping the notification opens SellHub on the right dashboard (re-using an open tab if there is one).
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.indexOf(url) !== -1 && 'focus' in c) return c.focus();
    }
    for (const c of list) {
      if ('focus' in c && 'navigate' in c) return c.navigate(url).then(w => w && w.focus()).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  }));
});
