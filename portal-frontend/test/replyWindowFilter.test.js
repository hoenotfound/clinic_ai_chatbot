import { test } from "node:test";
import assert from "node:assert/strict";
import { hasOpenReplyWindow } from "../src/utils/whatsappPolicy.js";

const now = Date.parse("2026-10-09T07:00:00.000Z");
const hoursAgo = (hours) => new Date(now - hours * 60 * 60 * 1000).toISOString();

test("WhatsApp reply windows follow the latest inbound customer message", () => {
  assert.equal(hasOpenReplyWindow({ channel: "whatsapp", latest_inbound_at: hoursAgo(23) }, now), true);
  assert.equal(hasOpenReplyWindow({ channel: "whatsapp", latest_inbound_at: hoursAgo(24) }, now), false);
  assert.equal(hasOpenReplyWindow({ channel: "whatsapp", latest_inbound_at: hoursAgo(25) }, now), false);
  assert.equal(hasOpenReplyWindow({ channel: "whatsapp", latest_inbound_at: null }, now), false);
});

test("Messenger and Instagram allow staff-only Human Agent reply windows if enabled", () => {
  for (const channel of ["facebook", "instagram"]) {
    assert.equal(hasOpenReplyWindow({ channel, latest_inbound_at: hoursAgo(72), human_agent_enabled: true }, now), true);
    assert.equal(hasOpenReplyWindow({ channel, latest_inbound_at: hoursAgo(72), human_agent_enabled: false }, now), false);
    assert.equal(hasOpenReplyWindow({ channel, latest_inbound_at: hoursAgo(168), human_agent_enabled: true }, now), false);
  }
});

test("Opt-outs do not falsely change time-based expiry", () => {
  const contact = {
    channel: "whatsapp",
    latest_inbound_at: hoursAgo(1),
    whatsapp_opt_out_at: hoursAgo(2),
  };
  assert.equal(hasOpenReplyWindow(contact, now), true);
  assert.equal(hasOpenReplyWindow({ ...contact, latest_inbound_at: hoursAgo(25) }, now), false);
});

test("Unknown or invalid inbound timestamps have no open window", () => {
  assert.equal(hasOpenReplyWindow({ channel: "instagram", latest_inbound_at: "invalid" }, now), false);
  assert.equal(hasOpenReplyWindow({ channel: "whatsapp" }, now), false);
});
