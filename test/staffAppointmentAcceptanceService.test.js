const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGREED_TIME_REASON,
  isBriefAcceptance,
  hasSpecificStaffTimeOffer,
  isExplicitRescheduleOffer,
  conflictsWithConfirmedSlot,
  createStaffAppointmentAcceptanceService,
} = require("../src/services/staffAppointmentAcceptanceService");

function mockAcceptance({
  offerText = "Hi 你好，星期六，4点的时间你方便吗？",
  bookingStatus = "none",
  existing = false,
  staffAuthored = true,
  appointmentAt = "2026-10-17T08:00:00.000Z",
} = {}) {
  const queries = [];
  const events = [];
  const database = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql: String(sql), params });
          if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql)) return { rows: [] };
          if (/SELECT id FROM contacts WHERE/.test(sql)) return { rows: [{ id: 372 }] };
          if (/SELECT staff\.id AS staff_message_id/.test(sql)) {
            return { rows: staffAuthored ? [{
              staff_message_id: 1475, staff_text: offerText,
              lead_id: 116, appointment_status: bookingStatus, old_stage_id: 3,
              appointment_at: appointmentAt,
            }] : [] };
          }
          if (/INSERT INTO lead_activities/.test(sql)) return { rows: existing ? [] : [{ id: 999 }] };
          if (/UPDATE leads SET appointment_status = 'reschedule'/.test(sql)) return { rows: [{ stage_id: 2 }] };
          if (/INSERT INTO lead_stage_history/.test(sql)) return { rows: [] };
          if (/UPDATE contacts SET needs_attention/.test(sql)) return { rows: [{ id: 372 }] };
          throw new Error("Unexpected SQL: " + sql);
        },
        release() {},
      };
    },
  };
  return {
    queries, events,
    service: createStaffAppointmentAcceptanceService({
      database,
      publish(type, payload) { events.push({ type, payload }); },
    }),
  };
}

test("accepts short Chinese/Malaysian acknowledgements, not refusals or price questions", () => {
  for (const text of ["Ok", "好的 😊", "可以", "boleh", "yes"]) {
    assert.equal(isBriefAcceptance(text), true, text);
  }
  for (const text of ["Not ok", "不可以", "Ok, how much?", "可以改成星期日吗？", "yes but not Saturday"]) {
    assert.equal(isBriefAcceptance(text), false, text);
  }
});

test("only a specific staff date and time qualifies as an offered slot", () => {
  assert.equal(hasSpecificStaffTimeOffer("星期六，4点的时间你方便吗？"), true);
  assert.equal(hasSpecificStaffTimeOffer("17/10 3.30pm 可以吗?"), true);
  assert.equal(hasSpecificStaffTimeOffer("Saturday at 4pm works?"), true);
  assert.equal(hasSpecificStaffTimeOffer("有空吗?"), false);
  assert.equal(hasSpecificStaffTimeOffer("优惠到星期六"), false);
  assert.equal(isExplicitRescheduleOffer("帮你改到星期六 4点可以吗"), true);
  assert.equal(isExplicitRescheduleOffer("星期六4点可以吗"), false);
});

test("Zanne: staff offered Saturday 4pm and customer Ok records pending agreement only", async () => {
  const { service, queries, events } = mockAcceptance();
  const result = await service(372, 1476, "Ok");
  assert.equal(result.leadId, 116);
  assert.match(result.agreedTimeText, /4点/);
  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.equal(JSON.parse(activity.params[1]).inboundMessageId, 1476);
  assert.equal(JSON.parse(activity.params[1]).staffMessageId, 1475);
  assert.equal(JSON.parse(activity.params[1]).outcome, "staff_time_accepted");
  const attention = queries.find(({ sql }) => /UPDATE contacts SET needs_attention/.test(sql));
  assert.equal(attention.params[1], AGREED_TIME_REASON);
  assert.match(attention.sql, /Booking ready:%/);
  assert.match(attention.sql, /ai_review_items/);
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
  assert.equal(events.some(({ type }) => type === "conversation_changed"), true);
});

test("an inbound retry does not record duplicate agreements or update attention", async () => {
  const { service, queries, events } = mockAcceptance({ existing: true });
  assert.equal(await service(372, 1476, "Ok"), null);
  assert.equal(queries.some(({ sql }) => /UPDATE contacts SET/.test(sql)), false);
  assert.deepEqual(events, []);
});

test("non-staff or unspecific offers cannot become accepted booking evidence", async () => {
  const missingStaff = mockAcceptance({ staffAuthored: false });
  assert.equal(await missingStaff.service(372, 1476, "Ok"), null);
  const noTime = mockAcceptance({ offerText: "星期六方便吗？" });
  assert.equal(await noTime.service(372, 1476, "Ok"), null);
  const refusal = mockAcceptance();
  assert.equal(await refusal.service(372, 1476, "No"), null);
  assert.equal(refusal.queries.length, 0);
});

test("new proposed time replaces a different confirmed slot, even without a change keyword", async () => {
  assert.equal(
    conflictsWithConfirmedSlot("星期六，4点的时间你方便吗？", "2026-10-17T07:30:00.000Z"),
    true
  );
  assert.equal(
    conflictsWithConfirmedSlot("星期六，4点的时间你方便吗？", "2026-10-17T08:00:00.000Z"),
    false
  );
  assert.equal(
    conflictsWithConfirmedSlot("17/10 3.30pm 可以吗?", "2026-10-17T08:00:00.000Z"),
    true
  );
  const { service, queries } = mockAcceptance({
    bookingStatus: "set",
    appointmentAt: "2026-10-17T07:30:00.000Z",
  });
  await service(372, 1476, "Ok");
  assert.ok(queries.some(({ sql }) => /UPDATE leads SET appointment_status = 'reschedule'/.test(sql)));
});

test("a clearly changed staff slot accepted by a booked customer becomes pending reschedule", async () => {
  const { service, queries } = mockAcceptance({
    offerText: "帮你改到星期六，4点的时间你方便吗？",
    bookingStatus: "set",
  });
  const result = await service(372, 1476, "可以");
  assert.ok(result);
  const update = queries.find(({ sql }) => /UPDATE leads SET appointment_status = 'reschedule'/.test(sql));
  assert.ok(update);
  assert.match(update.sql, /appointment_at = NULL/);
  assert.match(update.sql, /system_key = 'contacted'/);
  const history = queries.find(({ sql }) => /INSERT INTO lead_stage_history/.test(sql));
  assert.deepEqual(history.params, [116, 3, 2, "Automation"]);
  assert.equal(queries.some(({ sql }) => /UPDATE contacts SET needs_attention/.test(sql)), true);
});

test("a routine staff confirmation of an already booked slot does not cancel it", async () => {
  const { service, queries } = mockAcceptance({ bookingStatus: "set" });
  await service(372, 1476, "Ok");
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
  assert.equal(queries.some(({ sql }) => /UPDATE contacts SET needs_attention/.test(sql)), false);
});
