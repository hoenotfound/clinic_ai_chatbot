const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const {
  DUMMY_PASSWORD_HASH,
  verifyLoginCredentials,
} = require("../src/services/authCredentialService");

test("valid active account credentials succeed", async () => {
  const user = {
    is_active: true,
    password_hash: bcrypt.hashSync("correct horse battery staple", 4),
  };
  assert.equal(
    await verifyLoginCredentials(user, "correct horse battery staple"),
    true
  );
});

test("wrong password, disabled account and missing account all fail closed", async () => {
  const hash = bcrypt.hashSync("right-password", 4);

  assert.equal(
    await verifyLoginCredentials({ is_active: true, password_hash: hash }, "wrong-password"),
    false
  );
  assert.equal(
    await verifyLoginCredentials({ is_active: false, password_hash: hash }, "right-password"),
    false
  );
  assert.equal(await verifyLoginCredentials(null, "right-password"), false);
});

test("unknown usernames still use a real bcrypt hash path", async () => {
  assert.match(DUMMY_PASSWORD_HASH, /^\$2[aby]\$/);
  assert.equal(await bcrypt.compare("anything", DUMMY_PASSWORD_HASH), false);
  assert.equal(await verifyLoginCredentials(undefined, "anything"), false);
});

test("malformed stored hashes and oversized passwords fail instead of throwing", async () => {
  assert.equal(
    await verifyLoginCredentials(
      { is_active: true, password_hash: "not-a-bcrypt-hash" },
      "password123"
    ),
    false
  );
  assert.equal(
    await verifyLoginCredentials(
      { is_active: true, password_hash: bcrypt.hashSync("password123", 4) },
      "x".repeat(201)
    ),
    false
  );
});
