const test = require("node:test");
const assert = require("node:assert/strict");

const clinicConfig = require("../src/config/clinicConfig");
const {
  canonicalConfiguredName,
  canonicalConfiguredService,
  parseAiReplyResult,
} = require("../src/utils/aiReplyResult");

test("parses a structured booking-ready response and keeps booking metadata internal", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "can 👍 I'll get the PJ team to check Saturday afternoon for u",
    outcome: "booking_ready",
    treatment: "HIFU Non-Surgical Facelift",
    branch: "Petaling Jaya",
    appointmentPreference: "Saturday afternoon",
    staffSummary: "Customer is interested in HIFU for jawline sagging and wants PJ on Saturday afternoon. Staff should confirm availability.",
  }));

  assert.equal(result.bookingReady, true);
  assert.equal(result.flagged, false);
  assert.equal(result.text, "can 👍 I'll get the PJ team to check Saturday afternoon for u");
  assert.deepEqual(result.details, {
    treatment: "HIFU Non-Surgical Facelift",
    branch: "Petaling Jaya",
    appointmentPreference: "Saturday afternoon",
    staffSummary: "Customer is interested in HIFU for jawline sagging and wants PJ on Saturday afternoon. Staff should confirm availability.",
  });
});

test("staffSummary is ignored for non-booking outcomes", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "sure, what area are you looking to improve?",
    outcome: "normal",
    treatment: null,
    branch: null,
    appointmentPreference: null,
    staffSummary: "This must not become internal booking metadata.",
  }));

  assert.equal(result.bookingReady, false);
  assert.equal(Object.hasOwn(result.details, "staffSummary"), false);
});

test("clinic booking_ready ignores stray renovation-only fields from structured model output", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "can 👍 I'll get the PJ team to check Saturday afternoon for u",
    outcome: "booking_ready",
    treatment: "HIFU Non-Surgical Facelift",
    branch: "Petaling Jaya",
    appointmentPreference: "Saturday afternoon",
    projectLocation: "Cheras",
    projectSummary: "This should not enter clinic booking metadata.",
    nextStep: "site_visit",
  }));

  assert.equal(result.bookingReady, true);
  assert.deepEqual(result.details, {
    branch: "Petaling Jaya",
    treatment: "HIFU Non-Surgical Facelift",
    appointmentPreference: "Saturday afternoon",
  });
  assert.equal(Object.hasOwn(result.details, "projectLocation"), false);
  assert.equal(Object.hasOwn(result.details, "projectSummary"), false);
  assert.equal(Object.hasOwn(result.details, "nextStep"), false);
});

