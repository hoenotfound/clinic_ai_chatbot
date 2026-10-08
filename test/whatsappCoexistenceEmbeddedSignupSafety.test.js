const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("browser launch uses the Business App coexistence feature and code response", () => {
  const source = read("portal-frontend/src/utils/whatsappEmbeddedSignup.js");
  assert.match(source, /featureType:\s*"whatsapp_business_app_onboarding"/);
  assert.doesNotMatch(source, /sessionInfoVersion/);
  assert.match(source, /response_type:\s*"code"/);
  assert.match(source, /override_default_response_type:\s*true/);
});

test("browser accepts only explicit Meta origins and WA Embedded Signup messages", () => {
  const source = read("portal-frontend/src/utils/whatsappEmbeddedSignup.js");
  assert.match(source, /https:\/\/www\.facebook\.com/);
  assert.match(source, /https:\/\/web\.facebook\.com/);
  assert.match(source, /https:\/\/business\.facebook\.com/);
  assert.doesNotMatch(source, /endsWith\(["']facebook\.com/);
  assert.match(source, /payload\.type !== "WA_EMBEDDED_SIGNUP"/);
});

test("portal validates coexistence only after both Meta signals", () => {
  const source = read("portal-frontend/src/components/WhatsAppCoexistenceOnboardingPanel.jsx");
  const classifier = read("portal-frontend/src/utils/whatsappEmbeddedSignup.js");
  assert.match(classifier, /case "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING":/);
  assert.match(source, /receiveWhatsAppSignupAuthorization/);
  assert.match(source, /receiveWhatsAppSignupMessage/);
  assert.match(source, /activeAttemptRef\.current !== attempt/);
  assert.match(source, /completeWhatsAppCoexistenceOnboarding/);
});

test("backend onboarding service contains no normal phone registration or WABA subscription call", () => {
  const source = read("src/services/whatsappCoexistenceOnboardingService.js");
  assert.doesNotMatch(source, /\/register\b/);
  assert.doesNotMatch(source, /subscribed_apps/);
  assert.doesNotMatch(source, /configureWhatsAppWebhook/);
});

test("onboarding audit migration stores no authorization code or access token", () => {
  const sql = read("src/db/migrations/016_whatsapp_coexistence_onboarding.sql");
  assert.match(sql, /whatsapp_coexistence_onboarding_attempts/);
  assert.doesNotMatch(sql, /access_token/i);
  assert.doesNotMatch(sql, /authorization_code/i);
});

test("standard Cloud API FINISH and coexistence completion are distinct", async () => {
  const { classifyWhatsAppEmbeddedSignupEvent, parseWhatsAppEmbeddedSignupMessage } =
    await import("../portal-frontend/src/utils/whatsappEmbeddedSignup.js");
  const standard = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "123" } };
  const coexistence = {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    data: { waba_id: "456" },
  };

  assert.equal(classifyWhatsAppEmbeddedSignupEvent(standard), "standard");
  assert.equal(classifyWhatsAppEmbeddedSignupEvent(coexistence), "coexistence");
  assert.equal(classifyWhatsAppEmbeddedSignupEvent({ ...standard, event: "ERROR" }), "error");
  assert.equal(classifyWhatsAppEmbeddedSignupEvent({ ...standard, event: "CANCEL" }), "cancel");
  assert.equal(classifyWhatsAppEmbeddedSignupEvent({ ...standard, event: "OTHER" }), null);
  assert.equal(classifyWhatsAppEmbeddedSignupEvent({ event: "FINISH" }), null);
  assert.deepEqual(
    parseWhatsAppEmbeddedSignupMessage({
      origin: "https://www.facebook.com",
      data: JSON.stringify(standard),
    }),
    standard
  );
  assert.equal(
    parseWhatsAppEmbeddedSignupMessage({
      origin: "https://untrusted.example.com",
      data: JSON.stringify(standard),
    }),
    null
  );
});

test("standard signup requires both Meta signals and remains separate from coexistence", async () => {
  const {
    createWhatsAppEmbeddedSignupAttempt: create,
    receiveWhatsAppSignupMessage: message,
    receiveWhatsAppSignupAuthorization: auth,
    expireWhatsAppSignupAttempt: expire,
  } = await import("../portal-frontend/src/utils/whatsappEmbeddedSignupAttempt.js");

  const standard = { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: "123" } };
  const coexistence = {
    type: "WA_EMBEDDED_SIGNUP",
    event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    data: { waba_id: "456", phone_number_id: "789" },
  };
  const response = { authResponse: { code: "one-time-code" } };

  // Meta postMessage before FB.login: never report completion without the code.
  const standardFirst = create(1, "nonce-1");
  assert.equal(message(standardFirst, standard).kind, "waiting");
  assert.deepEqual(auth(standardFirst, response), { kind: "standard" });
  assert.equal(standardFirst.phase, "closed");
  assert.equal(message(standardFirst, coexistence).kind, "ignored");

  // FB.login before postMessage: still no standard completion until FINISH.
  const authFirst = create(2, "nonce-2");
  assert.equal(auth(authFirst, response).kind, "waiting");
  assert.deepEqual(message(authFirst, standard), { kind: "standard" });

  // Meta may report standard FINISH even when the login callback has no code.
  const missingCode = create(3, "nonce-3");
  assert.equal(message(missingCode, standard).kind, "waiting");
  assert.equal(auth(missingCode, { status: "unknown" }).kind, "missing_code");
  assert.equal(message(missingCode, standard).kind, "ignored");

  const standardTimeout = create(4, "nonce-4");
  assert.equal(message(standardTimeout, standard).kind, "waiting");
  assert.equal(expire(standardTimeout).kind, "missing_code");

  // A stray event with no active attempt or a closed attempt is ignored.
  assert.equal(message(null, coexistence).kind, "ignored");
  assert.equal(auth(null, response).kind, "ignored");
  assert.equal(message(standardTimeout, coexistence).kind, "ignored");

  // Coexistence must pair its own expected completion event and code.
  const coexistenceFirst = create(5, "nonce-5");
  assert.equal(message(coexistenceFirst, coexistence).kind, "waiting");
  assert.deepEqual(auth(coexistenceFirst, response), {
    kind: "coexistence",
    code: "one-time-code",
    nonce: "nonce-5",
    sessionInfo: coexistence,
  });
  const coexistenceAuthFirst = create(6, "nonce-6");
  assert.equal(auth(coexistenceAuthFirst, response).kind, "waiting");
  assert.equal(message(coexistenceAuthFirst, coexistence).kind, "coexistence");

  // Conflicting or late events must never be selected as valid onboarding.
  const conflicting = create(7, "nonce-7");
  assert.equal(message(conflicting, standard).kind, "waiting");
  assert.equal(message(conflicting, coexistence).kind, "conflict");
  assert.equal(auth(conflicting, response).kind, "ignored");
  const aborted = create(8, "nonce-8");
  assert.equal(message(aborted, { ...standard, event: "CANCEL" }).kind, "cancel");
  assert.equal(auth(aborted, response).kind, "ignored");
  const apiError = create(9, "nonce-9");
  assert.equal(message(apiError, { ...standard, event: "ERROR" }).kind, "error");
  assert.equal(apiError.phase, "closed");

  const expired = create(10, "nonce-10");
  assert.equal(auth(expired, response).kind, "waiting");
  assert.equal(expire(expired).kind, "unconfirmed");
  assert.equal(message(expired, coexistence).kind, "ignored");
});

test("portal gates callbacks and never treats standard FINISH as backend coexistence completion", () => {
  const source = read("portal-frontend/src/components/WhatsAppCoexistenceOnboardingPanel.jsx");
  assert.match(source, /if \(!attempt \|\| submittingRef\.current\) return;/);
  assert.match(source, /if \(activeAttemptRef\.current !== attempt\) return;/);
  assert.match(source, /if \(outcome\.kind === "coexistence"\)/);
  assert.match(source, /if \(outcome\.kind === "standard"\)/);
  assert.match(source, /setNotice\("standard"\)/);
  assert.match(source, /setNotice\("unconfirmed"\)/);
  assert.match(source, /This screen has not exchanged the code, verified the WABA, or connected the number/);
});
