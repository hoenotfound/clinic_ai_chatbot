#!/usr/bin/env node
"use strict";
// Dedicated stateless default WhatsApp callback relay. This is NOT imported
// by the existing chatbot and is never started by its ordinary npm start.
const { createRelayServer, configFromEnv } = require("../src/services/whatsappAppDefaultRelay");
try {
  const config = configFromEnv(process.env);
  const port = Number(process.env.PORT || 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid PORT");
  createRelayServer(config).listen(port, "0.0.0.0", () => {
    console.log("Signed WhatsApp default callback relay listening");
  });
} catch (error) {
  console.error("Default callback relay refused to start:", error.message);
  process.exitCode = 1;
}
