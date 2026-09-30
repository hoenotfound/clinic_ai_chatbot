const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCustomerCsv,
  identifierCsvCell,
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

test("customer export preserves long platform identifiers as spreadsheet text", () => {
  const row = {
    customer_name: "Instagram user",
    channel: "instagram",
    whatsapp_number: null,
    social_account_id: "17841400000000000",
    message_count: 1,
  };

  const customerCsv = buildCustomerCsv([row], "customer");

  assert.match(customerCsv, /"Platform Customer ID"/);
  assert.match(customerCsv, /"=""17841400000000000"""/);
  assert.match(customerCsv, /"Instagram"/);
});

test("identifier CSV formatting only uses a text formula for numeric identifiers", () => {
  assert.equal(identifierCsvCell("17841400000000000"), '"=""17841400000000000"""');
  assert.equal(identifierCsvCell("abc-123"), '"abc-123"');
  assert.equal(identifierCsvCell("=SUM(A1:A2)"), '"\'=SUM(A1:A2)"');
});

test("full CRM export keeps captured attribution separate from staff overrides", () => {
  const csv = buildCustomerCsv([{
    customer_name: "Alex",
    channel: "whatsapp",
    whatsapp_number: "60123456789",
    attribution_source: "meta_ads",
    attribution_platform: "facebook",
    attribution_campaign_name: "Acne September",
    lead_source: "referral",
    lead_campaign_name: "Retargeting October",
    campaign_id: "12345678901234567",
    adset_id: "22345678901234567",
    meta_ad_id: "32345678901234567",
    message_count: 3,
  }], "full");

  assert.match(csv, /"Captured Acquisition Source"/);
  assert.match(csv, /"Source Override"/);
  assert.match(csv, /"Captured Campaign"/);
  assert.match(csv, /"Campaign Override"/);
  assert.match(csv, /"meta_ads"/);
  assert.match(csv, /"referral"/);
  assert.match(csv, /"Acne September"/);
  assert.match(csv, /"Retargeting October"/);
  assert.match(csv, /"=""12345678901234567"""/);
  assert.match(csv, /"=""22345678901234567"""/);
  assert.match(csv, /"=""32345678901234567"""/);
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
