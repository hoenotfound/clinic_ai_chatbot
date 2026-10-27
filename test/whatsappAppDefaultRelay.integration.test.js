"use strict";
/*
 * End-to-end LOCAL TRANSPORT acceptance test. The relay and both downstream
 * receivers are real Node HTTP servers bound to 127.0.0.1. The relay's logical
 * HTTPS destination names have .invalid DNS suffixes; fetchImpl maps them
 * strictly to these in-process receivers. No Meta, Render, customer, legacy
 * webhook or production database is contacted.
 *
 * The QA receiver uses the REAL account-update extractor/persistence service,
 * with an in-memory SQL-shaped transaction stand-in. This proves signed
 * relay->receiver->durability-ack behavior; it does not replace a future live
 * staging/Neon signed Meta provider acceptance test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const {
  createRelayServer, createPreparationRelayServer, validMetaSignature,
} = require("../src/services/whatsappAppDefaultRelay");
const {
  extractSecondaryLifecycle, persistSecondaryLifecycle,
} = require("../src/services/whatsappCoexistenceAccountUpdateService");
const { validProviderRehearsalEvent } = require("../src/services/pr395StagingSafety");

const APP_SECRET = "only-a-synthetic-hmac-key-not-a-real-meta-secret";
const QA_ACCOUNT = "222222222222222";
const LEGACY_ACCOUNT = "111111111111111";
const QA_PHONE_ID = "333333333333333";
const QA_E164 = "+60120000000";
const LEGACY_URL = "https://legacy-relay-integration.example.invalid/webhook";
const QA_URL = "https://isolated-relay-integration.example.invalid/webhook";
const env = {
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED: "true",
  WHATSAPP_SECONDARY_SENDER_KEY: "coexistence_qa",
  WHATSAPP_SECONDARY_WABA_ID: QA_ACCOUNT,
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: QA_PHONE_ID,
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: QA_E164,
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID: QA_ACCOUNT,
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID: QA_PHONE_ID,
  PR395_STAGING_APPROVED_TEST_PHONE_E164: QA_E164,
  PR395_STAGING_MODE: "true",
  PR395_STAGING_PROVIDER_REHEARSAL_ENABLED: "true",
};

function signed(payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex");
  return { raw, signature };
}
function update(event = "PARTNER_REMOVED", phone = QA_E164) {
  return {
    object: "whatsapp_business_account",
    entry: [{id: QA_ACCOUNT, time: 1800000000, changes: [{
      field: "account_update",
      value: { event, phone_number: phone, disconnection_info: {reason: "ACCOUNT_DISCONNECTED"} }
    }]}],
  };
}
function legacyEvent() {
  return {
    object: "whatsapp_business_account",
    entry: [{id: LEGACY_ACCOUNT, changes: [{
      field: "account_update",
      value: { event: "ACCOUNT_VIOLATION", reason: "synthetic" }
    }]}],
  };
}
function mixed() {
  return {
    object: "whatsapp_business_account",
    entry: [...legacyEvent().entry, ...update().entry],
  };
}
function databaseFake() {
  const state = { persistCount: 0, fingerprints: new Set(), senderState: "active", failWrite: false };
  const db = {
    async connect() {
      return {
        async query(sql, args) {
          if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0 };
          if (sql.startsWith("SELECT id FROM whatsapp_sender_accounts")) {
            assert.deepEqual(args, ["coexistence_qa", QA_ACCOUNT, QA_PHONE_ID]);
            return { rows: [{id: 7}], rowCount: 1 };
          }
          if (sql.startsWith("INSERT INTO whatsapp_sender_coexistence_lifecycle_events")) {
            if (state.failWrite) throw Error("synthetic database failure");
            const fingerprint = args[0];
            if (state.fingerprints.has(fingerprint)) return {rows: [], rowCount: 0};
            state.fingerprints.add(fingerprint);
            state.persistCount += 1;
            return {rows: [{fingerprint}], rowCount: 1};
          }
          if (sql.startsWith("UPDATE whatsapp_sender_accounts")) {
            assert.deepEqual(args, [7]);
            state.senderState = "disabled";
            return {rowCount: 1};
          }
          throw Error("Unexpected SQL in lifecycle acceptance test");
        },
        release() {},
      };
    },
  };
  return {state, db};
}
function createFakeReceiver(legacy, state, db) {
  return http.createServer(async (req, res) => {
    const pieces = [];
    for await (const chunk of req) pieces.push(chunk);
    const raw = Buffer.concat(pieces);
    if (req.method !== "POST" || req.url !== "/webhook" ||
        !validMetaSignature(raw, req.headers["x-hub-signature-256"], APP_SECRET)) {
      res.writeHead(403).end(); return;
    }
    let payload;
    try { payload = JSON.parse(raw.toString("utf8")); }
    catch (_) { res.writeHead(503).end(); return; }
    if (legacy) {
      state.legacyRequests.push(payload);
      if (state.legacyFails) {res.writeHead(503).end(); return;}
      // The old app receives only unrelated, signed account-level events.
      assert.ok(payload.entry.every(entry => entry.id !== QA_ACCOUNT));
      res.writeHead(200).end(); return;
    }
    state.qaRequests.push(payload);
    try {
      const lifecycle = extractSecondaryLifecycle(payload, env);
      if (!lifecycle.length) throw Error("Receiver did not identify selected secondary lifecycle");
      await persistSecondaryLifecycle(lifecycle, {database: db, env});
      res.writeHead(200, state.omitLifecycleAck ? {} :
        {"X-DA-Coexistence-Lifecycle-Accepted": "1"}).end();
    } catch (_) {res.writeHead(503).end();}
  });
}
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve("http://127.0.0.1:" +
      server.address().port));
  });
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function withRelay(fn) {
  const db = databaseFake();
  const state = {legacyRequests: [], qaRequests: [], legacyFails: false,
    omitLifecycleAck: false};
  const legacy = createFakeReceiver(true, state, db.db);
  const receiver = createFakeReceiver(false, state, db.db);
  let relay;
  try {
    const oldAddress = await listen(legacy);
    const qaAddress = await listen(receiver);
    const mapped = new Map([
      [LEGACY_URL, oldAddress + "/webhook"], [QA_URL, qaAddress + "/webhook"],
    ]);
    // No global network fallback. Every relay egress attempt must map to the
    // two isolated receivers above; domain names are never contacted.
    const fetchImpl = (url, options) => {
      if (!mapped.has(url)) throw Error("External relay egress is forbidden in this test");
      return fetch(mapped.get(url), options);
    };
    relay = createRelayServer({
      appSecret: APP_SECRET, verifyToken: "synthetic-verify-token-123",
      secondaryWaba: QA_ACCOUNT, secondaryPhone: QA_E164,
      legacyWabas: [LEGACY_ACCOUNT],
      legacyUrl: LEGACY_URL, lifecycleUrl: QA_URL,
    }, {fetchImpl});
    const url = await listen(relay);
    return await fn({url, state, database: db.state});
  } finally {
    if (relay) await close(relay);
    await close(legacy);
    await close(receiver);
  }
}
async function send(url, payload, signatureOverride) {
  const event = signed(payload);
  return fetch(url + "/webhook", {method:"POST",
    headers:{"content-type":"application/json",
      "x-hub-signature-256":signatureOverride === undefined ?
        event.signature : signatureOverride},
    body:event.raw});
}

test("signed mixed batch traverses REAL relay -> separate receivers and commits disconnect before 200", async () => {
  await withRelay(async ({url,state,database}) => {
    const response = await send(url, mixed());
    assert.equal(response.status, 200);
    assert.equal(state.legacyRequests.length, 1);
    assert.equal(state.qaRequests.length, 1);
    assert.deepEqual(state.legacyRequests[0].entry, legacyEvent().entry);
    assert.deepEqual(state.qaRequests[0].entry, update().entry);
    assert.equal(database.persistCount, 1);
    assert.equal(database.senderState, "disabled");
    const replay = await send(url, mixed());
    assert.equal(replay.status, 200);
    assert.equal(database.persistCount, 1, "a provider retry cannot add a second event");
  });
});

test("invalid HMAC cannot cross relay or contact either receiver", async () => {
  await withRelay(async ({url,state}) => {
    assert.equal((await send(url, mixed(), "sha256=bad")).status,403);
    assert.equal(state.legacyRequests.length,0);
    assert.equal(state.qaRequests.length,0);
  });
});

test("secondary message and unknown secondary lifecycle can never leak to legacy", async () => {
  await withRelay(async ({url,state}) => {
    const misrouted = {object:"whatsapp_business_account",entry:[{
      id:QA_ACCOUNT,changes:[{field:"messages",value:{
        metadata:{phone_number_id:QA_PHONE_ID},
        messages:[{id:"wamid.synthetic",from:"60129999999",type:"text",text:{body:"synthetic"}}],
      }}]}]};
    assert.equal((await send(url,misrouted)).status,503);
    assert.equal((await send(url,update("UNRECOGNIZED_ACCOUNT_UPDATE"))).status,503);
    assert.equal((await send(url,update("PARTNER_REMOVED","+60129990000"))).status,503);
    assert.equal(state.legacyRequests.length,0);
    assert.equal(state.qaRequests.length,0);
  });
});

test("secondary DB outage returns retryable 503 and recovers with durable idempotent ACK", async () => {
  await withRelay(async ({url,state,database}) => {
    database.failWrite=true;
    assert.equal((await send(url,update())).status,503);
    assert.equal(database.persistCount,0);
    assert.equal(database.senderState,"active");
    database.failWrite=false;
    assert.equal((await send(url,update())).status,200);
    assert.equal(database.persistCount,1);
    assert.equal(database.senderState,"disabled");
    state.omitLifecycleAck=true;
    assert.equal((await send(url,update())).status,503,
      "an unproven downstream 200 must never be accepted");
    assert.equal(database.persistCount,1);
  });
});

test("legacy receiver failure prevents falsely ACKing a mixed Meta batch", async () => {
  await withRelay(async ({url,state,database}) => {
    state.legacyFails=true;
    assert.equal((await send(url,mixed())).status,503);
    assert.equal(state.qaRequests.length,0);
    assert.equal(database.persistCount,0);
    state.legacyFails=false;
    assert.equal((await send(url,mixed())).status,200);
    assert.equal(database.persistCount,1);
  });
});

test("isolated receiving gate recognizes only signed-path-compatible secondary content", () => {
  const data = {object:"whatsapp_business_account", entry:[{id:QA_ACCOUNT,changes:[{
    field:"history",value:{metadata:{phone_number_id:QA_PHONE_ID},history:[]}
  }]}]};
  assert.equal(validProviderRehearsalEvent(data,"/webhook",env),true);
  assert.equal(validProviderRehearsalEvent(data,"/meta-webhook",env),false);
  assert.equal(validProviderRehearsalEvent({...data,entry:[{
    ...data.entry[0],id:LEGACY_ACCOUNT}]},"/webhook",env),false);
  const wrongPhone = {object:data.object,entry:[{id:QA_ACCOUNT,changes:[{
    field:"history",value:{metadata:{phone_number_id:"999999999999999"},history:[]}
  }]}]};
  assert.equal(validProviderRehearsalEvent(wrongPhone,"/webhook",env),false);
  const status = {object:data.object,entry:[{id:QA_ACCOUNT,changes:[{
    field:"messages",value:{metadata:{phone_number_id:QA_PHONE_ID},
      statuses:[{id:"wamid.synthetic"}]}
  }]}]};
  assert.equal(validProviderRehearsalEvent(status,"/webhook",env),false);
});

test("standalone Render preparation mode responds to health and refuses ALL Meta webhooks", async () => {
  const server=createPreparationRelayServer();
  const url=await listen(server);
  try {
    assert.equal((await fetch(url+"/health/live")).status,200);
    assert.equal((await fetch(url+"/webhook?hub.mode=subscribe&hub.verify_token=fake&hub.challenge=x")).status,503);
    assert.equal((await send(url,update())).status,503);
    assert.equal((await fetch(url+"/meta-webhook",{method:"POST",body:"{}"})).status,503);
  } finally {await close(server);}
});
