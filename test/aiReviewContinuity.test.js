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
  assert.match(repo, /AND c\.mode = 'ai' AND c\.needs_attention = false/);
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
