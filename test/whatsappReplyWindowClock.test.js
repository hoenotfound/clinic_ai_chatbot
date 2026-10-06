const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("WhatsApp reply-window policy uses provider inbound time with a persisted-time fallback", () => {
  const policy = read("src/services/whatsappPolicyService.js");
  const contacts = read("src/db/contactsRepo.js");
  const scheduled = read("src/db/scheduledMessageRepo.js");

  assert.match(
    policy,
    /SELECT COALESCE\(m\.source_created_at, m\.created_at\)[\s\S]*ORDER BY COALESCE\(m\.source_created_at, m\.created_at\) DESC, m\.id DESC[\s\S]*AS latest_inbound_at/
  );

  assert.match(
    contacts,
    /MAX\(COALESCE\(m\.source_created_at, m\.created_at\)\)[\s\S]*FILTER \(WHERE m\.role = 'user'\) AS latest_inbound_at/
  );
  assert.match(
    contacts,
    /SELECT COALESCE\(source_created_at, created_at\) AS latest_inbound_at[\s\S]*ORDER BY COALESCE\(source_created_at, created_at\) DESC, id DESC/
  );

  assert.match(
    scheduled,
    /SELECT COALESCE\(source_created_at, created_at\) AS inbound_at[\s\S]*ORDER BY COALESCE\(source_created_at, created_at\) DESC, id DESC/
  );
});

test("provider source timestamp is stored and future timestamps are bounded by receipt time", () => {
  const parser = read("src/services/whatsappService.js");
  const storage = read("src/db/inboundProcessingRepo.js");
  const migration = read("src/db/migrations/038_message_source_created_at.sql");

  assert.match(parser, /timestamp: sourceTimestamp/);
  assert.match(storage, /source_created_at/);
  assert.match(storage, /Math\.min\(sourceMs, Number\(nowMs\)\)/);
  assert.match(migration, /source_created_at TIMESTAMPTZ/);
  assert.match(
    migration,
    /COALESCE\(source_created_at, created_at\)/
  );
});
