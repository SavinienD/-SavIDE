// axe:webui — service worker: makes the app installable (PWA). Network
// first: conversations are live data, nothing is cached offline.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
