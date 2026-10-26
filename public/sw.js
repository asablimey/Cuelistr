/* sw.js - minimal service worker. Its job is to make Cuelistr installable as an app on Android
 * (Chrome wants one registered). It deliberately caches NOTHING: this is a live site, so every
 * request goes straight to the network and a deploy is picked up immediately. */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
    if (e.request.mode !== 'navigate') return; // everything else: plain network, untouched
    e.respondWith(fetch(e.request).catch(function () {
        return new Response('<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#121212;color:#fff;font-family:sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;margin:0"><div><h2>You\u2019re offline</h2><p style="color:#a7a7a7">Check the connection and reopen the app.</p></div>',
            { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }));
});
