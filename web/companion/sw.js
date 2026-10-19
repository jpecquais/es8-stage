// ES8 Companion — service worker : l'app doit s'ouvrir sans réseau (salle de
// concert). Fichiers de l'app en cache à l'installation, polices Google au
// premier passage ; une mise à jour se voit à l'ouverture suivante.

const CACHE = "es8companion-v1";
const FILES = [
  "./", "index.html", "app.js", "show.js", "midi.js", "style.css",
  "manifest.webmanifest", "icon.svg", "demo-show.json", "../shared/vendor/preact-htm.module.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("es8companion-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== location.origin && !fonts) return;
  // Le cache répond tout de suite (un réseau de salle peut pendre) ; le
  // réseau met le cache à jour pour la prochaine ouverture.
  const update = fetch(request).then((response) => {
    if (response.ok || response.type === "opaque") {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  });
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) { update.catch(() => {}); return hit; }
      return update.catch(() => Response.error());
    }),
  );
});
