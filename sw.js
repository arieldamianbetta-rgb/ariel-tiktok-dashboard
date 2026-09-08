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

// Notificaciones push: cuando el workflow diario detecta un video
// despegando, manda un push con este formato { title, body, url }.
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { title: "Ariel Betta Dashboard", body: e.data ? e.data.text() : "" };
  }
  const title = data.title || "Ariel Betta Dashboard";
  const options = {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: data.url || "./" },
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if (client.url === url && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
