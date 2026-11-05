"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");
const {
  createCoalescedImmediateWake,
  followUpChangeRequiresWake,
} = require("../src/utils/followUpWakePolicy");

test("same-turn pipeline and conversation events wake once, with no timeout or missed follow-up", () => {
  let wakes = 0;
  const microtasks = [];
  const signal = createCoalescedImmediateWake(
    () => { wakes++; },
    fn => microtasks.push(fn)
  );
  assert.equal(signal(), true);
  assert.equal(signal(), false);
  assert.equal(signal(), false);
  assert.equal(microtasks.length, 1, "one immediate microtask, never a delay timer");
  assert.equal(wakes, 0);
  microtasks.shift()();
  assert.equal(wakes, 1);
  assert.equal(signal(), true, "later events must still trigger another wake");
  microtasks.shift()();
  assert.equal(wakes, 2);
});

test("native microtasks wake before the next event-loop turn", async () => {
  let wakes = 0;
  const signal = createCoalescedImmediateWake(() => { wakes++; });
  signal();
  signal();
  await Promise.resolve();
  assert.equal(wakes, 1);
});

test("only reaction and proven profile-only events are ignored by the follow-up worker", () => {
  assert.equal(followUpChangeRequiresWake({ reason: "reaction", messageId: 1 }), false);
  assert.equal(followUpChangeRequiresWake({
    reason: "contact_state", followUpStateUnchanged: true,
  }), false);
  for (const payload of [
    {}, null, undefined,
    { reason: "message", contactId: 7 },
    { reason: "contact_state", contactId: 7 },
    { reason: "contact_state", contactId: 7, followUpStateUnchanged: false },
    { reason: "delivery_status", deliveryStatus: "failed" },
    { reason: "delivery_status", deliveryStatus: "read" },
    { reason: "booking_confirmed" },
    { reason: "message", followUpStateUnchanged: true },
  ]) {
    assert.equal(followUpChangeRequiresWake(payload), true,
      "Every ambiguous or eligibility-changing event must wake the worker");
  }
});

test("secondary-only provider receipts never wake the primary follow-up scan", () => {
 const env = {
  WHATSAPP_PHONE_NUMBER_ID: "1408739622311791",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "1318355951360575",
 };
 const secondary = { channel: "whatsapp",
  businessPhoneNumberId: env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID };
 assert.equal(followUpChangeRequiresWake({
  ...secondary,reason: "delivery_status",deliveryStatus: "read",
 },env),false,"signed secondary receipt cannot change primary sending eligibility");
 assert.equal(followUpChangeRequiresWake({
  ...secondary,reason: "message",
 },env),true,"a real incoming message may affect the primary conversation");
 assert.equal(followUpChangeRequiresWake({
  ...secondary,reason: "whatsapp_opt_out",
 },env),true,"cross-channel opt-outs remain immediate");
 assert.equal(followUpChangeRequiresWake({
  ...secondary,reason: "booking_confirmed",
 },env),true,"cross-channel booking changes remain immediate");
 assert.equal(followUpChangeRequiresWake({
  reason: "delivery_status",channel: "whatsapp",
  businessPhoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID,
 },env),true,"primary receipts still wake their own worker");
 assert.equal(followUpChangeRequiresWake({
  reason: "delivery_status",channel:"whatsapp",
 },env),true,"unverified sender still wakes conservatively");
 assert.equal(followUpChangeRequiresWake({
  ...secondary,reason: "delivery_status",
 },{...env,WHATSAPP_PHONE_NUMBER_ID:""}),true,
 "missing sender configuration must not silently suppress a receipt");
});

test("follow-up realtime subscriptions coalesce events but retain pipeline/config safeguards", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  assert.match(source, /createCoalescedImmediateWake/);
  assert.match(source, /followUpChangeRequiresWake\(payload\)/);
  assert.match(source, /realtimeEvents\.subscribe\("pipeline_changed", \(payload\) => \{/);
  assert.match(source, /recordWorkerWake\("primary", "pipeline_changed", payload,/);
  assert.match(source, /wakeForRealtimeStateChange\(\) \? "queued" : "coalesced"/);
  assert.match(source, /policyHoldRepo\.releaseAll\(\)/);
  assert.match(source, /wakeAutomatedFollowUps\(0\)/);
});

test("Inbox Unreplied uses newest inbound vs newest accepted outbound without scanning each inbound", async t => {
  const originalQuery = pool.query;
  const originalSenderFlag = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const originalVisibility = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  t.after(() => {
    pool.query = originalQuery;
    if (originalSenderFlag === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = originalSenderFlag;
    if (originalVisibility === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = originalVisibility;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "true";

  for (const contactId of [null, 77]) {
    pool.query = async (sql, params) => {
      assert.deepEqual(params, contactId == null ? [] : [77]);
      assert.match(sql, /last_inbound_for_reply\.id IS NOT NULL/);
      assert.match(sql, /last_accepted_reply\.id IS NULL/);
      assert.match(sql, /\(last_accepted_reply\.created_at, last_accepted_reply\.id\)/);
      assert.match(sql, /\(last_inbound_for_reply\.created_at, last_inbound_for_reply\.id\)/);
      assert.match(sql, /\) last_inbound_for_reply ON true/);
      assert.match(sql, /\) last_accepted_reply ON last_inbound_for_reply\.id IS NOT NULL/);
      assert.match(sql, /outbound\.whatsapp_message_id IS NOT NULL/);
      assert.match(sql, /outbound\.delivery_status IN \('pending', 'sent', 'delivered', 'read'\)/);
      assert.match(sql, /ORDER BY outbound\.created_at DESC, outbound\.id DESC/);
      assert.doesNotMatch(sql, /NOT EXISTS \(\s*SELECT 1\s+FROM messages outbound/);
      return { rows: [] };
    };
    assert.deepEqual(await contactsRepo.listConversations({ contactId }), []);
  }
});

test("social profile enrichment preserves Inbox events without waking follow-up candidate search", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/db/contactsRepo.js"), "utf8");
  assert.match(source, /reason: "contact_state"/);
  assert.match(source, /publishContactChange\(row\.contact_id \|\| row\.id, \{ profileOnly: true, contact: row \}\)/);
  assert.match(source, /followUpStateUnchanged: true/);
});
