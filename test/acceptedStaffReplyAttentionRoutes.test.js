"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const routes = fs.readFileSync(
  path.join(__dirname, "../src/routes/conversations.js"), "utf8"
);

// Guards against accidentally fixing WhatsApp status callbacks but forgetting
// immediate Inbox acceptance, where social channels have no WA status callback.
function section(start, end) {
  const begin = routes.indexOf(start);
  assert.ok(begin >= 0, `missing route anchor: ${start}`);
  const finish = routes.indexOf(end, begin + start.length);
  assert.ok(finish > begin, `missing end anchor: ${end}`);
  return routes.slice(begin, finish);
}

test("successful media send reconciles attention only after saving provider outcome", () => {
  const media = section("async function finishInboxMediaSend(", "async function flagInboxMediaAttention(");
  const persist = media.indexOf("persistSendOutcome(saved, sendResult");
  const accepted = media.indexOf("if (sendResult.success)");
  const cleanup = media.indexOf("await reconcileAcceptedStaffReplyAttention(contact.id)");
  assert.ok(persist >= 0 && persist < accepted && accepted < cleanup);
  assert.match(media, /if \(sendResult\.success\) \{\s*await reconcileAcceptedStaffReplyAttention\(contact\.id\)/);
  assert.match(media, /else \{\s*await flagInboxMediaAttention/);
});

test("accepted plain Inbox reply reconciles staff waiting immediately on all channels", () => {
  const textRoute = section('router.post("/:contactId/messages",', 'function handleImageUpload(');
  assert.match(textRoute, /const finalMessage = await persistSendOutcome\(/);
  assert.match(textRoute,
    /\} else \{\s*await reconcileAcceptedStaffReplyAttention\(preparedContact\.id\);\s*await markLeadContacted/);
  assert.match(textRoute, /if \(!sendResult\.success\) \{[\s\S]*?setDeliveryAttention/);
});

test("accepted forwarded messages and retries use the same safe resolver", () => {
  const forward = section("async function forwardOtherStoredMessage(", 'router.post("/:contactId/messages/');
  assert.match(forward,
    /if \(sendResult\.success\) \{\s*await reconcileAcceptedStaffReplyAttention\(preparedContact\.id\)/);
  const retry = section('router.post("/:contactId/messages/:messageId/retry"', "async function forwardStoredMessage(");
  assert.match(retry,
    /if \(sendResult\.success\) \{\s*await reconcileAcceptedStaffReplyAttention\(sendContact\.id\)/);
});

test("attention bookkeeping cannot turn an accepted provider send into a 500", () => {
  const helper = section("async function reconcileAcceptedStaffReplyAttention(", "async function finishInboxMediaSend(");
  assert.match(helper, /try \{[\s\S]*?contactsRepo\.clearDeliveryAttentionIfNoFailedMessages\(contactId\)/);
  assert.match(helper, /catch \(error\) \{[\s\S]*?return null;/);
});
