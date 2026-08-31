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

  if (payload?.contactId != null && client.access.contactIds !== null) {
    if (!client.access.contactIds.has(Number(payload.contactId))) {
      // Still send a payload-free refresh signal. This is important when an
      // admin has just assigned a previously invisible lead to this user: the
      // SSE connection's access snapshot predates that assignment, so a silent
      // drop would leave their Inbox stale until a manual reload.
      return event === "conversation_changed" || event === "pipeline_changed" ? {} : null;
    }
  }
  if (payload?.leadId != null && client.access.leadIds !== null) {
    if (!client.access.leadIds.has(Number(payload.leadId))) {
      return event === "conversation_changed" || event === "pipeline_changed" ? {} : null;
    }
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
