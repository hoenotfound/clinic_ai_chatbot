const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("scheduled-message writes are protected by reply and management capabilities", () => {
  const source = read("src/middleware/requireAuth.js");

  assert.match(source, /action === "scheduled-messages"/);
  assert.match(source, /\["POST", "PATCH", "DELETE"\]\.includes\(req\.method\)/);
  assert.match(source, /isSend[\s\S]*isScheduledMessageWrite/);
  assert.match(source, /isSend && !hasCapability\(user, "reply_to_assigned_leads"\)/);
  assert.match(
    source,
    /action === "scheduled-messages"[\s\S]*\["PATCH", "DELETE"\]\.includes\(req\.method\)/
  );
  assert.match(source, /isConversationManagement && !hasCapability\(user, "manage_assigned_leads"\)/);
});

test("scheduled-message controls reflect the same permissions in the portal", () => {
  const source = read("portal-frontend/src/components/ScheduledInboxMessages.jsx");

  assert.match(source, /const \{ user \} = useAuth\(\)/);
  assert.match(source, /reply_to_assigned_leads === true/);
  assert.match(source, /manage_assigned_leads === true/);
  assert.match(source, /composerMount && canReply/);
  assert.match(source, /canChange && canReply && canManage/);
});
