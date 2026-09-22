const PWA_BRAND_CACHE = "tienda-napoles-pwa-brand-v1";
const DYNAMIC_PWA_ASSETS = new Set([
  "pwa-manifest.webmanifest",
  "pwa-icon-192.png",
  "pwa-icon-512.png"
]);

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const assetName = url.pathname.split("/").pop();
  if (!DYNAMIC_PWA_ASSETS.has(assetName)) return;
  event.respondWith((async () => {
    const cache = await caches.open(PWA_BRAND_CACHE);
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    if (assetName === "pwa-manifest.webmanifest") return fetch("./manifest.webmanifest");
    return fetch(assetName === "pwa-icon-192.png"
      ? "./images/los-anos-pwa-192.png"
      : "./images/los-anos-pwa-512.png");
  })());
});
