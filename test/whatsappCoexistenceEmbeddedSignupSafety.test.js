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

test("portal waits for FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING before backend completion", () => {
  const source = read(
    "portal-frontend/src/components/WhatsAppCoexistenceOnboardingPanel.jsx"
  );
  assert.match(source, /FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING/);
  assert.match(source, /response\?\.authResponse\?\.code/);
  assert.match(source, /sessionInfoRef\.current = payload/);
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

test("standard signup is shown without submitting a coexistence completion", () => {
  const source = read("portal-frontend/src/components/WhatsAppCoexistenceOnboardingPanel.jsx");
  assert.match(source, /if \(outcome === "standard"\)/);
  assert.match(source, /standardSignupRef\.current = true/);
  assert.match(source, /if \(standardSignupRef\.current\) return;/);
  assert.match(source, /setNotice\("standard"\)/);
  assert.match(source, /setNotice\("unconfirmed"\)/);
  assert.match(source, /if \(!sessionInfoRef\.current && !submittingRef\.current && !standardSignupRef\.current\)/);
  assert.match(source, /Do not enable coexistence or switch the live WhatsApp credentials/);
});
