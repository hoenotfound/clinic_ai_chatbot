function listenHttpServer(
  app,
  {
    port = process.env.PORT || 3000,
    host = "0.0.0.0",
    log = console.log,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server = app.listen(port, host);

    const onError = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    server.once("error", onError);
    server.once("listening", () => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      const address = server.address();
      const actualPort = typeof address === "object" && address
        ? address.port
        : port;
      log(`[Startup] Server listening on ${host}:${actualPort}`);
      resolve(server);
    });
  });
}

function closeHttpServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

module.exports = {
  closeHttpServer,
  listenHttpServer,
};
