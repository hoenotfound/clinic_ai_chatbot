"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const readiness = require("../src/services/startupReadinessService");
const { createApp } = require("../src/createApp");

function environment() {
  return {
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED: "true",
    WHATSAPP_APP_SECRET: "signed-meta-test-secret-for-paid-default",
    META_APP_SECRET: "signed-meta-test-secret-for-paid-default",
    WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN: "test-only-paid-default-verification",
    WHATSAPP_VERIFY_TOKEN: "existing-neutro-test-verification",
    WHATSAPP_WABA_ID: "1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164: "+601130535053",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164: "+60123456789",
    DATABASE_URL: "postgresql://primary:password@ep-primary.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
      "postgresql://secondary:password@ep-qa.aws.neon.tech/neondb",
    WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST: "ep-qa.aws.neon.tech"
  };
}
function setEnv(t, patch) {
  const keys = Object.keys(patch);
  const prev = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    readiness.resetForTests();
  });
}
async function withServer(app, work) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    instance.on("error", reject);
  });
  try {
    return await work("http://127.0.0.1:" + server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
function app() {
  return createApp({
    sessionSecret: "safe-test-session-secret".repeat(3),
    durablyClaimIncoming: async () => {
      throw Error("A foreign callback must never enter Neutro");
    },
    scheduleDurableClaim: async () => {},
    queueIncomingForReply: async () => {}
  });
}
function signed(secret, raw) {
  return "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex");
}
function foreignMessageBody() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "9888777",
      changes: [{
        field: "messages",
        value: {
          metadata: { phone_number_id: "9888999" },
          messages: [{ id: "wamid.foreign", from: "60129876543", text: { body: "hello" } }]
        }
      }]
    }]
  });
}

test("real Express router stays disabled for verification and messages by default", async t => {
  setEnv(t, { ...environment(), WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED: "false" });
  readiness.markReady();
  await withServer(app(), async url => {
    const get = await fetch(url + "/whatsapp/default?hub.mode=subscribe&hub.verify_token=x&hub.challenge=abc");
    assert.equal(get.status, 503);
    const post = await fetch(url + "/whatsapp/default", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: foreignMessageBody()
    });
    assert.equal(post.status, 503);
    const existing = await fetch(
      url + "/webhook?hub.mode=subscribe&hub.verify_token=existing-neutro-test-verification&hub.challenge=legacy"
    );
    assert.equal(existing.status, 200);
    assert.equal(await existing.text(), "legacy");
  });
});

test("real Express router verifies dedicated GET token, rejects unsigned or foreign POST", async t => {
  setEnv(t, environment());
  readiness.markReady();
  await withServer(app(), async url => {
    const valid = await fetch(
      url + "/whatsapp/default?hub.mode=subscribe&hub.verify_token=test-only-paid-default-verification&hub.challenge=approved"
    );
    assert.equal(valid.status, 200);
    assert.equal(await valid.text(), "approved");

    const badToken = await fetch(
      url + "/whatsapp/default?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=approved"
    );
    assert.equal(badToken.status, 403);

    const raw = foreignMessageBody();
    for (const header of [undefined, "sha256=" + "0".repeat(64)]) {
      const rejected = await fetch(url + "/whatsapp/default", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(header ? {
          "X-Hub-Signature-256": header
        } : {}) },
        body: raw
      });
      assert.equal(rejected.status, 403);
    }
    const signedForeign = await fetch(url + "/whatsapp/default", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": signed(environment().WHATSAPP_APP_SECRET, raw)
      },
      body: raw
    });
    assert.equal(signedForeign.status, 503);
  });
});

function neutroMessageBody() {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{
      id: "1593376338308612",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "601130535053",
            phone_number_id: "1408739622311791"
          },
          contacts: [{ wa_id: "60122222222", profile: { name: "Test Customer" } }],
          messages: [{
            id: "wamid.neutro-test-1",
            from: "60122222222",
            timestamp: "1790591000",
            type: "text", text: { body: "Please explain 3D treatment" }
          }]
        }
      }]
    }]
  });
}

function appWithDurableClaims(claims, { fail = false } = {}) {
  return createApp({
    sessionSecret: "safe-test-session-secret".repeat(3),
    durablyClaimIncoming: async (phone, incoming) => {
      if (fail) throw Error("Durable Neutro storage failed");
      claims.push({ phone, incoming });
      return { claimed: true, phone };
    },
    scheduleDurableClaim: async () => {},
    queueIncomingForReply: async () => {}
  });
}

test("real signed Neutro Cloud API POST uses the SAME durable handler on both routes", async t => {
  setEnv(t, environment());
  readiness.markReady();
  const claims = [];
  await withServer(appWithDurableClaims(claims), async url => {
    const raw = neutroMessageBody();
    const headers = {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signed(environment().WHATSAPP_APP_SECRET, raw)
    };
    const existing = await fetch(url + "/webhook", {
      method: "POST", headers, body: raw
    });
    assert.equal(existing.status, 200);
    assert.equal(claims.length, 1);
    const routed = await fetch(url + "/whatsapp/default", {
      method: "POST", headers, body: raw
    });
    assert.equal(routed.status, 200);
    assert.equal(claims.length, 2);
    assert.deepEqual(claims[0], claims[1]);
    assert.equal(claims[0].phone, "60122222222");
    assert.equal(claims[0].incoming.text, "Please explain 3D treatment");
    assert.equal(claims[0].incoming.from, "60122222222");
  });
});

test("real Neutro durable-store errors still return 503, not a false 200", async t => {
  setEnv(t, environment());
  readiness.markReady();
  await withServer(appWithDurableClaims([], { fail: true }), async url => {
    const raw = neutroMessageBody();
    const headers = {
      "Content-Type": "application/json",
      "X-Hub-Signature-256": signed(environment().WHATSAPP_APP_SECRET, raw)
    };
    for (const route of ["/webhook", "/whatsapp/default"]) {
      const response = await fetch(url + route, {
        method: "POST", headers, body: raw
      });
      assert.equal(response.status, 503);
    }
  });
});
