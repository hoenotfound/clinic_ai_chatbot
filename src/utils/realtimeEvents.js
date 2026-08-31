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

function canReceive(client, payload) {
  if (!client.access) return true;

  if (payload?.contactId != null && client.access.contactIds !== null) {
    return client.access.contactIds.has(Number(payload.contactId));
  }
  if (payload?.leadId != null && client.access.leadIds !== null) {
    return client.access.leadIds.has(Number(payload.leadId));
  }
  return true;
}

function publish(event, payload = {}) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    if (client.res.destroyed || client.res.writableEnded) {
      clients.delete(client);
      continue;
    }
    if (!canReceive(client, payload)) continue;

    try {
      client.res.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { addClient, publish };
