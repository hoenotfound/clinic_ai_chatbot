const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanSummary,
  getContactInsights,
} = require("../src/db/contactInsightsRepo");

test("contact insights select the current journey and latest completed AI summary", async () => {
  let captured = null;
  const result = await getContactInsights(12, async (sql, params) => {
    captured = { sql, params };
    return {
      rows: [{
        contact_id: 12,
        whatsapp_number: "60123456789",
        name: "Kit",
        whatsapp_profile_name: "Kit Leong",
        channel: "whatsapp",
        photo_url: null,
        mode: "ai",
        takeover_by: null,
        takeover_at: null,
        needs_attention: false,
        attention_reason: null,
        is_unread: false,
        needs_follow_up: true,
        contact_created_at: "2026-08-01T00:00:00.000Z",
        lead_id: 8,
        stage_id: 2,
        stage_name: "Contacted",
        current_temperature: "hot",
        temperature_source: "ai",
        temperature_locked: false,
        branch_name: "Puchong",
        treatment_interest: "HIFU",
        appointment_at: null,
        appointment_status: "none",
        next_follow_up_at: null,
        is_closed: false,
        lead_created_at: "2026-08-29T01:00:00.000Z",
        score_id: 99,
        scored_temperature: "hot",
        confidence: "high",
        reason: "Customer proposed an appointment time.",
        summary_data: {
          treatmentInterest: "HIFU",
          preferredBranch: "Puchong",
          preferredAppointment: "Tomorrow at 12pm",
          mainConcern: "Face lifting",
          chatSummary: "Customer asked about HIFU and wants to visit tomorrow.",
          nextAction: "Confirm the 12pm appointment slot.",
        },
        provider: "gemini",
        model: "gemini-2.5-flash",
        score_through_message_id: 55,
        score_updated_at: "2026-08-29T02:00:00.000Z",
        latest_message_id: 56,
      }],
    };
  });

  assert.deepEqual(captured.params, [12]);
  assert.match(captured.sql, /lead_choice\.is_closed = false/);
  assert.match(captured.sql, /score_choice\.status = 'completed'/);
  assert.match(captured.sql, /telegram_summary_alerts/);
  assert.match(captured.sql, /NULLIF\(score\.summary_data, '\{\}'::jsonb\)/);
  assert.equal(result.contact.id, 12);
  assert.equal(result.lead.stageName, "Contacted");
  assert.equal(result.lead.temperature, "hot");
  assert.equal(result.aiInsights.summary.preferredAppointment, "Tomorrow at 12pm");
  assert.equal(result.aiInsights.isStale, true);
});

test("contact insights do not reuse an old closed journey when an open journey exists", async () => {
  let sqlText = "";
  const result = await getContactInsights(12, async (sql) => {
    sqlText = sql;
    return {
      rows: [{
        contact_id: 12,
        whatsapp_number: "60123456789",
        name: null,
        whatsapp_profile_name: "Patient",
        channel: "whatsapp",
        photo_url: null,
        mode: "ai",
        takeover_by: null,
        takeover_at: null,
        needs_attention: false,
        attention_reason: null,
        is_unread: false,
        needs_follow_up: false,
        contact_created_at: "2026-08-01T00:00:00.000Z",
        lead_id: 20,
        stage_id: 1,
        stage_name: "New Lead",
        current_temperature: "warm",
        temperature_source: "system",
        temperature_locked: false,
        branch_name: null,
        treatment_interest: null,
        appointment_at: null,
        appointment_status: "none",
        next_follow_up_at: null,
        is_closed: false,
        lead_created_at: "2026-08-29T04:00:00.000Z",
        score_id: null,
        latest_message_id: 80,
      }],
    };
  });

  assert.match(
    sqlText,
    /ORDER BY\s+\(lead_choice\.is_closed = false\) DESC,\s+lead_choice\.created_at DESC/
  );
  assert.equal(result.lead.id, 20);
  assert.equal(result.aiInsights, null);
});

test("summary fields are normalized and missing values stay empty", () => {
  assert.deepEqual(cleanSummary({
    treatmentInterest: "  HIFU ",
    preferredBranch: null,
    nextAction: 123,
  }), {
    treatmentInterest: "HIFU",
    preferredBranch: "",
    preferredAppointment: "",
    mainConcern: "",
    chatSummary: "",
    nextAction: "",
  });
});

test("missing contact returns null", async () => {
  const result = await getContactInsights(999, async () => ({ rows: [] }));
  assert.equal(result, null);
});
