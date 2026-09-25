const test = require("node:test");
const assert = require("node:assert/strict");

const {
  consumeNonce,
  issueNonce,
  serializeAttempt,
} = require("../src/routes/whatsappCoexistenceOnboarding");

test("onboarding nonce is one-time and bound to the authenticated session", () => {
  const req = { session: {} };
  const nonce = issueNonce(req);
  assert.ok(nonce.length >= 20);
  assert.equal(req.session.whatsappCoexistenceOnboardingNonce, nonce);

  assert.equal(consumeNonce(req, nonce), true);
  assert.equal(req.session.whatsappCoexistenceOnboardingNonce, undefined);
  assert.equal(consumeNonce(req, nonce), false);
});

test("wrong onboarding nonce is rejected and consumes the outstanding nonce", () => {
  const req = { session: {} };
  issueNonce(req);
  assert.equal(consumeNonce(req, "wrong-nonce"), false);
  assert.equal(req.session.whatsappCoexistenceOnboardingNonce, undefined);
});

test("serialized onboarding attempts contain metadata only", () => {
  const serialized = serializeAttempt({
    id: "7",
    status: "validated",
    waba_id: "waba",
    phone_number_id: "phone",
    display_phone_number: "+60122972817",
    verified_name: "Ariel Lee",
    coexistence_ready: true,
    event_version: 3,
    token_expires_at: null,
    error_code: null,
    error_message: null,
    started_by: "admin",
    created_at: "2026-09-25T00:00:00.000Z",
    access_token: "must-not-leak",
  });

  assert.equal(serialized.wabaId, "waba");
  assert.equal(serialized.phoneNumberId, "phone");
  assert.equal(Object.prototype.hasOwnProperty.call(serialized, "access_token"), false);
  assert.equal(JSON.stringify(serialized).includes("must-not-leak"), false);
});
