const CACHE = "fleuretmoi-pages-v23";
const BASE = new URL("./", self.location.href);
const APP_SHELL = [
  "",
  "index.html",
  "styles.css",
  "app.js?v=23",
  "illustration-picker.js?v=23",
  "illustration-test.html",
  "illustration-test.css",
  "illustration-test.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png"
].map((path) => new URL(path, BASE).href);

const OPTIONAL_LIBRARIES = [
  "https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.umd.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
    await Promise.all(OPTIONAL_LIBRARIES.map(async (url) => {
      try { await cache.add(url); } catch { /* Optional: app still works without map/EXIF helpers. */ }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  const isLocal = requestUrl.origin === self.location.origin;
  const isLibrary = requestUrl.hostname === "unpkg.com" || requestUrl.hostname === "cdn.jsdelivr.net";

  if (isLibrary) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }))
    );
    return;
  }

  // Do not cache map tiles: the OSM standard tile service is intended for online display, not offline bulk storage.
  if (!isLocal) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    }).catch(() => caches.match(event.request).then((cached) => cached || caches.match(new URL("index.html", BASE).href)))
  );
});
