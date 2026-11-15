"use strict";

// Diagnostic-only, fixed-label classification of outbound socket writes.
// Uses Node diagnostics_channel and socket byte counters; never captures
// requests, URLs, credentials, payloads, phone numbers, message text or IDs.
// This is NOT Render-billed wire usage, and transports not observed by these
// channels (or sockets opened before installation) remain unattributed.
const diagnosticsChannel = require("node:diagnostics_channel");

const CATEGORIES = Object.freeze([
  "neon", "meta", "gemini", "r2", "telegram", "other",
]);
const MAX_ACTIVE_SOCKETS = 512;
const MIB = 1024 * 1024;

function destinationForHost(value) {
  if (typeof value !== "string") return "other";
  let host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) return "other";
  host = host.replace(/:\d+$/, "");
  if (host === "graph.facebook.com" || host === "graph.instagram.com" ||
      host === "api.facebook.com" || host === "lookaside.fbsbx.com" ||
      host.endsWith(".facebook.com") || host.endsWith(".fbsbx.com"))
    return "meta";
  if (host === "generativelanguage.googleapis.com" ||
      host === "aiplatform.googleapis.com" ||
      host.endsWith(".aiplatform.googleapis.com")) return "gemini";
  if (host === "api.telegram.org") return "telegram";
  if (host.endsWith(".r2.cloudflarestorage.com") ||
      host.endsWith(".r2.dev")) return "r2";
  if (host.endsWith(".neon.tech")) return "neon";
  return "other";
}

function createOutboundNetworkDiagnostics({
  channelFactory = name => diagnosticsChannel.channel(name),
} = {}) {
  const activeSockets = new Map();
  const seenSockets = new WeakSet();
  const counters = new Map();
  let installed = false;
  let unsubscribe = [];
  let poolCleanup = null;
  let untrackedSockets = 0;

  function row(category) {
    const key = CATEGORIES.includes(category) ? category : "other";
    if (!counters.has(key)) counters.set(key, {
      requests: 0, newConnections: 0, bytes: 0,
    });
    return counters.get(key);
  }

  function recordSocketDelta(entry) {
    // Read only Node's public socket counter. No packet, buffer or body
    // interception, no monkey-patching and no new network activity.
    const current = Number(entry.socket?.bytesWritten);
    if (!Number.isSafeInteger(current) || current < entry.previous) return;
    const delta = current - entry.previous;
    if (delta > 0) row(entry.category).bytes += delta;
    entry.previous = current;
  }

  function trackSocket(category, socket) {
    if (!socket || typeof socket.once !== "function" ||
        seenSockets.has(socket)) return false;
    if (activeSockets.size >= MAX_ACTIVE_SOCKETS) {
      untrackedSockets++;
      return false;
    }
    const starting = Number(socket.bytesWritten);
    if (!Number.isSafeInteger(starting) || starting < 0) return false;
    seenSockets.add(socket);
    const safeCategory = CATEGORIES.includes(category) ? category : "other";
    const entry = { socket, category: safeCategory, previous: starting };
    activeSockets.set(socket, entry);
    row(safeCategory).newConnections++;
    socket.once("close", () => {
      try { recordSocketDelta(entry); } catch (_) {}
      activeSockets.delete(socket);
    });
    return true;
  }

  function addSubscriber(name, handler) {
    const ch = channelFactory(name);
    if (!ch || typeof ch.subscribe !== "function") return;
    const callback = message => {
      // Diagnostic callbacks must never affect outgoing network traffic.
      try { handler(message || {}); } catch (_) {}
    };
    ch.subscribe(callback);
    unsubscribe.push(() => ch.unsubscribe?.(callback));
  }

  function install({ env = process.env, databasePool = null } = {}) {
    if (installed || env?.DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED !== "true")
      return false;
    installed = true;
    addSubscriber("undici:request:create", ({ request }) => {
      const category = destinationForHost(
        typeof request?.origin === "string" ? new URL(request.origin).hostname :
          request?.origin?.hostname
      );
      row(category).requests++;
    });
    addSubscriber("undici:client:connected", ({ socket, connectParams }) => {
      trackSocket(destinationForHost(connectParams?.hostname), socket);
    });
    addSubscriber("http.client.request.start", ({ request }) => {
      const rawHost = request?.getHeader?.("host") || request?.host;
      const category = destinationForHost(rawHost);
      row(category).requests++;
      if (request?.socket) trackSocket(category, request.socket);
      else request?.once?.("socket", socket => trackSocket(category, socket));
    });
    if (typeof databasePool?.on === "function") {
      const connected = client => {
        try { trackSocket("neon", client?.connection?.stream); } catch (_) {}
      };
      databasePool.on("connect", connected);
      poolCleanup = () => databasePool.off?.("connect", connected);
    }
    return true;
  }

  function snapshot() {
    for (const entry of activeSockets.values()) {
      try { recordSocketDelta(entry); } catch (_) {}
    }
    const destinations = CATEGORIES.map(category => {
      const item = counters.get(category) || {};
      return {
        category,
        requests: item.requests || 0,
        newConnections: item.newConnections || 0,
        outboundMiB: Math.round((item.bytes || 0) / MIB * 1000) / 1000,
      };
    });
    const result = {
      coverage: "node_http_undici_and_pg_pool_socket_bytes_written_only",
      destinations,
      activeSockets: activeSockets.size,
      untrackedSockets,
    };
    counters.clear();
    untrackedSockets = 0;
    return result;
  }

  function uninstall() {
    if (!installed) return;
    for (const fn of unsubscribe) fn();
    unsubscribe = [];
    poolCleanup?.();
    poolCleanup = null;
    installed = false;
  }
  return { install, snapshot, uninstall, trackSocket };
}

const production = createOutboundNetworkDiagnostics();

module.exports = {
  CATEGORIES, destinationForHost, createOutboundNetworkDiagnostics,
  installOutboundNetworkDiagnostics: production.install,
  takeOutboundNetworkSnapshot: production.snapshot,
};
