// Boardwalk service worker — app-shell offline cache + Web Push notifications.
// Bump CACHE_VERSION on any deploy that should force-evict old cached shell files.
var CACHE_VERSION = 'boardwalk-v2';
var APP_SHELL = ['./', './index.html', './app.js', './plaid.js', './styles.css', './manifest.json'];

self.addEventListener('install', function(event) {
self.skipWaiting();
event.waitUntil(
caches.open(CACHE_VERSION).then(function(cache) {
return cache.addAll(APP_SHELL);
}).catch(function() { /* best-effort precache; fetch handler still works without it */ })
);
});

self.addEventListener('activate', function(event) {
event.waitUntil(
caches.keys().then(function(keys) {
return Promise.all(keys.filter(function(k) { return k !== CACHE_VERSION; }).map(function(k) { return caches.delete(k); }));
}).then(function() { return self.clients.claim(); })
);
});

self.addEventListener('fetch', function(event) {
var req = event.request;
if(req.method !== 'GET') return;
var url = new URL(req.url);
if(url.origin !== self.location.origin) return; // never intercept Supabase/API calls

var isShell = req.mode === 'navigate' || /\.(?:html|js|css|json)$/.test(url.pathname);

if(isShell) {
// Network-first for the app shell so deployed bug fixes reach users immediately;
// cache is only a fallback when offline.
event.respondWith(
fetch(req).then(function(res) {
var resClone = res.clone();
caches.open(CACHE_VERSION).then(function(cache) { cache.put(req, resClone); });
return res;
}).catch(function() {
return caches.match(req).then(function(cached) { return cached || caches.match('./index.html'); });
})
);
return;
}

// Cache-first for static assets (icons/images) that rarely change.
event.respondWith(
caches.match(req).then(function(cached) {
if(cached) return cached;
return fetch(req).then(function(res) {
if(res && res.status === 200) {
var resClone = res.clone();
caches.open(CACHE_VERSION).then(function(cache) { cache.put(req, resClone); });
}
return res;
});
})
);
});

self.addEventListener('push', function(event) {
var data = {};
try { data = event.data ? event.data.json() : {}; } catch(e) { data = { title: 'Boardwalk', body: event.data ? event.data.text() : '' }; }
var title = data.title || 'Boardwalk';
var options = {
body: data.body || '',
icon: './android-chrome-192x192.png',
badge: './android-chrome-192x192.png',
data: data.url ? { url: data.url } : {}
};
event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
event.notification.close();
var url = (event.notification.data && event.notification.data.url) || './';
event.waitUntil(
clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
for(var i = 0; i < clientList.length; i++) {
if('focus' in clientList[i]) return clientList[i].focus();
}
if(clients.openWindow) return clients.openWindow(url);
})
);
});
