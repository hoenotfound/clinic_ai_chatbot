const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeWhatsappNumber } = require("../src/db/contactsRepo");

test("normalizes common Malaysian WhatsApp number formats to country-code digits", () => {
  const examples = new Map([
    ["012-345 6789", "60123456789"],
    ["+60 12-345 6789", "60123456789"],
    ["+60 012-345 6789", "60123456789"],
    ["0060 12-345 6789", "60123456789"],
    ["60123456789", "60123456789"],
    ["123456789", "60123456789"],
    ["011-1234 5678", "601112345678"],
    ["1112345678", "601112345678"],
  ]);

  for (const [input, expected] of examples) {
    assert.equal(normalizeWhatsappNumber(input), expected, input);
  }
});

test("keeps explicit non-Malaysian international numbers intact", () => {
  assert.equal(normalizeWhatsappNumber("+65 8123 4567"), "6581234567");
  assert.equal(normalizeWhatsappNumber("0065 8123 4567"), "6581234567");
  assert.equal(normalizeWhatsappNumber("+1 415 555 2671"), "14155552671");
});
