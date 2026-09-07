const test = require("node:test");
const assert = require("node:assert/strict");

const liveConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  createBookingReadyOutcomeService,
} = require("../src/services/bookingReadyOutcomeService");

async function withProfile(profile, callback) {
  const previous = { ...liveConfig };
  for (const key of Object.keys(liveConfig)) delete liveConfig[key];
  Object.assign(liveConfig, profile);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(liveConfig)) delete liveConfig[key];
    Object.assign(liveConfig, previous);
  }
}

function fakeDatabase() {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) return { rows: [] };
      if (normalized.startsWith("UPDATE contacts")) return { rows: [{ id: 42 }] };
      if (normalized.startsWith("SELECT id, temperature, temperature_locked, branch_name, treatment_interest FROM leads")) {
        return {
          rows: [{
            id: 9,
            temperature: "warm",
            temperature_locked: false,
            branch_name: null,
            treatment_interest: null,
          }],
        };
      }
      if (normalized.startsWith("UPDATE leads")) return { rows: [{ id: 9 }] };
      if (normalized.startsWith("INSERT INTO lead_activities")) return { rows: [{ id: 100 }] };
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

test("renovation conversion-ready persists project metadata without writing a customer property into branch_name", async () => {
  const profile = {
    ...getIndustryProfile("home_renovation"),
    services: [
      {
        name: "Kitchen Cabinets",
        description: "Custom kitchen cabinetry.",
        priceRange: "Quotation required",
        duration: "Depends on scope",
      },
    ],
  };

  await withProfile(profile, async () => {
    const { database, calls } = fakeDatabase();
    const alerts = [];
    const markReady = createBookingReadyOutcomeService({
      database,
      publish() {},
      sendBookingReadyAlert(input) {
        alerts.push(input);
        return { status: "sent" };
      },
    });

    const result = await markReady(42, 777, {
      details: {
        branch: "Cheras",
        treatment: "Kitchen Cabinets",
        appointmentPreference: "Saturday afternoon",
        projectLocation: "Cheras",
        projectSummary: "Condo kitchen cabinets; customer has floor plan and wants to renovate next month.",
        nextStep: "quotation_discussion",
      },
    });

    assert.deepEqual(result.details, {
      branch: null,
      treatment: "Kitchen Cabinets",
      appointmentPreference: "Saturday afternoon",
      projectLocation: "Cheras",
      projectSummary: "Condo kitchen cabinets; customer has floor plan and wants to renovate next month.",
      nextStep: "quotation_discussion",
    });

    const contactUpdate = calls.find(({ sql }) => sql.startsWith("UPDATE contacts"));
    assert.deepEqual(contactUpdate.params.slice(2), [
      null,
      "Kitchen Cabinets",
      "Saturday afternoon",
      "Cheras",
      "Condo kitchen cabinets; customer has floor plan and wants to renovate next month.",
      "quotation_discussion",
    ]);

    const leadUpdate = calls.find(({ sql }) => sql.startsWith("UPDATE leads"));
    assert.equal(leadUpdate.params[1], null);
    assert.equal(leadUpdate.params[2], "Kitchen Cabinets");

    const activity = calls.find(({ sql }) => sql.startsWith("INSERT INTO lead_activities"));
    assert.equal(activity.params[2].outcome, "booking_ready");
    assert.equal(activity.params[2].projectLocation, "Cheras");
    assert.equal(activity.params[2].projectSummary, "Condo kitchen cabinets; customer has floor plan and wants to renovate next month.");
    assert.equal(activity.params[2].nextStep, "quotation_discussion");
    assert.match(activity.params[1], /renovation enquiry ready for staff follow-up/i);

    assert.equal(alerts.length, 1);
    assert.match(alerts[0].reason, /renovation quotation or site visit/i);
    assert.equal(alerts[0].details.projectLocation, "Cheras");
    assert.equal(alerts[0].details.nextStep, "quotation_discussion");
  });
});
