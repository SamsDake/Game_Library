// Service worker — handles background and push notifications

const scopeUrl = self.registration.scope;
const scopedAsset = (path) => new URL(path, scopeUrl).href;

self.addEventListener('push', event => {
  const data = event.data?.json() ?? { title: 'Jet Lag', body: '' };
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: scopedAsset('favicon.svg'),
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => 'focus' in c);
      if (existing) return existing.focus();
      return clients.openWindow(scopeUrl);
    })
  );
});
