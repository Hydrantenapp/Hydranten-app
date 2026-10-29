/* Hydranten Feuerwehr Kleve – © 2026 Simone Loosen, Feuerwehr Kleve. Alle Rechte vorbehalten. Siehe LICENSE. */
const CACHE_NAME = "hydranten-app-v21";
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-32.png",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css",
  "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch((err) => {
        // Wenn die CDN-Datei offline beim Deploy nicht erreichbar ist, restliche App-Shell trotzdem cachen
        console.warn("Precache teilweise fehlgeschlagen:", err);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function istAppShellDatei(request) {
  const path = new URL(request.url).pathname;
  return request.mode === "navigate" || /\/(index\.html|app\.js|styles\.css|manifest\.json)$/.test(path) || path.endsWith("/");
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Server-Anfragen (Anmeldung, Daten, Fotos) niemals cachen
  if (new URL(event.request.url).hostname.endsWith(".supabase.co")) return;

  if (istAppShellDatei(event.request)) {
    // Netzwerk-zuerst für die App-Shell (index.html/app.js/styles.css/manifest.json): sorgt
    // dafür, dass Updates sofort ankommen, sobald wieder Internet da ist. Der Cache dient nur
    // noch als Rückfallebene für echtes Offline-Arbeiten - so kann dieses "alte Version bleibt
    // hängen"-Problem (siehe CACHE_NAME-Historie oben) künftig nicht mehr auftreten, auch wenn
    // sich sw.js selbst mal eine Weile nicht ändert.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : undefined)))
    );
    return;
  }

  // Alles andere (Kartenkacheln, CDN-Bibliotheken, Icons): weiterhin Cache-zuerst, da sich diese
  // kaum ändern und das die Ladezeit sowie echte Offline-Nutzung verbessert.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === "navigate") return caches.match("./index.html");
        });
    })
  );
});
