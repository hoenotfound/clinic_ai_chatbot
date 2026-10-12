const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseIncomingMessages } = require("../src/services/whatsappService");
const { initialInboundText } = require("../src/services/inboundMessageClaimService");

const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const prompt = fs.readFileSync(path.join(__dirname, "../src/utils/systemPrompt.js"), "utf8");

function section(start, end) {
  const from = server.indexOf(start);
  const to = server.indexOf(end, from + start.length);
  assert.ok(from >= 0, `Expected ${start}`);
  assert.ok(to > from, `Expected ${end} after ${start}`);
  return server.slice(from, to);
}

test("unsupported webhook events keep Meta diagnostics without preserving arbitrary raw payload", () => {
  const [incoming] = parseIncomingMessages({
    entry: [{
      changes: [{
        value: { messages: [{
          id: "wamid.unsupported-test",
          from: "60123",
          type: "unsupported",
          errors: [{
            code: 131051,
            title: "Unsupported message type",
            message: "This message type is not supported",
            error_data: { details: "More detail from Meta" },
            private_token: "must-not-be-retained",
          }],
        }] },
      }],
    }],
  });
  assert.equal(incoming.unsupportedType, "unsupported");
  assert.deepEqual(incoming.unsupportedErrors, [{
    code: 131051,
    title: "Unsupported message type",
    message: "This message type is not supported",
    details: "More detail from Meta",
  }]);
  assert.equal(incoming.unsupportedErrors[0].private_token, undefined);
  assert.doesNotMatch(initialInboundText(incoming), /unsupported unsupported/i);
  assert.match(initialInboundText(incoming), /could not be displayed/);
});

test("unknown unsupported event remains staff-visible when Meta omitted errors", () => {
  const [incoming] = parseIncomingMessages({
    entry: [{ changes: [{ value: { messages: [{
      id: "wamid.no-details", from: "60124", type: "unsupported",
    }] } }] }],
  });
  assert.equal(incoming.unsupportedErrors, undefined);
  assert.equal(incoming.unsupportedType, "unsupported");
});

test("unreadable WhatsApp, voice and photo turns do not send scripted apologies", () => {
  for (const [start, end] of [
    ["if (unsupportedType) {", 'let text = incoming.text || "";'],
    ["if (!transcript) {", "text = `🎤 ${transcript}`;"],
    ['if (mediaType === "image") {', 'if (mediaType === "video") {'],
  ]) {
    const code = section(start, end);
    assert.match(code, /contactsRepo\.setAiReviewAttention/);
    assert.match(code, /return \{ wasFirstMessage, keywordReason \};/);
    assert.doesNotMatch(code, /sendTrackedText|system_fallback|pauseAiForHumanHandoff/);
  }
});

test("non-urgent model and keyword review turns are silent and keep AI ownership", () => {
  const reviews = section("if (flagged && reviewRequired) {", "} else if (flagged) {");
  assert.match(reviews, /setAiReviewAttention/);
  assert.match(reviews, /return \{ wasFirstMessage, keywordReason \};/);
  assert.doesNotMatch(reviews, /pauseAiForHumanHandoff/);
  // Other review turns remain silent; only a verified TCM clinical
  // acknowledgement may use the guarded outbound path.
  assert.match(reviews, /if \(clinicalAcknowledgement\)/);
  assert.match(reviews, /await sendTrackedText\(/);
  const keyword = section("A model can miss a clear complaint", "let reply = isFirstMessage");
  assert.match(keyword, /reviewRequired = false/);
  assert.match(keyword, /fallbackHandoffReply/);
  assert.match(server, /if \(urgentSafety \|\| isActiveSafetyConcern\(text\)\) \{/);
  assert.match(server, /fallbackHandoffReply\([\s\S]*?\{ urgent: true \}/);
  assert.match(server, /const sendOutcome = await sendTrackedText/);
});

test("processing failure is private and does not disable a subsequent AI turn", () => {
  const tail = section("Error handling incoming", "// Runtime secret checks");
  assert.match(tail, /setTemporaryAiAttention/);
  assert.match(tail, /setAiReviewAttention/);
  assert.doesNotMatch(tail, /sendTrackedText|pauseAiForHumanHandoff|system_fallback/);
});

test("prompt requests silent review but permits normal replies and truthful identity answers", () => {
  assert.match(prompt, /sends NO customer-facing reply for this turn/);
  assert.match(prompt, /Continue to answer future unrelated questions/);
  assert.match(prompt, /If explicitly asked whether you're automated, answer truthfully/);
  assert.match(prompt, /Do not proactively call yourself an AI/);
});

test("media review uses the nonblocking informational category", () => {
  const targets = [
    ["if (unsupportedType) {", 'let text = incoming.text || "";'],
    ["if (!transcript) {", "text = `🎤 ${transcript}`;"],
    ['if (mediaType === "image") {', 'if (mediaType === "video") {'],
    ['if (mediaType === "video") {', 'if (mediaType === "sticker") {'],
    ['if (mediaType === "video" && !String(incoming.text || "").trim()) {', 'if (mediaType === "sticker") {'],
  ];
  for (const [start, end] of targets) {
    const code = section(start, end);
    assert.match(code, /setAiReviewAttention/);
    assert.match(code, /"information"/);
    assert.doesNotMatch(code, /contactsRepo\.setAttention\(/);
  }
});

test("burst selection prioritizes customer safety and keeps ordinary issues separate", () => {
  const block = section("async function processIncomingBatch(items) {", "/**\n * Store only the durable");
  assert.match(block, /checkKeywordTriggers\(message\)/);
  assert.match(block, /inheritedKeywordReason = URGENT_SAFETY_REASON/);
  assert.doesNotMatch(block, /inheritedKeywordReason = result\.keywordReason/);
  assert.match(server, /if \(suppressAutoReply\) \{[\s\S]*?setAiReviewAttention/);
  assert.match(server, /if \(isExplicitStaffRequest\(text\)\)/);
});

test("clinical and staff handoffs remain distinct from silent one-off questions", () => {
  const handoff = section("if (urgentSafety || isActiveSafetyConcern(text)) {", "let reply = isFirstMessage");
  assert.match(handoff, /isExplicitStaffRequest\(text\)/);
  assert.match(handoff, /fallbackHandoffReply/);
  assert.match(handoff, /isUnanswerableCustomerReply\(aiReply, text\)/);
  const review = section("if (flagged && reviewRequired) {", "} else if (flagged) {");
  assert.doesNotMatch(review, /pauseAiForHumanHandoff/);
  assert.match(review, /if \(clinicalAcknowledgement\)/);
  assert.match(review, /await sendTrackedText\(/);
  assert.match(server, /isFirstMessage && !flagged && !generateFirstIntro/);
});
