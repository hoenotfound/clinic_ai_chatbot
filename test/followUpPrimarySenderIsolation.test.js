"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { primaryFollowUpSenderSql } = require("../src/db/followUpRepo");

test("legacy follow-ups retain untagged primary contacts and social channels", () => {
  const sql = primaryFollowUpSenderSql("$7", "$8");
  assert.match(sql, /c\.channel <> 'whatsapp'/);
  assert.match(sql, /c\.whatsapp_sender_id IS NULL/);
  assert.match(sql, /primary_sender\.id=c\.whatsapp_sender_id/);
  assert.match(sql, /primary_sender\.meta_phone_number_id=\$7::text/);
  assert.match(sql, /primary_sender\.meta_account_id=\$8::text/);
  assert.doesNotMatch(sql, /neutro|secondary_sender_key/);
});

test("both candidate discovery and next-due hint use the identical sender restriction", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/db/followUpRepo.js"), "utf8"
  );
  assert.match(source, /primaryFollowUpSenderSql\('\$7', '\$8'\)/);
  assert.match(source, /primaryFollowUpSenderSql\('\$6', '\$7'\)/);
  assert.match(source, /\[delays, triggerMode, activatedAt, limit, modes, expiryOffsets,\s*process\.env\.WHATSAPP_PHONE_NUMBER_ID \|\| "", process\.env\.WHATSAPP_WABA_ID \|\| ""\]/);
  assert.match(source, /\[delays, triggerMode, activatedAt, modes, expiryOffsets,\s*process\.env\.WHATSAPP_PHONE_NUMBER_ID \|\| "", process\.env\.WHATSAPP_WABA_ID \|\| ""\]/);
});
