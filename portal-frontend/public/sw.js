self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {
      title: "DA CHATBOT",
      body: event.data ? event.data.text() : "New staff alert",
      url: "/inbox",
    };
  }

  const title = payload.title || "DA CHATBOT";
  const options = {
    body: payload.body || "A conversation needs staff attention.",
    icon: "/api/auth/branding/apple-touch-icon.png",
    badge: "/api/auth/branding/favicon.png",
    tag: payload.tag || "da-chatbot:staff-alert",
    renotify: true,
    data: {
      url: payload.url || "/inbox",
      contactId: payload.contactId || null,
      type: payload.type || "staff_alert",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(
    event.notification?.data?.url || "/inbox",
    self.location.origin
  ).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        for (const client of clients) {
          if (!client.url.startsWith(self.location.origin)) continue;
          if ("navigate" in client) {
            await client.navigate(target);
          }
          return client.focus();
        }
        return self.clients.openWindow(target);
      })
  );
});
