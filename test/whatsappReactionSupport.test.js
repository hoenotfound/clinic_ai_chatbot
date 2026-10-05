const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const whatsappSource = read("src/services/whatsappService.js");
const createAppSource = read("src/createApp.js");
const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");
const messagesRepoSource = read("src/db/messagesRepo.js");
const migrationSource = read("src/db/migrations/035_whatsapp_message_reactions.sql");
const reliabilityMigrationSource = read("src/db/migrations/036_whatsapp_reaction_reliability.sql");

test("WhatsApp reactions are not treated as conversational inbound messages", () => {
  assert.match(
    whatsappSource,
    /if \(message\.type === "reaction"\) continue;/,
    "reaction messages must bypass the normal inbound AI path"
  );
  assert.match(whatsappSource, /function parseReactionEvents\(/);
  assert.match(whatsappSource, /message\.reaction\?\.message_id/);
});

test("WhatsApp reactions are durable before the webhook is acknowledged", () => {
  const routeStart = createAppSource.indexOf('app.post("/webhook", webhookJsonParser');
  const routeEnd = createAppSource.indexOf('app.get("/meta-webhook"', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);

  const route = createAppSource.slice(routeStart, routeEnd);
  const parseIndex = route.indexOf("whatsapp.parseReactionEvents(req.body)");
  const persistIndex = route.indexOf("messagesRepo.applyWhatsappReaction(reaction)");
  const ackIndex = route.indexOf("res.sendStatus(200)");

  assert.ok(parseIndex >= 0);
  assert.ok(persistIndex > parseIndex);
  assert.ok(ackIndex > persistIndex);
});

test("reaction storage is separate from messages and Inbox renders it on the target bubble", () => {
  assert.match(migrationSource, /CREATE TABLE IF NOT EXISTS message_reactions/i);
  assert.match(migrationSource, /UNIQUE \(target_message_id, reactor_key\)/i);
  assert.match(inboxSource, /Array\.isArray\(message\.reactions\)/);
  assert.match(inboxSource, /Array\.isArray\(payload\.reactions\)/);
  assert.match(inboxSource, /Customer reaction/);
});


test("unresolved reactions are queued and reconciled when the target WAMID becomes available", () => {
  assert.match(
    reliabilityMigrationSource,
    /CREATE TABLE IF NOT EXISTS pending_whatsapp_reactions/i
  );
  assert.match(
    reliabilityMigrationSource,
    /ADD COLUMN IF NOT EXISTS provider_timestamp BIGINT/i
  );
  assert.match(messagesRepoSource, /INSERT INTO pending_whatsapp_reactions/);
  assert.match(
    messagesRepoSource,
    /reconcilePendingWhatsappReactionsForMessage\(\s*updated\.id,\s*whatsappMessageId\s*\)/
  );
  assert.match(messagesRepoSource, /outbound_message_evidence/);
  assert.match(messagesRepoSource, /inbound_outbound_attempts/);
});

test("reaction ordering keeps removal tombstones and rejects stale retries", () => {
  assert.match(
    messagesRepoSource,
    /EXCLUDED\.provider_timestamp >= message_reactions\.provider_timestamp/
  );
  assert.match(
    messagesRepoSource,
    /FILTER \(WHERE emoji <> ''\)/
  );
  assert.doesNotMatch(
    messagesRepoSource,
    /DELETE FROM message_reactions\s+WHERE target_message_id/
  );
});

test("unresolved or unchanged reactions do not emit malformed Inbox realtime updates", () => {
  assert.match(createAppSource, /update\.pending === true/);
  assert.match(createAppSource, /update\.changed === false/);
  assert.match(createAppSource, /!Array\.isArray\(update\.reactions\)/);
});
