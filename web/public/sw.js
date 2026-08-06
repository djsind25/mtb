// MyTrashBid service worker — installable-PWA support + web push.
//
// Caching is deliberately conservative: only the app shell (this fixed set of stable-path files)
// is precached. Everything else — Vite's hashed JS/CSS bundles — is cached opportunistically on
// first fetch (stale-while-revalidate-free "cache, falling back to network" for same-origin GET
// only) so repeat loads are fast without a build-time precache manifest. Anything going to a
// different origin (Supabase, Stripe, etc.) or that isn't a GET is never intercepted — always
// live from the network. That's the whole point: never serve stale jobs/bids/chat data.

const SHELL_CACHE = "mtb-shell-v1";
const RUNTIME_CACHE = "mtb-runtime-v1";
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Navigations (loading the app itself): network first, so a fresh deploy is picked up
  // immediately; fall back to the cached shell only when actually offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Hashed build assets (/assets/*.js, *.css, etc.): cache-first, since a given hash is immutable
  // for the life of that build — network fallback covers anything not cached yet.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "MyTrashBid", body: event.data.text() };
  }
  const { title, body, url } = payload;
  event.waitUntil(
    self.registration.showNotification(title || "MyTrashBid", {
      body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === url && "focus" in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
