"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { configFromEnv, partitionSignedBatch, dispatchSignedBatch, createRelayServer } =
  require("../src/services/whatsappAppDefaultRelay");
const cfg = {
  appSecret: "test-app-secret-not-a-real-meta-key",
  verifyToken: "test-verify-token-not-live",
  secondaryWaba: "22222222222", secondaryPhone: "+60120000000",
  legacyWabas: ["11111111111"],
  legacyUrl: "https://clinic-ai-chatbot.onrender.com/webhook",
  lifecycleUrl: "https://coexistence-qa.example.com/webhook",
};
function entry(id, field, value) { return { id, changes: [{ field, value }] }; }
const removal = { event: "PARTNER_REMOVED", phone_number: "+60 12-000 0000" };
function sign(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, signature: "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(raw).digest("hex") };
}
function collector() {
  const calls = [];
  return { calls, async fetch(url, options) {
    const raw = Buffer.from(options.body);
    assert.equal(options.headers["x-hub-signature-256"],
      "sha256=" + crypto.createHmac("sha256", cfg.appSecret).update(raw).digest("hex"));
    assert.equal(options.redirect, "manual");
    calls.push({ url, payload: JSON.parse(raw.toString()) });
    return { status: 200, headers: { get(name) {
      return url === cfg.lifecycleUrl && name === "x-da-coexistence-lifecycle-accepted" ? "1" : null;
    } } };
  }};
}
test("the signed secondary account_update is sent only to its lifecycle receiver", async () => {
  const c = collector();
  const p = { object: "whatsapp_business_account", entry: [entry(cfg.secondaryWaba, "account_update", removal)] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw, s.signature, cfg, c.fetch), 200);
  assert.deepEqual(c.calls.map(x => x.url), [cfg.lifecycleUrl]);
  assert.deepEqual(c.calls[0].payload, p);
});
test("allowlisted legacy messages still reach the original app-default handler", async () => {
  const c = collector();
  const p = { object: "whatsapp_business_account", entry: [
    entry(cfg.legacyWabas[0], "messages", { messages: [{ id: "wamid.legacy" }] })
  ] };
  const signed = sign(p);
  assert.equal(await dispatchSignedBatch(signed.raw, signed.signature, cfg, c.fetch), 200);
  assert.deepEqual(c.calls.map(x => x.url), [cfg.legacyUrl]);
});
test("signed foreign account cannot forward any field to Neutro legacy", async () => {
  const c = collector();
  for (const field of ["messages", "account_update", "history"]) {
    const p = { object: "whatsapp_business_account", entry: [
      entry("33333333333", field, { event: "PARTNER_REMOVED", messages: [] })
    ] };
    const signed = sign(p);
    assert.equal(await dispatchSignedBatch(signed.raw, signed.signature, cfg, c.fetch), 503);
  }
  assert.equal(c.calls.length, 0);
});
test("mixed authorized and foreign events reject entire batch before forwarding", async () => {
  const c = collector();
  const p = { object: "whatsapp_business_account", entry: [
    entry(cfg.legacyWabas[0], "messages", { messages: [{ id: "wamid.legacy" }] }),
    entry("99999999999", "messages", { messages: [{ id: "wamid.foreign" }] })
  ] };
  const signed = sign(p);
  assert.equal(await dispatchSignedBatch(signed.raw, signed.signature, cfg, c.fetch), 503);
  assert.equal(c.calls.length, 0);
});
test("unrecognized secondary field is not forwarded to legacy", async () => {
  const c = collector();
  const signed = sign({ object: "whatsapp_business_account", entry: [
    entry(cfg.secondaryWaba, "unexpected_field", { event: "OTHER" })
  ] });
  assert.equal(await dispatchSignedBatch(signed.raw, signed.signature, cfg, c.fetch), 503);
  assert.equal(c.calls.length, 0);
});
test("signed mixed batches are partitioned and re-signed without duplicate delivery", async () => {
  const c = collector();
  const primary = entry("11111111111", "messages", { metadata: { phone_number_id: "11111111111" }, messages: [{id:"wamid.primary"}] });
  const secondary = entry(cfg.secondaryWaba, "account_update", removal);
  const p = { object: "whatsapp_business_account", entry: [primary, secondary] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw, s.signature, cfg, c.fetch), 200);
  assert.deepEqual(c.calls.map(x => x.url), [cfg.legacyUrl, cfg.lifecycleUrl]);
  assert.deepEqual(c.calls[0].payload.entry, [primary]);
  assert.deepEqual(c.calls[1].payload.entry, [secondary]);
});
test("secondary customer content falling back to app-default route fails closed", async () => {
  const c = collector();
  const p = { object: "whatsapp_business_account", entry: [entry(cfg.secondaryWaba,
    "messages", {metadata:{phone_number_id:"9"},messages:[]})] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw, s.signature, cfg, c.fetch), 503);
  assert.equal(c.calls.length, 0);
});
test("bad signature or mismatched secondary phone never reaches a receiver", async () => {
  const c = collector();
  const p = { object: "whatsapp_business_account", entry: [entry(cfg.secondaryWaba,
    "account_update", {...removal, phone_number:"+60128889999"})] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw, "sha256=wrong", cfg, c.fetch), 403);
  assert.equal(await dispatchSignedBatch(s.raw, s.signature, cfg, c.fetch), 503);
  assert.equal(c.calls.length, 0);
});
test("old receiver false 200 without durable lifecycle acknowledgment fails closed", async () => {
  const p = { object:"whatsapp_business_account",entry:[entry(cfg.secondaryWaba,"account_update",removal)] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw,s.signature,cfg,async () => ({status:200})),503);
});
test("downstream failure returns 503 so Meta can retry the signed event", async () => {
  const p = { object: "whatsapp_business_account", entry: [entry(cfg.secondaryWaba, "account_update", removal)] };
  const s = sign(p);
  assert.equal(await dispatchSignedBatch(s.raw, s.signature, cfg, async () => ({status:503})),503);
});
test("only strong secrets, pinned sender and HTTPS /webhook destinations start", () => {
  const env = {
    WHATSAPP_DEFAULT_RELAY_APP_SECRET: cfg.appSecret,
    WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN: cfg.verifyToken,
    WHATSAPP_DEFAULT_RELAY_SECONDARY_WABA_ID: cfg.secondaryWaba,
    WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS: cfg.legacyWabas.join(","),
    WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164: cfg.secondaryPhone,
    WHATSAPP_DEFAULT_RELAY_LEGACY_URL: cfg.legacyUrl,
    WHATSAPP_DEFAULT_RELAY_LIFECYCLE_URL: cfg.lifecycleUrl,
  };
  assert.deepEqual(configFromEnv(env),cfg);
  assert.throws(() => configFromEnv({...env, WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:""}),/identity\/secrets/);
  assert.throws(() => configFromEnv({...env, WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:"333,333"}),/identity\/secrets/);
  assert.throws(() => configFromEnv({...env, WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:"*"}),/identity\/secrets/);
  assert.throws(() => configFromEnv({...env, WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:cfg.secondaryWaba}),/identity\/secrets/);
  assert.throws(() => configFromEnv({...env, WHATSAPP_DEFAULT_RELAY_LEGACY_URL:"http://localhost/webhook"}),/HTTPS/);
});
test("Meta GET challenge works while unsigned POSTs are rejected", async () => {
  const server = createRelayServer(cfg, {fetchImpl:async () => {throw Error("unexpected network call")}});
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const challenge = await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=${cfg.verifyToken}&hub.challenge=test`);
    assert.equal(challenge.status, 200);
    assert.equal(await challenge.text(),"test");
    assert.equal((await fetch(`${url}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=test`)).status,403);
    assert.equal((await fetch(`${url}/webhook`,{method:"POST",body:"{}"})).status,403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
