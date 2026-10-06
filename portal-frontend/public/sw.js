self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "DA CHATBOT";
  const options = {
    body: data.body || "You have an important chatbot alert.",
    icon: "/api/auth/branding/favicon.png",
    badge: "/api/auth/branding/favicon.png",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    data: {
      url: data.url || "/inbox",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const requestedPath = event.notification.data?.url || "/inbox";
  const targetUrl = new URL(requestedPath, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        const sameOriginClient = clients.find((client) => {
          try {
            return new URL(client.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });

        if (sameOriginClient) {
          if ("navigate" in sameOriginClient) {
            await sameOriginClient.navigate(targetUrl);
          }
          return sameOriginClient.focus();
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
