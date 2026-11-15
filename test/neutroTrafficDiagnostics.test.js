"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");
const {
  coarseHttpRoute, recordHttpResponse, recordDirectR2Video,
  instrumentHttpBodyWrites, takeOutboundPayloadSnapshot,
} = require("../src/utils/outboundPayloadDiagnostics");

const enabled = { DA_OUTBOUND_PAYLOAD_DIAGNOSTICS_ENABLED: "true" };

test("48h/66h shortlist is narrower but preserves all due eligible inbound times", () => {
 for(const sql of [marketing.CANDIDATES_SQL,marketing.POTENTIAL_DUE_SQL,
   marketing.RECHECK_SQL,marketing.EXTENDED_CANDIDATES_SQL]){
   assert.match(sql,/recent_seed AS MATERIALIZED/);
   assert.match(sql,/verified_seed AS MATERIALIZED/);
   assert.match(sql,/recent_contact\.legacy_ads_eligible/);
 }
  // The first verified reply must follow the inbound within 24 hours.
  // With an 8-hour late grace period, the oldest inbound for 66h is
  // 66+24+8=98 hours ago, less than the five-day necessary-only filter.
  assert.ok(66 + 24 + 8 < 5 * 24);
  assert.match(marketing.CANDIDATES_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '5 days'/);
  assert.match(marketing.RECHECK_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '5 days'/);
  assert.match(marketing.POTENTIAL_DUE_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '5 days'/);
  // Longer Day4/Day6 paths keep their original nine-day window.
  assert.match(marketing.EXTENDED_CANDIDATES_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '9 days'/);
  assert.match(marketing.EXTENDED_RECHECK_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '9 days'/);
  assert.match(marketing.CANDIDATES_SQL,
    /consent_seed\.marketing_consent='opted_in'/);
  assert.match(marketing.CANDIDATES_SQL,
    /lead\.marketing_consent='opted_in'/);
  assert.match(marketing.CANDIDATES_SQL,
    /whatsapp_marketing_opt_out_at IS NULL/);
  assert.match(marketing.CANDIDATES_SQL,
    /whatsapp_sender_coexistence_history_messages/);
  assert.match(marketing.CANDIDATES_SQL,
    /whatsapp_sender_marketing_followup_attempts/);
});

