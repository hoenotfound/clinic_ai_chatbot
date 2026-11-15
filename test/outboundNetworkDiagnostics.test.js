"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  destinationForHost, createOutboundNetworkDiagnostics,
} = require("../src/utils/outboundNetworkDiagnostics");

function fakeChannels() {
  const channels = new Map();
  const factory = name => {
    if (!channels.has(name)) channels.set(name, {
      listeners: new Set(),
      subscribe(callback) { this.listeners.add(callback); },
      unsubscribe(callback) { this.listeners.delete(callback); },
    });
    return channels.get(name);
  };
  return {
    factory,
    send(name, message) {
      for (const callback of channels.get(name)?.listeners || []) callback(message);
    },
    listenerCount(name) { return channels.get(name)?.listeners.size || 0; },
  };
}

function fakeSocket(initial = 0) {
  const socket = new EventEmitter();
  socket.bytesWritten = initial;
  return socket;
}

test("only fixed provider categories, never store arbitrary origins", () => {
  assert.equal(destinationForHost("graph.facebook.com:443"), "meta");
  assert.equal(destinationForHost("lookaside.fbsbx.com"), "meta");
  assert.equal(destinationForHost("generativelanguage.googleapis.com"), "gemini");
  assert.equal(destinationForHost("api.telegram.org"), "telegram");
  assert.equal(destinationForHost("ccb.r2.cloudflarestorage.com"), "r2");
  assert.equal(destinationForHost("pub-example.r2.dev"), "r2");
  assert.equal(destinationForHost("ep-sample.neon.tech:5432"), "neon");
  assert.equal(destinationForHost("someone.evil.tld"), "other");
  assert.equal(destinationForHost("graph.facebook.com.evil.tld"), "other");
  assert.equal(destinationForHost("https://secret-person/?token=abc"), "other");
});

test("feature defaults off and subscriptions are idempotent", () => {
  const channels = fakeChannels();
  const metrics = createOutboundNetworkDiagnostics({
    channelFactory: channels.factory,
  });
  assert.equal(metrics.install({ env: {} }), false);
  assert.equal(channels.listenerCount("undici:request:create"), 0);
  assert.equal(metrics.install({
    env: { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" },
  }), true);
  assert.equal(metrics.install({
    env: { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" },
  }), false);
  assert.equal(channels.listenerCount("undici:request:create"), 1);
  metrics.uninstall();
  assert.equal(channels.listenerCount("undici:request:create"), 0);
});

test("counts only socket deltas by provider, reuses connections, and resets each interval", () => {
  const channels = fakeChannels();
  const pool = new EventEmitter();
  const metrics = createOutboundNetworkDiagnostics({
    channelFactory: channels.factory,
  });
  metrics.install({
    env: { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" },
    databasePool: pool,
  });

  const meta = fakeSocket(50);
  channels.send("undici:request:create", {
    request: { origin: "https://graph.facebook.com", path: "/secret-patient" },
  });
  channels.send("undici:client:connected", {
    socket: meta, connectParams: { hostname: "graph.facebook.com" },
  });
  meta.bytesWritten += 1024 * 1024;
  const neon = fakeSocket(0);
  pool.emit("connect", { connection: { stream: neon } });
  neon.bytesWritten = 2 * 1024 * 1024;

  const sdk = new EventEmitter();
  sdk.getHeader = name => name === "host" ? "generativelanguage.googleapis.com" : null;
  channels.send("http.client.request.start", { request: sdk });
  const gemini = fakeSocket(0);
  sdk.emit("socket", gemini);
  gemini.bytesWritten = 512 * 1024;

  const first = metrics.snapshot();
  const by = name => first.destinations.find(v => v.category === name);
  assert.equal(by("meta").outboundMiB, 1);
  assert.equal(by("meta").requests, 1);
  assert.equal(by("neon").outboundMiB, 2);
  assert.equal(by("neon").newConnections, 1);
  assert.equal(by("gemini").outboundMiB, 0.5);
  assert.equal(by("gemini").requests, 1);
  assert.equal(first.activeSockets, 3);
  assert.doesNotMatch(JSON.stringify(first), /secret-patient|googleapis\.com|facebook\.com/);

  // Reusing the same connection does not lose bytes or double-count baseline.
  meta.bytesWritten += 256 * 1024;
  channels.send("undici:client:connected", {
    socket: meta, connectParams: { hostname: "graph.facebook.com" },
  });
  gemini.bytesWritten += 256 * 1024;
  gemini.emit("close"); // Includes bytes written before closing.
  const second = metrics.snapshot();
  assert.equal(second.destinations.find(v => v.category === "meta").outboundMiB, 0.25);
  assert.equal(second.destinations.find(v => v.category === "meta").newConnections, 0);
  assert.equal(second.destinations.find(v => v.category === "gemini").outboundMiB, 0.25);
  assert.equal(second.activeSockets, 2);
  assert.equal(metrics.snapshot().destinations.find(v => v.category === "meta").outboundMiB, 0);

  metrics.uninstall();
  const after = metrics.snapshot();
  assert.equal(channels.listenerCount("undici:request:create"), 0);
  assert.equal(after.destinations.every(v => v.requests === 0), true);
});

test("unknown host is folded into other without raw URL, even on strange input", () => {
  const channels = fakeChannels();
  const metrics = createOutboundNetworkDiagnostics({ channelFactory: channels.factory });
  metrics.install({ env: { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" } });
  channels.send("undici:request:create", {
    request: { origin: "https://example.invalid", path: "/private/secret" },
  });
  channels.send("undici:request:create", {
    request: { origin: "malformed-origin", path: "/secret" },
  });
  channels.send("undici:client:connected", {
    connectParams: { hostname: "mystery.example.invalid" },
    socket: fakeSocket(),
  });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.destinations.find(v => v.category === "other").requests, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|example\.invalid|private/);
  metrics.uninstall();
});
