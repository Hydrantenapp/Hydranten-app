/* Hydranten Erfassung – © 2026 Simone Loosen, Feuerwehr Kleve. Alle Rechte vorbehalten. Siehe LICENSE. */
// Eigener Service Worker nur für den Ordner /erfassung/ - berührt die Hauptapp nicht.
const CACHE_NAME = "hydranten-erfassung-v16";
const PRECACHE_URLS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.json",
  "./icons/icon-32.png", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(PRECACHE_URLS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("hydranten-erfassung-") && k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).hostname.endsWith(".supabase.co")) return;
  // Netzwerk zuerst (Updates kommen sofort an), Cache als Rückfall für den Betrieb ohne Netz.
  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        if (resp && resp.status === 200) { const copy = resp.clone(); caches.open(CACHE_NAME).then((c) => c.put(event.request, copy)); }
        return resp;
      })
      .catch(() => caches.match(event.request).then((c) => c || (event.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
  );
});
