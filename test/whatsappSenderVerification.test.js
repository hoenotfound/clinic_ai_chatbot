"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  verifyWhatsAppSenderMapping,
  listAccountPhoneIds,
} = require("../src/provisioning/whatsappSenderVerification");
const { parseArgs } = require("../scripts/verifyWhatsAppSenderMapping");

const PHONE_ID = "100000000000001";
const ACCOUNT_ID = "200000000000001";
const APP_ID = "300000000000001";
const URL = "https://clinic.example.com";

function graphStub({ includePhone = true, appId = APP_ID, callback = URL + "/webhook" } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, method: options.method });
    let payload;
    if (url.includes("/phone_numbers?")) {
      payload = { data: includePhone ? [{ id: PHONE_ID, display_phone_number: "+60 11-1111 1111" }] : [] };
    } else if (url.includes("/subscribed_apps?")) {
      payload = { data: [{
        whatsapp_business_api_data: { id: appId },
        override_callback_uri: callback,
      }] };
    } else throw new Error("unexpected request " + url);
    return { ok: true, status: 200, json: async () => payload };
  };
  return { fetchImpl, requests };
}

test("read-only Graph audit verifies phone/account, shared app and exact client callback", async () => {
  const { fetchImpl, requests } = graphStub();
  const report = await verifyWhatsAppSenderMapping({
    wabaId: ACCOUNT_ID, phoneNumberId: PHONE_ID, appId: APP_ID,
    clientBaseUrl: URL, accessToken: "test-secret",
    fetchImpl,
  });
  assert.equal(report.verified, true);
  assert.equal(report.phoneBelongsToAccount, true);
  assert.equal(report.subscriptionToSharedAppConfirmed, true);
  assert.equal(report.callbackOverrideMatches, true);
  assert.equal(report.callbackUrl, URL + "/webhook");
  assert.ok(requests.every(r => r.method === "GET"));
  assert.equal(JSON.stringify(report).includes("test-secret"), false);
});

test("audit fails closed for wrong account, app, or client callback", async () => {
  for (const overrides of [
    { includePhone: false },
    { appId: "999999999999999" },
    { callback: "https://unrelated.example.com/webhook" },
  ]) {
    const { fetchImpl } = graphStub(overrides);
    const result = await verifyWhatsAppSenderMapping({
      wabaId: ACCOUNT_ID, phoneNumberId: PHONE_ID, appId: APP_ID,
      clientBaseUrl: URL, accessToken: "test-secret", fetchImpl,
    });
    assert.equal(result.verified, false);
  }
});

test("audit requires numeric Meta IDs and a management token", async () => {
  await assert.rejects(
    verifyWhatsAppSenderMapping({
      wabaId: "unknown", phoneNumberId: PHONE_ID, appId: APP_ID,
      clientBaseUrl: URL, accessToken: "test",
    }),
    /numeric Meta ID/
  );
  await assert.rejects(
    verifyWhatsAppSenderMapping({
      wabaId: ACCOUNT_ID, phoneNumberId: PHONE_ID, appId: APP_ID,
      clientBaseUrl: URL, accessToken: "",
    }),
    /management token is required/
  );
});

test("multi-page WhatsApp phone list is bounded and incomplete reads cannot prove ownership", async () => {
  let pages = 0;
  const fetchImpl = async (_url, _options) => {
    pages += 1;
    return {
      ok: true, status: 200, json: async () => ({
        data: [{ id: PHONE_ID }],
        paging: { next: "https://graph.facebook.com/paged", cursors: { after: String(pages) } },
      }),
    };
  };
  const r = await listAccountPhoneIds({
    wabaId: ACCOUNT_ID, accessToken: "test-secret",
    fetchImpl, maxPages: 2,
  });
  assert.equal(r.complete, false);
  assert.equal(r.phoneIds.length, 1);
  assert.equal(pages, 2);
});

test("CLI accepts runtime configuration but never token command-line arguments", () => {
  assert.deepEqual(parseArgs([
    "--runtime-env-file", "./client-runtime.env",
    "--client-url", URL,
  ]), { runtimeEnvFile: "./client-runtime.env", clientUrl: URL });
  assert.throws(() => parseArgs(["--token", "secret"]), /Unexpected flag/);
});
