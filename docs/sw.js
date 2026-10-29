// SPS Email service worker.
// Keeps the app's own files (page, styles, script, icons) so the app opens instantly and still
// opens with no connection. It never touches the mail server: requests to any other address
// (the API) pass straight through, so no email is ever stored by this file.
// Bump CACHE when you want every device to drop its old copy.
const CACHE = "sps-email-v2";
const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, so updates and config.js changes show up straight away; the saved copy is
// only used when the network fails.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never handle API calls

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
      )
  );
});