test("response size diagnostics are bounded, classified and contain no customer identifiers", () => {
  takeOutboundPayloadSnapshot();
  assert.equal(coarseHttpRoute("/api/conversations"), "inbox_list");
  assert.equal(coarseHttpRoute("/api/conversations/921/messages/345/media"), "inbox_media");
  assert.equal(coarseHttpRoute("/api/conversations/921/messages"), "inbox_messages");
  assert.equal(coarseHttpRoute("/api/conversations/921"), "inbox_other");
  assert.equal(coarseHttpRoute("/api/config/secret"), "api_other");
  assert.equal(coarseHttpRoute("/webhook"), "webhook");
  assert.equal(coarseHttpRoute("/meta-webhook"), "meta_webhook");
  assert.equal(coarseHttpRoute("/whatsapp/default"), "whatsapp_ingress");
  assert.equal(coarseHttpRoute("/"), "health");
  assert.equal(coarseHttpRoute("/health/ready"), "health");
  assert.equal(coarseHttpRoute("/health/not-a-check"), "unknown_health");
  assert.equal(coarseHttpRoute("/promo-images/123"), "promo_images");
  assert.equal(coarseHttpRoute("/inbox"), "portal_page");
  assert.equal(coarseHttpRoute("/settings/team"), "portal_page");
  assert.equal(coarseHttpRoute("/assets/main.js"), "static");
  assert.equal(coarseHttpRoute("/strange-bot-path"), "unknown_path");
  assert.equal(recordHttpResponse({
    statusCode: 200, pathname: "/api/conversations/secret-person/messages/345/media",
    contentLength: 1048576, env: enabled,
  }), true);
  assert.equal(recordHttpResponse({
    statusCode: 503, pathname: "/api/conversations/secret-person/messages",
    contentLength: null, env: enabled,
  }), true);
  // WhatsApp retries remain untouched; only their diagnostic label differs.
  assert.equal(recordHttpResponse({
    statusCode: 503, pathname: "/whatsapp/default", contentLength: 0, env: enabled,
  }), true);
  assert.equal(recordHttpResponse({
    statusCode: 404, pathname: "/secret-person/bot-scan",
    contentLength: 10, env: enabled,
  }), true);
  assert.equal(recordHttpResponse({
    statusCode: 429, pathname: "/secret-person/bot-scan",
    contentLength: 18, env: enabled,
  }), true);
  assert.equal(recordDirectR2Video("redirected", enabled), true);
  assert.equal(recordDirectR2Video("error", enabled), true);
  assert.equal(recordDirectR2Video("unknown-status", enabled), false);
  const snapshot = takeOutboundPayloadSnapshot();
  const media = snapshot.httpResponses.find(x => x.category === "inbox_media");
  const messages = snapshot.httpResponses.find(x => x.category === "inbox_messages");
  assert.deepEqual(media, {
    category: "inbox_media", requests: 1, status404: 0,
    status429: 0, status503: 0, knownResponseMiB: 1,
    observedBodyMiB: 0, unknownResponseSize: 0,
  });
  assert.equal(messages.status503, 1);
  assert.equal(messages.unknownResponseSize, 1);
  assert.equal(snapshot.httpResponses.find(x => x.category === "whatsapp_ingress").status503, 1);
  const blocked = snapshot.httpResponses.find(x => x.category === "unknown_path");
  assert.equal(blocked.requests, 2);
  assert.equal(blocked.status404, 1);
  assert.equal(blocked.status429, 1);
  assert.equal(snapshot.directR2Video.find(x => x.category === "redirected").count, 1);
  assert.equal(snapshot.directR2Video.find(x => x.category === "error").count, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-person|bot-scan|\/345|\/921|unknown-status/);
  // No extra network, SQL, timers or persistent data from diagnostics.
  const empty = takeOutboundPayloadSnapshot();
  assert.equal(empty.httpResponses.find(x => x.category === "inbox_media").requests, 0);
  assert.equal(empty.directR2Video.find(x => x.category === "redirected").count, 0);
  assert.equal(recordHttpResponse({
    statusCode: 200, pathname: "/api/conversations", contentLength: 999,
    env: {},
  }), false);
});


test("passive response byte probe counts chunked media and open SSE without altering I/O", () => {
  takeOutboundPayloadSnapshot();
  const sent = [];
  const res = {
    write(...args) { sent.push(["write", args]); return true; },
    end(...args) {
      sent.push(["end", args]);
      // Emulate a response implementation that internally calls write on end.
      if (args[0]) this.write(args[0]);
      return "ended";
    },
  };
  assert.equal(instrumentHttpBodyWrites(res,
    "/api/conversations/private-contact/messages/17/media", enabled), true);
  const a = Buffer.alloc(512 * 1024);
  const b = Buffer.alloc(512 * 1024);
  assert.equal(res.write(a), true);
  assert.equal(res.end(b), "ended");
  assert.equal(sent.length, 3); // All write/end behavior is preserved.
  const snapshot = takeOutboundPayloadSnapshot();
  const media = snapshot.httpResponses.find(x => x.category === "inbox_media");
  assert.equal(media.requests, 0); // Does not need a finished response.
  assert.equal(media.observedBodyMiB, 1); // Counted once, not twice.
  assert.equal(media.knownResponseMiB, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /private-contact|private-media/);
  assert.equal(takeOutboundPayloadSnapshot().httpResponses.find(
    x => x.category === "inbox_media").observedBodyMiB, 0);

  const sse = { write() { return true; }, end() { return true; } };
  assert.equal(instrumentHttpBodyWrites(sse, "/api/conversations/events", enabled), true);
  sse.write("x".repeat(64 * 1024)); // SSE connection is still open, no end/finish.
  const live = takeOutboundPayloadSnapshot();
  assert.equal(live.httpResponses.find(x => x.category === "inbox_other").observedBodyMiB, 0.06);

  const noop = { write() { return true; }, end() { return true; } };
  assert.equal(instrumentHttpBodyWrites(noop, "/api/conversations/events", {}), false);
  noop.write(Buffer.alloc(1024 * 1024));
  const after = takeOutboundPayloadSnapshot();
  assert.equal(after.httpResponses.find(x => x.category === "inbox_other").observedBodyMiB, 0);
});
