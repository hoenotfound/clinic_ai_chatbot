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
  assert.match(prompt, /send \| skip \| human_review/);
  assert.match(prompt, /Keep it low pressure\./);
  assert.match(prompt, /Earlier follow-up/);
  assert.match(prompt, /Current BUSINESS INFORMATION/i);
});
