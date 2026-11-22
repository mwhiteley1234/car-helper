// Service worker: only for notifications. It doesn't cache pages, so a new deploy shows up on the next open.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (_) { msg = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(msg.title || "Car Helper", {
    body: msg.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: msg.tag || undefined,
    data: { url: msg.url || "/" },
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) { if ("focus" in w) { await w.focus(); if ("navigate" in w) await w.navigate(url); return; } }
    await self.clients.openWindow(url);
  })());
});
