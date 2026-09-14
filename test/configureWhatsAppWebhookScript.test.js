const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectManagementAccessToken,
  usage,
} = require("../scripts/configureWhatsAppWebhook");

test("WABA configuration prefers operator management token over client messaging token", () => {
  assert.equal(
    selectManagementAccessToken({
      operatorEnv: { WHATSAPP_MANAGEMENT_TOKEN: "management-token" },
      runtimeEnv: { WHATSAPP_TOKEN: "client-token" },
    }),
    "management-token",
  );
});

test("WABA configuration falls back to client token for backwards compatibility", () => {
  assert.equal(
    selectManagementAccessToken({
      operatorEnv: {},
      runtimeEnv: { WHATSAPP_TOKEN: "client-token" },
    }),
    "client-token",
  );
});

test("WABA configuration help keeps management token out of client runtime guidance", () => {
  const text = usage();
  assert.match(text, /WHATSAPP_MANAGEMENT_TOKEN from the\s+operator shell/i);
  assert.match(text, /Keep that management token out of the client Render\/runtime env/i);
});
