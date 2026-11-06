"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  clearReplyLanguageMismatch, correctReplyLanguage, correctionPreservesClaims,
} = require("../src/utils/replyLanguageGuard");
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
const ordinary = {
  ...booking, bookingReady: false, outcome: "normal",
  text: "好的，我可以介绍骨盆调理给您 😊",
};
const copy = value => JSON.parse(JSON.stringify(value));
const names = { protectedNames: ["骨盆调理", "3D小颜术", "9D逆龄"] };

test("latest consolidated prompt survives language routing into Gemini", () => {
  const opts = normalizeReplyOptions({
    replyLanguage: "en", channel: "whatsapp",
    bookingContext: { status: "none" },
  });
  assert.equal(opts.replyLanguage, "en");
  const prompt = buildGeminiRequest(
    [{ role: "user", content: "How much for 骨盆调理?" }],
    opts, "gemini-3.8-flash"
  ).request.config.systemInstruction;
  assert.match(prompt, /REQUIRED REPLY LANGUAGE FOR THIS TURN: English/);
  assert.match(prompt, /not clinic instructions, treatment names/);
  assert.match(prompt, /a preference is not a confirmed booking/);
  // The default demo profile is aesthetic, so TCM-only pricing instructions
  // belong to the separate consolidated policy regression test.
  assert.match(prompt, /STRUCTURED OUTPUT/);
  assert.match(buildSystemPrompt({ replyLanguage: "ms" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN: Bahasa Malaysia/);
  assert.match(buildSystemPrompt({ replyLanguage: "zh" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN: Simplified Chinese/);
  assert.match(buildSystemPrompt({
    replyLanguage: "en", strictReplyLanguage: true, correctionSourceReply: "好的，明天见",
  }), /LANGUAGE-ONLY CORRECTION \(not a new customer question\)/);
  assert.doesNotMatch(buildSystemPrompt({ replyLanguage: "invalid" }), /REQUIRED REPLY LANGUAGE FOR THIS TURN/);
});

test("language guard avoids configured Chinese treatment-name false positives", () => {
  assert.equal(clearReplyLanguageMismatch(booking.text, "en", names), true);
  assert.equal(clearReplyLanguageMismatch("不客气，明天见哦 😊", "en", names), true);
  assert.equal(clearReplyLanguageMismatch("Sure, 骨盆调理 😊", "en", names), false);
  assert.equal(clearReplyLanguageMismatch("Morning dear, we can check 骨盆调理 at 10am.", "en", names), false);
  assert.equal(clearReplyLanguageMismatch("We can help you with 3D小颜术.", "en", names), false);
  assert.equal(clearReplyLanguageMismatch("我会帮你确认，好的 😊", "ms", names), true);
  assert.equal(clearReplyLanguageMismatch("可以的，明天见 😊", "zh", names), false);
  assert.equal(clearReplyLanguageMismatch("OK, will check soon.", "zh", names), true);
  assert.equal(clearReplyLanguageMismatch("Thanks, we will check tomorrow.", "ms", names), true);
  assert.equal(clearReplyLanguageMismatch("Saya akan semak harga untuk anda.", "en", names), true);
  assert.equal(clearReplyLanguageMismatch("Ok ya", "ms", names), false);
});

test("aligned replies cost no extra provider requests", async () => {
  let calls = 0;
  const original = { ...copy(ordinary), text: "Morning dear, we can check 骨盆调理 for 10am." };
  const result = await correctReplyLanguage(original, [], { replyLanguage: "en", ...names }, {
    getReply: async () => { calls++; throw Error("should not retry"); },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result, original);
});

test("booking-ready wrong-language draft uses fixed unconfirmed acknowledgment with zero retries", async () => {
  let calls = 0;
  const result = await correctReplyLanguage(copy(booking), [], {
    replyLanguage: "en", bookingContext: { status: "none" }, ...names,
  }, {
    getReply: async () => { calls++; throw Error("booking must never be regenerated"); },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 0);
  assert.equal(result.bookingReady, true);
  assert.equal(result.flagged, false);
  assert.deepEqual(result.details, booking.details);
  assert.match(result.text, /ask the team to check availability and confirm/);
  assert.doesNotMatch(result.text, /appointment is confirmed|see you tomorrow/i);
});

test("one correction is explicitly tied to the original reply and preserves all structured intent", async () => {
  let calls = 0;
  const initial = copy(ordinary);
  const revised = { ...copy(ordinary), text: "Hello, I can explain 骨盆调理 for you 😊" };
  const result = await correctReplyLanguage(initial, [], {
    replyLanguage: "en", bookingContext: { status: "none" }, ...names,
  }, {
    getReply: async (_history, opts) => {
      calls++;
      assert.equal(opts.replyLanguage, "en");
      assert.equal(opts.strictReplyLanguage, true);
      assert.equal(opts.correctionSourceReply, initial.text);
      return JSON.stringify(revised);
    },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 1);
  assert.equal(result.text, revised.text);
  assert.equal(result.outcome, "normal");
  assert.equal(result.bookingReady, false);
  assert.deepEqual(result.details, initial.details);
});

test("a changed treatment or altered intent triggers a staff handoff instead of a customer send", async () => {
  const result = await correctReplyLanguage(copy(ordinary), [], {
    replyLanguage: "en", ...names,
  }, {
    getReply: async () => JSON.stringify({
      ...copy(ordinary), text: "We recommend 9D逆龄 instead.",
      serviceQuery: true,
    }),
    parseReply: JSON.parse,
  });
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, false);
  assert.equal(result.languageCorrectionFailed, true);
  assert.match(result.text, /ask the team/);
  assert.deepEqual(result.details, ordinary.details);
});

test("a second model cannot invent a confirmed appointment", async () => {
  const result = await correctReplyLanguage(copy(ordinary), [], {
    replyLanguage: "en", bookingContext: { status: "none" }, ...names,
  }, {
    getReply: async () => JSON.stringify({
      ...copy(ordinary), text: "Your appointment is confirmed for tomorrow.",
    }),
    parseReply: JSON.parse,
  });
  assert.equal(result.flagged, true);
  assert.equal(result.languageCorrectionFailed, true);
  assert.doesNotMatch(result.text, /confirmed for tomorrow/);
  assert.equal(correctionPreservesClaims(
    { text: "We'll ask the team to confirm." },
    { text: "Your appointment is confirmed." },
    { bookingContext: { status: "none" } }
  ), false);
});

test("verified amounts and appointment digits cannot change in language-only correction", () => {
  assert.equal(correctionPreservesClaims(
    { text: "优惠 RM388, 明天 10am" },
    { text: "RM288, tomorrow at 10am" },
  ), false);
  assert.equal(correctionPreservesClaims(
    { text: "优惠 RM388, 明天 10am" },
    { text: "Offer RM388, tomorrow at 11am" },
  ), false);
  assert.equal(correctionPreservesClaims(
    { text: "优惠 RM388, 明天 10am" },
    { text: "Offer RM388, tomorrow at 10am" },
  ), true);
});

test("failed correction hands off without silent information-review recovery", async () => {
  let calls = 0;
  const result = await correctReplyLanguage(copy(ordinary), [], { replyLanguage: "en", ...names }, {
    getReply: async () => {
      calls++;
      return JSON.stringify({ ...copy(ordinary), text: "好的，明天见哦" });
    },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 1);
  assert.equal(result.flagged, true);
  assert.equal(result.reviewRequired, false);
  assert.equal(result.languageCorrectionFailed, true);
});

test("already flagged clinical review does not request a second model response", async () => {
  let calls = 0;
  const clinical = { ...copy(ordinary), outcome: "review_required", flagged: true };
  await correctReplyLanguage(clinical, [], { replyLanguage: "en", ...names }, {
    getReply: async () => { calls++; },
    parseReply: JSON.parse,
  });
  assert.equal(calls, 0);
});

test("actual reply correction runs ahead of downstream pricing, booking and outbound guards", () => {
  const src = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
  const draft = src.indexOf("const rawAiReply = await ai.getReply(modelReplyHistory");
  const guard = src.indexOf("const languageCheckedReply = await correctReplyLanguage(");
  const assembled = src.indexOf("let reply = isFirstMessage && !flagged");
  const sent = src.indexOf("const sendOutcome = await sendTrackedText(");
  assert.ok(draft > 0 && guard > draft && assembled > guard && sent > assembled);
  assert.match(src.slice(draft - 500, assembled), /replyLanguage: mediaLanguage/);
});
