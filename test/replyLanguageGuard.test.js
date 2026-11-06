const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { clearReplyLanguageMismatch, correctReplyLanguage } =
  require("../src/utils/replyLanguageGuard");
const { normalizeReplyOptions } = require("../src/services/aiService");
const { buildGeminiRequest } = require("../src/services/geminiService");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

const booking = {
  text: "好的，收到你想约明天早上 10am 😊 我先让团队帮你确认。",
  flagged: false, reviewRequired: false, outcome: "booking_ready",
  bookingReady: true, priceQuery: false, packageQuery: false,
  serviceQuery: false, serviceQuerySource: null,
  details: { branch: "PJ", appointmentPreference: "tomorrow 10am", treatment: "骨盆调理" },
};
const clone = x => JSON.parse(JSON.stringify(x));

test("language prompt survives provider option normalization", () => {
  const opts = normalizeReplyOptions({
    replyLanguage: "en", channel: "whatsapp", bookingContext: { status: "none" },
  });
  assert.equal(opts.replyLanguage, "en");
  const prompt = buildGeminiRequest(
    [{ role: "user", content: "How much for 骨盆调理?" }],
    opts, "gemini-3.8-flash"
  ).request.config.systemInstruction;
  assert.match(prompt, /REQUIRED REPLY LANGUAGE FOR THIS TURN: English/);
  assert.match(prompt, /not clinic instructions, Chinese treatment names/);
  assert.match(prompt, /NOT a confirmed CRM booking/i);
  assert.match(buildSystemPrompt({ replyLanguage: "ms" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN: Bahasa Malaysia/);
  assert.match(buildSystemPrompt({ replyLanguage: "zh" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN: Simplified Chinese/);
  assert.match(buildSystemPrompt({ replyLanguage: "en", strictReplyLanguage: true }), /language-correction attempt/);
  assert.doesNotMatch(buildSystemPrompt({ replyLanguage: "invalid" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN/);
});

test("dominant Chinese reply to an English customer is a mismatch, treatment names are not", () => {
  assert.equal(clearReplyLanguageMismatch(booking.text, "en"), true);
  assert.equal(clearReplyLanguageMismatch("不客气，明天见哦 😊", "en"), true);
  assert.equal(clearReplyLanguageMismatch("Morning dear, we can check 骨盆调理 at 10am.", "en"), false);
  assert.equal(clearReplyLanguageMismatch("We can help you with 3D小颜术.", "en"), false);
  assert.equal(clearReplyLanguageMismatch("我会帮你确认，好的 😊", "ms"), true);
  assert.equal(clearReplyLanguageMismatch("可以的，明天见 😊", "zh"), false);
  assert.equal(clearReplyLanguageMismatch("Please let us know when you are available tomorrow.", "zh"), true);
});

test("normal aligned replies never generate an additional AI request", async () => {
  let calls = 0;
  const initial = { ...clone(booking), text: "Morning dear, we can check 骨盆调理 for 10am." };
  const result = await correctReplyLanguage(initial, [], { replyLanguage: "en" }, {
    getReply: async () => { calls++; throw new Error("must not retry"); },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, initial);
});

test("one correction changes only reply text, not booking or pricing metadata", async () => {
  let calls = 0;
  const initial = clone(booking);
  const revised = { ...clone(booking), text: "Thanks, I'll ask the team to confirm whether 10am tomorrow is available." };
  const result = await correctReplyLanguage(initial, [], { replyLanguage: "en" }, {
    getReply: async (_history, opts) => {
      calls++;
      assert.equal(opts.replyLanguage, "en");
      assert.equal(opts.strictReplyLanguage, true);
      return JSON.stringify(revised);
    },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 1);
  assert.equal(result.text, revised.text);
  assert.equal(result.bookingReady, true);
  assert.deepEqual(result.details, booking.details);
  assert.equal(result.priceQuery, false);
  assert.equal(result.packageQuery, false);
});

test("correction cannot silently change booking facts or escalation outcome", async () => {
  const initial = clone(booking);
  let calls = 0;
  const result = await correctReplyLanguage(initial, [], { replyLanguage: "en" }, {
    getReply: async () => {
      calls++;
      return JSON.stringify({
        ...clone(booking),
        text: "We'll confirm the 3:30pm appointment.",
        details: { ...booking.details, appointmentPreference: "tomorrow 3:30pm" },
      });
    },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 1);
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.bookingReady, false);
  assert.equal(result.priceQuery, false);
  assert.equal(result.text, "Staff review requested");
});

test("failed correction does not send wrong-language draft or trigger multiple retries", async () => {
  let calls = 0;
  const result = await correctReplyLanguage(clone(booking), [], { replyLanguage: "en" }, {
    getReply: async () => {
      calls++;
      return JSON.stringify({ ...clone(booking), text: "好的，明天见哦" });
    },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 1);
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, true);
});

test("already-flagged clinical review does not regenerate an unsafe reply", async () => {
  let calls = 0;
  const clinical = { ...clone(booking), outcome: "review_required", flagged: true };
  await correctReplyLanguage(clinical, [], { replyLanguage: "en" }, {
    getReply: async () => { calls++; },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 0);
});

test("server calls correction before downstream booking, pricing, and provider send", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const aiDraft = src.indexOf("const rawAiReply = await ai.getReply(replyHistory");
  const correction = src.indexOf("const languageCheckedReply = await correctReplyLanguage(");
  const assembled = src.indexOf("let reply = isFirstMessage && !flagged");
  const providerSend = src.indexOf('const sendOutcome = await sendTrackedText(');
  assert.ok(aiDraft > 0 && correction > aiDraft);
  assert.ok(assembled > correction && providerSend > assembled);
  assert.match(src.slice(aiDraft - 500, assembled), /replyLanguage: mediaLanguage/);
});