test("structured booking_ready missing branch/time is rejected for retry/fallback", () => {
  assert.throws(
    () => parseAiReplyResult(JSON.stringify({
      reply: "which branch works for u?",
      outcome: "booking_ready",
      treatment: "HIFU Non-Surgical Facelift",
      branch: null,
      appointmentPreference: null,
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("common unambiguous configured branch shorthand is canonicalized", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "I'll get the PJ team to check for u",
    outcome: "booking_ready",
    treatment: "HIFU Non-Surgical Facelift",
    branch: "PJ",
    appointmentPreference: "Saturday 3pm",
  }));

  assert.equal(result.bookingReady, true);
  assert.equal(result.details.branch, "Petaling Jaya");
});

test("non-configured Booking Ready branch is rejected for retry/fallback", () => {
  assert.throws(
    () => parseAiReplyResult(JSON.stringify({
      reply: "I'll get the team to check for u",
      outcome: "booking_ready",
      treatment: "HIFU Non-Surgical Facelift",
      branch: "Mont Kiara",
      appointmentPreference: "Saturday 3pm",
    })),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("malformed JSON-looking AI output fails closed instead of leaking raw control output", () => {
  assert.throws(
    () => parseAiReplyResult('{"reply":"hello","outcome":'),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("unstructured provider prose is rejected instead of being sent to the customer", () => {
  assert.throws(
    () => parseAiReplyResult("Hi there, how can I help?"),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("customer-facing prose plus leaked JSON construction is rejected", () => {
  const leaked = [
    "Hi 你好 👋 欢迎来到 Neutro Sense TCM~",
    "",
    "有几款不同的限时配套可以选择哦~",
    "",
    "3. **JSON Construction:**",
    JSON.stringify({
      reply: "这段内部结构不应该显示给顾客",
      outcome: "normal",
      treatment: null,
      branch: null,
      appointmentPreference: null,
    }),
  ].join("\n");

  assert.throws(
    () => parseAiReplyResult(leaked),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("legacy markers remain supported during structured-output rollout", () => {
  const result = parseAiReplyResult("[[NEEDS_HUMAN]] our team will check this for u");
  assert.equal(result.flagged, true);
  assert.equal(result.structured, false);
  assert.equal(result.text, "our team will check this for u");
});

test("non-clinic profiles downgrade structured booking_ready without validating clinic metadata", (t) => {
  const originalConversion = clinicConfig.conversion;
  t.after(() => {
    clinicConfig.conversion = originalConversion;
  });
  clinicConfig.conversion = {
    ...(originalConversion || {}),
    bookingReadyEnabled: false,
  };

  const result = parseAiReplyResult(JSON.stringify({
    reply: "I can pass these project details to the team for a site visit discussion.",
    outcome: "booking_ready",
    branch: null,
    treatment: null,
    appointmentPreference: null,
  }));

  assert.equal(result.bookingReady, false);
  assert.equal(result.flagged, false);
  assert.equal(result.outcome, "normal");
  assert.equal(result.structured, true);
  assert.deepEqual(result.details, {
    branch: null,
    treatment: null,
    appointmentPreference: null,
  });
});

test("non-clinic profiles also suppress legacy booking-ready markers", (t) => {
  const originalConversion = clinicConfig.conversion;
  t.after(() => {
    clinicConfig.conversion = originalConversion;
  });
  clinicConfig.conversion = {
    ...(originalConversion || {}),
    bookingReadyEnabled: false,
  };

  const result = parseAiReplyResult("[[BOOKING_READY]] our team will follow up on the quotation");
  assert.equal(result.bookingReady, false);
  assert.equal(result.flagged, false);
  assert.equal(result.outcome, "normal");
  assert.equal(result.text, "our team will follow up on the quotation");
  assert.equal(result.structured, false);
});


test("structured replies expose only an explicit boolean priceQuery signal", () => {
  const yes = parseAiReplyResult(JSON.stringify({
    reply: "The current price is shown below.",
    outcome: "normal",
    priceQuery: true,
    packageQuery: false,
    promotionOption: "Package B",
    treatment: "HIFU Non-Surgical Facelift",
    branch: null,
    appointmentPreference: null,
  }));
  assert.equal(yes.priceQuery, true);
  assert.equal(yes.packageQuery, false);
  assert.equal(yes.promotionOption, "Package B");
  assert.equal(yes.details.treatment, "HIFU Non-Surgical Facelift");

  const stringFalse = parseAiReplyResult(JSON.stringify({
    reply: "HIFU can help with lifting.",
    outcome: "normal",
    priceQuery: "true",
    treatment: "HIFU Non-Surgical Facelift",
    branch: null,
    appointmentPreference: null,
  }));
  assert.equal(stringFalse.priceQuery, false);

  assert.throws(
    () => parseAiReplyResult("How can I help?"),
    (err) => err.code === "INVALID_AI_RESPONSE"
  );
});

test("canonical service matching preserves Chinese names and aliases without collisions", () => {
  const services = [
    { name: "3D 小颜术" },
    { name: "3D 骨盆调理" },
  ];
  const aliases = [
    { alias: "小脸", officialService: "3D 小颜术" },
  ];

  assert.equal(canonicalConfiguredName("3D 骨盆调理", services), "3D 骨盆调理");
  assert.equal(canonicalConfiguredService("小脸", services, aliases), "3D 小颜术");
});

test("canonical service matching tolerates harmless Latin-Chinese spacing changes", () => {
  const services = [
    { name: "3D 小颜术" },
    { name: "9D 逆龄抗衰" },
  ];

  assert.equal(canonicalConfiguredName("3D小颜术", services), "3D 小颜术");
  assert.equal(canonicalConfiguredService("9D逆龄抗衰", services, []), "9D 逆龄抗衰");
});

test("compact canonical matching fails closed when formatting would be ambiguous", () => {
  const services = [
    { name: "AB C" },
    { name: "A BC" },
  ];

  assert.equal(canonicalConfiguredName("ABC", services), null);
});



test("structured replies expose an explicit packageQuery signal independently of priceQuery", () => {
  const result = parseAiReplyResult(JSON.stringify({
    reply: "有几个配套选择，我简单发你看看。",
    outcome: "normal",
    priceQuery: false,
    packageQuery: true,
    promotionOption: null,
    treatment: "HIFU Non-Surgical Facelift",
    branch: null,
    appointmentPreference: null,
  }));

  assert.equal(result.priceQuery, false);
  assert.equal(result.packageQuery, true);
  assert.equal(result.promotionOption, null);
});
