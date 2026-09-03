const test = require("node:test");
const assert = require("node:assert/strict");

const {
  BOOKING_READY_REASON,
  createBookingReadyOutcomeService,
} = require("../src/services/bookingReadyOutcomeService");

function fakeDatabase({
  temperature = "warm",
  temperatureLocked = false,
  contactUpdated = true,
  branchName = null,
  treatmentInterest = null,
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });

      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
        return { rows: [] };
      }
      if (normalized.startsWith("UPDATE contacts")) {
        return { rows: contactUpdated ? [{ id: 42 }] : [] };
      }
      if (normalized.startsWith("SELECT id, temperature, temperature_locked, branch_name, treatment_interest FROM leads")) {
        return {
          rows: [{
            id: 9,
            temperature,
            temperature_locked: temperatureLocked,
            branch_name: branchName,
            treatment_interest: treatmentInterest,
          }],
        };
      }
      if (normalized.startsWith("UPDATE leads")) {
        return { rows: [{ id: 9 }] };
      }
      if (normalized.startsWith("INSERT INTO lead_activities")) {
        return { rows: [{ id: 100 }] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    release() {},
  };

  return {
    calls,
    database: {
      async connect() {
        return client;
      },
    },
  };
}

test("booking-ready flags Inbox, makes an unlocked lead Hot, records activity, and alerts Telegram", async () => {
  const { database, calls } = fakeDatabase();
  const published = [];
  const alerts = [];
  const markBookingReady = createBookingReadyOutcomeService({
    database,
    publish(type, payload) {
      published.push({ type, payload });
    },
    sendBookingReadyAlert(input) {
      alerts.push(input);
      return { status: "sent" };
    },
  });

  const result = await markBookingReady(42, 777);

  assert.equal(result.contactUpdated, true);
  assert.equal(result.leadId, 9);
  assert.equal(result.leadChanged, true);
  assert.deepEqual(result.details, {
    branch: null,
    treatment: null,
    appointmentPreference: null,
  });
  assert.ok(
    calls.some(({ sql }) =>
      sql.includes("temperature_locked = false THEN 'hot'") &&
      sql.includes("temperature_locked = false THEN 'ai'")
    )
  );
  assert.ok(
    calls.some(({ sql, params }) =>
      sql.startsWith("INSERT INTO lead_activities") &&
      params[2]?.outcome === "booking_ready" &&
      params[2]?.messageId === 777
    )
  );
  assert.deepEqual(alerts, [
    { contactId: 42, messageId: 777, reason: BOOKING_READY_REASON },
  ]);
  assert.ok(
    published.some(
      ({ type, payload }) =>
        type === "conversation_changed" && payload.reason === "booking_ready"
    )
  );
  assert.ok(
    published.some(
      ({ type, payload }) => type === "pipeline_changed" && payload.leadId === 9
    )
  );

  const allSql = calls.map(({ sql }) => sql).join("\n");
  const contactUpdate = calls.find(({ sql }) => sql.startsWith("UPDATE contacts"));
  assert.match(allSql, /mode = 'ai'/i);
  assert.doesNotMatch(contactUpdate.sql, /attention_reason LIKE 'Booking ready:%'/i);
  assert.doesNotMatch(allSql, /appointment_status/i);
  assert.doesNotMatch(allSql, /stage_id\s*=/i);
});

test("structured Booking Ready persists canonical branch/treatment and appointment preference metadata", async () => {
  const { database, calls } = fakeDatabase();
  const markBookingReady = createBookingReadyOutcomeService({
    database,
    publish() {},
    sendBookingReadyAlert() { return { status: "sent" }; },
  });

  const result = await markBookingReady(42, 780, {
    details: {
      branch: "Petaling Jaya",
      treatment: "HIFU Non-Surgical Facelift",
      appointmentPreference: "Saturday afternoon",
    },
  });

  assert.deepEqual(result.details, {
    branch: "Petaling Jaya",
    treatment: "HIFU Non-Surgical Facelift",
    appointmentPreference: "Saturday afternoon",
  });
  const leadUpdate = calls.find(({ sql }) => sql.startsWith("UPDATE leads"));
  assert.equal(leadUpdate.params[1], "Petaling Jaya");
  assert.equal(leadUpdate.params[2], "HIFU Non-Surgical Facelift");
  const activity = calls.find(({ sql }) => sql.startsWith("INSERT INTO lead_activities"));
  assert.equal(activity.params[2].appointmentPreference, "Saturday afternoon");
  assert.doesNotMatch(leadUpdate.sql, /appointment_at/i);
});

test("booking-ready preserves a staff-locked lead temperature when no structured details changed", async () => {
  const { database, calls } = fakeDatabase({
    temperature: "cold",
    temperatureLocked: true,
  });
  const markBookingReady = createBookingReadyOutcomeService({
    database,
    publish() {},
    sendBookingReadyAlert() {
      return { status: "sent" };
    },
  });

  await markBookingReady(42, 778);

  assert.equal(
    calls.some(({ sql }) => sql.startsWith("UPDATE leads")),
    false
  );
  assert.equal(
    calls.some(({ sql }) => sql.startsWith("INSERT INTO lead_activities")),
    true
  );
});

test("booking-ready does nothing when the contact is no longer eligible for a fresh outcome", async () => {
  const { database, calls } = fakeDatabase({ contactUpdated: false });
  const published = [];
  const alerts = [];
  const markBookingReady = createBookingReadyOutcomeService({
    database,
    publish(type, payload) {
      published.push({ type, payload });
    },
    sendBookingReadyAlert(input) {
      alerts.push(input);
      return { status: "sent" };
    },
  });

  const result = await markBookingReady(42, 779);

  assert.equal(result.contactUpdated, false);
  assert.equal(result.leadId, null);
  assert.equal(result.leadChanged, false);
  assert.deepEqual(result.details, {
    branch: null,
    treatment: null,
    appointmentPreference: null,
  });
  assert.equal(
    calls.some(({ sql }) => sql.includes("FROM leads")),
    false
  );
  assert.deepEqual(published, []);
  assert.deepEqual(alerts, []);
});
