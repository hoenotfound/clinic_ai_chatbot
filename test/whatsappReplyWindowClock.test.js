const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("WhatsApp reply-window policy uses persisted inbound time, not provider source time", () => {
  const policy = read("src/services/whatsappPolicyService.js");
  const contacts = read("src/db/contactsRepo.js");
  const scheduled = read("src/db/scheduledMessageRepo.js");

  assert.match(
    policy,
    /SELECT m\.created_at[\s\S]*ORDER BY m\.created_at DESC, m\.id DESC[\s\S]*AS latest_inbound_at/
  );
  assert.doesNotMatch(
    policy,
    /COALESCE\(m\.source_created_at, m\.created_at\)/
  );

  assert.match(
    contacts,
    /MAX\(m\.created_at\) FILTER \(WHERE m\.role = 'user'\) AS latest_inbound_at/
  );
  assert.match(
    contacts,
    /SELECT created_at[\s\S]*WHERE contact_id = c\.id AND role = 'user'[\s\S]*ORDER BY created_at DESC, id DESC/
  );
  assert.doesNotMatch(
    contacts,
    /COALESCE\(source_created_at, created_at\).*latest_inbound_at/
  );

  assert.match(
    scheduled,
    /SELECT created_at[\s\S]*WHERE contact_id = \$1 AND role = 'user'[\s\S]*ORDER BY created_at DESC, id DESC/
  );
});

test("provider source timestamp remains stored for diagnostics without changing the policy clock", () => {
  const parser = read("src/services/whatsappService.js");
  const storage = read("src/db/inboundProcessingRepo.js");
  const migration = read("src/db/migrations/038_message_source_created_at.sql");

  assert.match(parser, /timestamp: sourceTimestamp/);
  assert.match(storage, /source_created_at/);
  assert.match(migration, /source_created_at TIMESTAMPTZ/);
});
