const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sameStaffVideoOwner } = require("../src/utils/staffVideoOwnership");

const base = {
  id: 9020,
  channel: "facebook",
  channel_user_id: "psid-9020",
  mode: "human",
  takeover_by: "admin",
  takeover_at: "2026-11-12T08:00:00.000Z",
};

test("staff video continues when ownership stays the same", () => {
  assert.equal(sameStaffVideoOwner(base, { ...base, updated_at: "2026-11-12T08:30:00Z" }), true);
  assert.equal(sameStaffVideoOwner({ ...base, mode: "ai", takeover_by: null, takeover_at: null },
    { ...base, mode: "ai", takeover_by: null, takeover_at: null }), true);
});

test("staff video stops after a takeover, AI-mode change, recipient swap or deleted contact", () => {
  for (const other of [
    null,
    { ...base, mode: "ai" },
    { ...base, takeover_by: "other-staff" },
    { ...base, takeover_at: "2026-11-12T08:01:00.000Z" },
    { ...base, channel_user_id: "psid-other" },
    { ...base, channel: "instagram" },
    { ...base, id: 9021 },
  ]) {
    assert.equal(sameStaffVideoOwner(base, other), false);
  }
});

test("saved social staff video sends and retries use a fresh database owner check", () => {
  const route = fs.readFileSync(path.join(__dirname, "../src/routes/conversations.js"), "utf8");
  assert.match(route, /function socialProviderSendOptions\(/);
  assert.match(route, /getContactById\(contact\.id\)/);
  assert.match(route, /sameStaffVideoOwner\(contact, latest\)/);
  assert.match(route, /withCurrentMessage\.preSendCheck = async \(\) =>/);
  assert.match(route, /video_delivery_unconfirmed_retry_requires_review/);
});
