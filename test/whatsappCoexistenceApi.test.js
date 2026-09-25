const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getCoexistenceStatus,
  isCoexistenceReady,
  requestBusinessAppDataSync,
} = require("../src/services/whatsappCoexistenceApi");

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() { return payload; },
  };
}

test("coexistence status is ready only for Business App + Cloud API", async () => {
  let requestedUrl = null;
  const result = await getCoexistenceStatus({
    phoneNumberId: "110552088553929",
    accessToken: "test-token",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response({
        id: "110552088553929",
        is_on_biz_app: true,
        platform_type: "CLOUD_API",
      });
    },
  });

  assert.match(requestedUrl, /110552088553929\?fields=is_on_biz_app,platform_type/);
  assert.equal(result.ready, true);
  assert.equal(result.isOnBusinessApp, true);
  assert.equal(result.platformType, "CLOUD_API");
  assert.equal(isCoexistenceReady({ is_on_biz_app: true, platform_type: "ON_PREMISE" }), false);
});

test("Business App data sync helper only accepts Meta coexistence sync types", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({ messaging_product: "whatsapp", request_id: "req-1" });
  };

  await requestBusinessAppDataSync({
    phoneNumberId: "110552088553929",
    accessToken: "test-token",
    syncType: "history",
    fetchImpl,
  });

  assert.match(calls[0].url, /110552088553929\/smb_app_data$/);
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    messaging_product: "whatsapp",
    sync_type: "history",
  });

  await assert.rejects(
    () => requestBusinessAppDataSync({
      phoneNumberId: "110552088553929",
      accessToken: "test-token",
      syncType: "anything_else",
      fetchImpl,
    }),
    /Unsupported Business App sync type/
  );
});
