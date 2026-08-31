const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AnalyticsValidationError,
  formatDateInTimeZone,
  inclusiveDayCount,
  normalizeAnalyticsQuery,
  shiftDate,
} = require("../src/utils/analyticsValidation");

test("analytics defaults to a 30-day Malaysia-time range", () => {
  const filters = normalizeAnalyticsQuery({}, new Date("2026-08-31T10:00:00Z"));
  assert.equal(filters.to, "2026-08-31");
  assert.equal(filters.from, "2026-08-02");
  assert.equal(filters.dayCount, 30);
  assert.equal(filters.previousTo, "2026-08-01");
  assert.equal(filters.previousFrom, "2026-07-03");
  assert.equal(filters.timeZone, "Asia/Kuala_Lumpur");
});

test("Malaysia date formatting crosses UTC midnight correctly", () => {
  assert.equal(
    formatDateInTimeZone(new Date("2026-08-31T16:30:00Z")),
    "2026-09-01"
  );
});

test("analytics accepts a one-day custom range", () => {
  const filters = normalizeAnalyticsQuery({
    from: "2026-08-15",
    to: "2026-08-15",
    branch: "Puchong",
    channel: "whatsapp",
    source: "Facebook",
  });
  assert.equal(filters.dayCount, 1);
  assert.equal(filters.previousFrom, "2026-08-14");
  assert.equal(filters.previousTo, "2026-08-14");
  assert.equal(filters.branch, "Puchong");
  assert.equal(filters.channel, "whatsapp");
  assert.equal(filters.source, "Facebook");
});

test("all filter values normalize to null", () => {
  const filters = normalizeAnalyticsQuery({
    from: "2026-08-01",
    to: "2026-08-31",
    branch: "all",
    channel: "all",
    campaign: "all",
  });
  assert.equal(filters.branch, null);
  assert.equal(filters.channel, null);
  assert.equal(filters.campaign, null);
});

test("analytics rejects reversed ranges", () => {
  assert.throws(
    () => normalizeAnalyticsQuery({ from: "2026-09-01", to: "2026-08-31" }),
    AnalyticsValidationError
  );
});

test("analytics rejects ranges over 366 days", () => {
  assert.throws(
    () => normalizeAnalyticsQuery({ from: "2025-01-01", to: "2026-08-31" }),
    /can't exceed 366 days/
  );
});

test("analytics rejects invalid dates and channels", () => {
  assert.throws(
    () => normalizeAnalyticsQuery({ from: "2026-02-30", to: "2026-03-01" }),
    /not a valid date/
  );
  assert.throws(
    () => normalizeAnalyticsQuery({ from: "2026-08-01", to: "2026-08-31", channel: "sms" }),
    /channel must be/
  );
});

test("date helpers keep inclusive day counts stable", () => {
  assert.equal(inclusiveDayCount("2026-08-02", "2026-08-31"), 30);
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
});
