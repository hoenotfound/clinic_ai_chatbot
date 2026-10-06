const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("staff access removal revokes remembered Web Push devices", () => {
  const auth = read("src/routes/auth.js");

  assert.match(
    auth,
    /const accessDisabled =[\s\S]*updates\.isActive === false;[\s\S]*if \(credentialsChanged \|\| accessDisabled\)[\s\S]*removeAllForUser\(userId, queryable\)/
  );

  assert.match(
    auth,
    /const deactivated = await usersRepo\.deactivateUser\(userId, queryable\);[\s\S]*await pushSubscriptionsRepo\.removeAllForUser\(userId, queryable\);[\s\S]*return deactivated;/
  );
});

test("Web Push requests refuse redirects", () => {
  const service = read("src/services/webPushNotificationService.js");
  assert.match(service, /redirect: "error"/);
});


test("routine Staff-owned inbound messages do not become Web Push spam", () => {
  const server = read("src/server.js");
  assert.match(
    server,
    /if \(contact\.mode === "human"\)[\s\S]*notifyWebPush: Boolean\(keywordReason\)/
  );
});

test("Web Push deployment variables are documented", () => {
  const envExample = read(".env.example");
  assert.match(envExample, /WEB_PUSH_VAPID_PUBLIC_KEY=/);
  assert.match(envExample, /WEB_PUSH_VAPID_PRIVATE_KEY=/);
  assert.match(envExample, /WEB_PUSH_SUBJECT/);
});
