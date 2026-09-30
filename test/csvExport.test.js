const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCustomerCsv,
  malaysiaDateTime,
  safeSpreadsheetValue,
} = require("../src/utils/csvExport");

test("customer CSV protects spreadsheet formulas and preserves CSV quoting", () => {
  const csv = buildCustomerCsv([
    {
      customer_name: '=HYPERLINK("https://example.com","x")',
      channel: "whatsapp",
      whatsapp_number: "60123456789",
      stage_name: "New Lead",
      treatment_interest: 'Facial, "Glow"',
      owner_display_name: "Alice",
      lead_source: "Referral",
      lead_campaign_name: "Line 1\nLine 2",
      message_count: 4,
      customer_created_at: "2026-09-30T08:00:00.000Z",
    },
  ]);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.com"",""x""\)"/);
  assert.match(csv, /"Facial, ""Glow"""/);
  assert.match(csv, /"Line 1\nLine 2"/);
});

test("full export includes social identifier while customer preset does not expose it", () => {
  const row = {
    customer_name: "Instagram user",
    channel: "instagram",
    whatsapp_number: null,
    social_account_id: "17841400000000000",
    message_count: 1,
  };

  const customerCsv = buildCustomerCsv([row], "customer");
  const fullCsv = buildCustomerCsv([row], "full");

  assert.doesNotMatch(customerCsv, /17841400000000000/);
  assert.match(fullCsv, /17841400000000000/);
  assert.match(customerCsv, /"Instagram"/);
});

test("spreadsheet sanitizer catches dangerous prefixes after whitespace", () => {
  assert.equal(safeSpreadsheetValue(" =1+1"), "' =1+1");
  assert.equal(safeSpreadsheetValue("@SUM(A1:A2)"), "'@SUM(A1:A2)");
  assert.equal(safeSpreadsheetValue("Normal"), "Normal");
});

test("export dates are explicit Malaysia time", () => {
  assert.equal(
    malaysiaDateTime("2026-09-30T11:42:00.000Z"),
    "2026-09-30 19:42:00 +08:00"
  );
});
