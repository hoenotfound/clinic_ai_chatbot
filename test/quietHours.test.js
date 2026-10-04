const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_QUIET_HOURS,
  normalizeQuietHours,
  quietHoursStatus,
} = require("../src/utils/quietHours");

test("defaults follow-up quiet hours to midnight through 7am", () => {
  assert.deepEqual(normalizeQuietHours(undefined), DEFAULT_QUIET_HOURS);
});

test("midnight-to-7am quiet hours use clinic-local Malaysia time", () => {
  const during = quietHoursStatus(
    new Date("2026-10-04T16:30:00.000Z"),
    { enabled: true, start: "00:00", end: "07:00" },
    { timeZone: "Asia/Kuala_Lumpur" }
  );
  assert.equal(during.active, true);
  assert.equal(during.endsAt, "2026-10-04T23:00:00.000Z");

  const atEnd = quietHoursStatus(
    new Date("2026-10-04T23:00:00.000Z"),
    { enabled: true, start: "00:00", end: "07:00" },
    { timeZone: "Asia/Kuala_Lumpur" }
  );
  assert.equal(atEnd.active, false);

  const beforeStart = quietHoursStatus(
    new Date("2026-10-04T15:59:00.000Z"),
    { enabled: true, start: "00:00", end: "07:00" },
    { timeZone: "Asia/Kuala_Lumpur" }
  );
  assert.equal(beforeStart.active, false);
});

test("quiet hours can cross midnight", () => {
  const lateNight = quietHoursStatus(
    new Date("2026-10-04T15:30:00.000Z"),
    { enabled: true, start: "22:00", end: "07:00" },
    { timeZone: "Asia/Kuala_Lumpur" }
  );
  assert.equal(lateNight.active, true);
  assert.equal(lateNight.endsAt, "2026-10-04T23:00:00.000Z");

  const afterMidnight = quietHoursStatus(
    new Date("2026-10-04T18:00:00.000Z"),
    { enabled: true, start: "22:00", end: "07:00" },
    { timeZone: "Asia/Kuala_Lumpur" }
  );
  assert.equal(afterMidnight.active, true);
  assert.equal(afterMidnight.endsAt, "2026-10-04T23:00:00.000Z");
});

test("disabled quiet hours never block and invalid equal times fail validation", () => {
  assert.equal(
    quietHoursStatus(
      new Date("2026-10-04T17:00:00.000Z"),
      { enabled: false, start: "00:00", end: "07:00" }
    ).active,
    false
  );
  assert.equal(
    normalizeQuietHours({ enabled: true, start: "07:00", end: "07:00" }),
    null
  );
});
