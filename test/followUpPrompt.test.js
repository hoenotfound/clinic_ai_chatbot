const test = require("node:test");
const assert = require("node:assert/strict");
const { buildFollowUpPrompt } = require("../src/utils/systemPrompt");

test("AI follow-up prompt includes live business context and structured decision contract", () => {
  const prompt = buildFollowUpPrompt({
    channel: "whatsapp",
    followUpContext: {
      stepNumber: 2,
      treatmentInterest: "3D 小颜术",
      stageName: "Warm",
      instruction: "Keep it low pressure.",
      previousFollowUps: ["Earlier follow-up"],
    },
  });

  assert.match(prompt, /FOLLOW-UP STEP:/);
  assert.match(prompt, /Step: 2/);
  assert.match(prompt, /Current service aliases:/);
  assert.match(prompt, /Current FAQs:/);
  assert.match(prompt, /Current active promotions:/);
  assert.match(prompt, /ACTIVE PROMOTIONS is the only authority/i);
  assert.match(prompt, /auto-send on price\/package enquiry.*internal automation metadata/i);
  assert.match(prompt, /send \| skip \| human_review/);
  assert.match(prompt, /Keep it low pressure\./);
  assert.match(prompt, /Earlier follow-up/);
  assert.match(prompt, /Current BUSINESS INFORMATION/i);
  assert.match(prompt, /Messages labeled STAFF were manually sent/i);
  assert.match(
    prompt,
    /Do NOT use "human_review" solely because a STAFF message mentioned an offer, voucher, discount/i
  );
  assert.match(
    prompt,
    /refer neutrally to "the offer\/voucher we sent earlier"/i
  );
  assert.match(
    prompt,
    /asks you to confirm whether an unconfigured STAFF offer is still valid.*use "human_review"/is
  );
});
