/* Urban Hunt service worker — delivers Web Push notifications while the PWA is
   closed or backgrounded (and the device is on). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_err) {
    payload = { title: "Urban Hunt", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Urban Hunt";
  const options = {
    body: payload.body || "",
    tag: payload.tag,
    renotify: !!payload.tag,
    icon: "/icon.svg",
    badge: "/icon.svg",
    data: payload.data || {},
    vibrate: [80, 40, 80]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow("/");
  })());
});
