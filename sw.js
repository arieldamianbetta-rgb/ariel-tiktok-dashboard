// Service worker mínimo: solo lo necesario para que el navegador
// ofrezca "instalar" la página como app. No cachea datos (queremos
// que data.json siempre se lea fresco desde la red).
self.addEventListener("install", (e) => {
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  // pass-through: siempre red, sin caché
  e.respondWith(fetch(e.request));
});
