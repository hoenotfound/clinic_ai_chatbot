const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

const source = (relative) => fs.readFileSync(path.join(__dirname, "..", relative), "utf8");

test("review_required flags one unanswered question without requesting full takeover", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "I will ask our team to check that exact detail.",
    outcome: "review_required",
    treatment: null,
    branch: null,
    appointmentPreference: null,
  }));
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.bookingReady, false);
  assert.equal(result.outcome, "review_required");
});

test("human takeover remains distinct from staff review", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "I will connect you with a team member now.",
    outcome: "needs_human",
  }));
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, false);
});

test("normal replies stay unflagged and keep reviewRequired false", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "We are open Tuesday to Sunday.",
    outcome: "normal",
  }));
  assert.equal(result.flagged, false);
  assert.equal(result.reviewRequired, false);
});

test("unrecognized handoff outcomes are still rejected", () => {
  assert.throws(
    () => parseAiReplyResult(JSON.stringify({
      reply: "Someone will help you.",
      outcome: "unknown_mode",
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("AI review never changes ownership and uses the normal final AI send guard", () => {
  const server = source("src/server.js");
  const repo = source("src/db/contactsRepo.js");
  assert.match(server, /if \(flagged && reviewRequired\)/);
  assert.match(server, /contactsRepo\.setAiReviewAttention\(/);
  assert.match(server, /finalSendContact = flagged && !reviewRequired/);
  assert.match(repo, /WHERE c.id = \$1 AND c.mode = 'ai'/);
  assert.match(repo, /INSERT INTO ai_review_items/);
  assert.match(repo, /AI review requested:/);
});

test("staff assist does not silently dismiss unresolved AI review", () => {
  const repo = source("src/db/contactsRepo.js");
  assert.match(repo, /CASE WHEN attention_reason LIKE 'AI review requested:%' THEN needs_attention ELSE false END/);
  assert.match(repo, /CASE WHEN attention_reason LIKE 'AI review requested:%' THEN attention_reason ELSE NULL END/);
});

test("AI prompt chooses review_required for nonurgent unknowns and takeover for actual human requests", () => {
  const prompt = source("src/utils/systemPrompt.js");
  assert.match(prompt, /Use "review_required" when a missing\/unverified business-specific fact/);
  assert.match(prompt, /Use "needs_human" for an explicit request for human\/staff\/manager assistance/);
  assert.match(prompt, /"normal \| review_required \| needs_human \| booking_ready"/);
});


test("review-only question is persisted and notified exactly once without takeover", async (t) => {
  const { pool } = require("../src/db/db");
  const contactsRepo = require("../src/db/contactsRepo");
  const alerts = require("../src/services/telegramImmediateAlertService");
  const pushes = require("../src/services/webPushNotificationService");
  const oldQuery = pool.query;
  const oldAlert = alerts.sendHumanInterventionAlert;
  const oldPush = pushes.sendContactAlertBestEffort;
  t.after(() => {
    pool.query = oldQuery;
    alerts.sendHumanInterventionAlert = oldAlert;
    pushes.sendContactAlertBestEffort = oldPush;
  });

  let alertCount = 0;
  let pushCount = 0;
  pool.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO ai_review_items/);
    assert.match(sql, /ON CONFLICT \(contact_id, inbound_message_id\) DO NOTHING/);
    assert.match(sql, /AND c.mode = 'ai'/);
    assert.deepEqual(params, [37, 88, "Can I pay with card?", "information"]);
    return { rows: [{
      id: 37, mode: "ai", needs_attention: true, ai_review_id: 8,
      attention_reason: "AI review requested: [#88] Can I pay with card?",
      attention_message_id: 88,
    }] };
  };
  alerts.sendHumanInterventionAlert = async ({ contactId, messageId, reason }) => {
    assert.equal(contactId, 37);
    assert.equal(messageId, 88);
    assert.match(reason, /#88.*pay with card/);
    alertCount += 1;
    return { status: "sent" };
  };
  pushes.sendContactAlertBestEffort = () => { pushCount += 1; };
  const result = await contactsRepo.setAiReviewAttention(37, 88, "Can I pay with card?", "information");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.mode, "ai");
  assert.equal(result.needs_attention, true);
  assert.equal(alertCount, 1);
  assert.equal(pushCount, 1);
});

test("duplicate inbound review does not alert again or overwrite existing attention", async (t) => {
  const { pool } = require("../src/db/db");
  const contactsRepo = require("../src/db/contactsRepo");
  const alerts = require("../src/services/telegramImmediateAlertService");
  const oldQuery = pool.query;
  const oldAlert = alerts.sendHumanInterventionAlert;
  t.after(() => {
    pool.query = oldQuery;
    alerts.sendHumanInterventionAlert = oldAlert;
  });
  let count = 0;
  let alertsSent = 0;
  pool.query = async (sql) => {
    count += 1;
    if (count === 1) {
      assert.match(sql, /ON CONFLICT \(contact_id, inbound_message_id\) DO NOTHING/);
      return { rows: [] };
    }
    assert.equal(sql, "SELECT * FROM contacts WHERE id = $1");
    return { rows: [{
      id: 37, mode: "ai", needs_attention: true,
      attention_reason: "AI review requested: [#88] Existing question.",
    }] };
  };
  alerts.sendHumanInterventionAlert = async () => { alertsSent += 1; };
  const result = await contactsRepo.setAiReviewAttention(37, 88, "Existing question.");
  assert.equal(result.mode, "ai");
  assert.match(result.attention_reason, /Existing question/);
  assert.equal(alertsSent, 0);
  assert.equal(count, 2);
});

test("multiple reviews remain individually durable until explicit Inbox dismissal", () => {
  const repo = source("src/db/contactsRepo.js");
  const routes = source("src/routes/conversations.js");
  assert.match(source("src/db/migrations/064_ai_review_items.sql"), /UNIQUE \(contact_id, inbound_message_id\)/);
  assert.match(repo, /RIGHT\(COALESCE\(SUBSTRING\(c.attention_reason/);
  assert.match(repo, /UPDATE ai_review_items r\s+SET status = 'resolved'/);
  assert.match(routes, /contactsRepo.dismissAttentionAndReviews/);
});

test("administrative reviews may resume safe follow-ups, but clinical/unknown reviews cannot", () => {
  const { categorizeAiReview, followUpAttentionAllowedSql, canSendReactiveMedia } =
    require("../src/utils/aiReviewPolicy");
  assert.equal(categorizeAiReview("Can I pay by card?", "information"), "information");
  assert.equal(categorizeAiReview("刚刚做了 HIFU，适合3D吗？", "information"), "clinical");
  assert.equal(categorizeAiReview("Is 3D safe for pregnant patients?", "information"), "clinical");
  assert.equal(categorizeAiReview("Can I park there?", null), "clinical");
  assert.equal(categorizeAiReview("Can I park there?", "information"), "information");
  assert.equal(canSendReactiveMedia({
    mode: "ai", needs_attention: true,
    attention_reason: "AI review requested: [#88] HIFU question",
  }), true);
  assert.equal(canSendReactiveMedia({
    mode: "human", needs_attention: true,
    attention_reason: "AI review requested: [#88] HIFU question",
  }), false);
  assert.match(followUpAttentionAllowedSql("c"), /review.category <> 'information'/);
  assert.match(followUpAttentionAllowedSql("c"), /review.status = 'pending'/);
});

test("every follow-up discovery and final claim uses the category-aware gate", () => {
  const names = [
    "src/db/followUpRepo.js",
    "src/db/followUpAiLeaseRepo.js",
    "src/db/pricingReminderRepo.js",
    "src/db/followUpHealthScheduleRepo.js",
  ];
  for (const name of names) {
    const code = source(name);
    assert.match(code, /followUpAttentionAllowedSql/);
    assert.doesNotMatch(code, /AND c\.needs_attention\s*=\s*false/);
  }
});

test("staff-waiting reminders exclude AI-only reviews, which have their own accurate alert", () => {
  const waiting = source("src/services/staffWaitingAlertService.js");
  const telegram = source("src/services/telegramImmediateAlertService.js");
  assert.match(waiting, /NOT LIKE 'AI review requested:%'/);
  assert.match(telegram, /Staff Question to Review \(AI Active\)/);
  assert.match(telegram, /no Return to AI action is needed/);
});
