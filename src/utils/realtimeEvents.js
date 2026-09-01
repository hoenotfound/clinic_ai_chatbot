const clients = new Set();

function normalizeAccess(res) {
  const access = res.req?.user?.realtimeAccess;
  if (!access) return null;
  return {
    contactIds: access.contactIds === null ? null : new Set((access.contactIds || []).map(Number)),
    leadIds: access.leadIds === null ? null : new Set((access.leadIds || []).map(Number)),
  };
}

function addClient(res) {
  const client = {
    res,
    userId: Number(res.req?.user?.id) || null,
    access: normalizeAccess(res),
  };
  clients.add(client);
  return () => clients.delete(client);
}

function disconnectUser(userId) {
  const targetId = Number(userId);
  if (!Number.isSafeInteger(targetId) || targetId < 1) return 0;
  let disconnected = 0;
  for (const client of [...clients]) {
    if (client.userId !== targetId) continue;
    clients.delete(client);
    disconnected += 1;
    try {
      if (!client.res.writableEnded && !client.res.destroyed) client.res.end();
    } catch {
      // Removing the client is enough; a closed/broken response needs no work.
    }
  }
  return disconnected;
}

function payloadForClient(client, event, payload) {
  if (!client.access) return payload;

  const restricted = client.access.contactIds !== null || client.access.leadIds !== null;
  if (restricted && (event === "conversation_changed" || event === "pipeline_changed")) {
    // Restricted staff only need these events as refresh signals. Never put a
    // contact/lead id on their long-lived SSE connection: ownership may change
    // after the connection opens, while the next API refresh will always run a
    // fresh DB authorization check and return the correct newly assigned set.
    return {};
  }

  if (payload?.contactId != null && client.access.contactIds !== null) {
    return client.access.contactIds.has(Number(payload.contactId)) ? payload : null;
  }
  if (payload?.leadId != null && client.access.leadIds !== null) {
    return client.access.leadIds.has(Number(payload.leadId)) ? payload : null;
  }
  return payload;
}

function writeEvent(client, event, payload) {
  const allowedPayload = payloadForClient(client, event, payload);
  if (allowedPayload === null) return;
  const message = `event: ${event}\ndata: ${JSON.stringify(allowedPayload)}\n\n`;
  client.res.write(message);
}

function publish(event, payload = {}) {
  for (const client of clients) {
    if (client.res.destroyed || client.res.writableEnded) {
      clients.delete(client);
      continue;
    }

    try {
      writeEvent(client, event, payload);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { addClient, disconnectUser, publish };
