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
  const client = { res, access: normalizeAccess(res) };
  clients.add(client);
  return () => clients.delete(client);
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

function publish(event, payload = {}) {
  for (const client of clients) {
    if (client.res.destroyed || client.res.writableEnded) {
      clients.delete(client);
      continue;
    }

    const allowedPayload = payloadForClient(client, event, payload);
    if (allowedPayload === null) continue;
    const message = `event: ${event}\ndata: ${JSON.stringify(allowedPayload)}\n\n`;

    try {
      client.res.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { addClient, publish };
