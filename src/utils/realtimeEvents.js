const clients = new Set();

function addClient(res) {
  const client = { res };
  clients.add(client);
  return () => clients.delete(client);
}

function publish(event, payload = {}) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) {
    try {
      client.res.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

module.exports = { addClient, publish };
