#!/usr/bin/env node
"use strict";
// Dedicated stateless default WhatsApp callback relay. This is NOT imported
// by the existing chatbot and is never started by its ordinary npm start.
const { createRelayServer, createPreparationRelayServer, configFromEnv } = require("../src/services/whatsappAppDefaultRelay");
try {
  const preparationMode = process.env.WHATSAPP_DEFAULT_RELAY_PREPARATION_MODE === "true";
  // The preparation service has no real Meta app secret, phone, WABA or
  // downstream URLs. Its only public success route is /health/live.
  const config = preparationMode ? null : configFromEnv(process.env);
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid PORT");
  const server = preparationMode ? createPreparationRelayServer() : createRelayServer(config);
  server.listen(port, "0.0.0.0", () => {
    console.log(preparationMode
      ? "WhatsApp default callback relay PREPARATION mode (Meta traffic disabled)"
      : "Signed WhatsApp default callback relay listening");
  });
} catch (error) {
  console.error("Default callback relay refused to start:", error.message);
  process.exitCode = 1;
}
