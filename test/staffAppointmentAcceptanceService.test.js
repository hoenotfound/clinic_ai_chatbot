const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AGREED_TIME_REASON,
  isBriefAcceptance,
  isDirectBookingIntent,
  hasSpecificStaffTimeOffer,
  isExplicitRescheduleOffer,
  conflictsWithConfirmedSlot,
  sameSpecificOfferedSlot,
  createStaffAppointmentAcceptanceService,
} = require("../src/services/staffAppointmentAcceptanceService");

function harness({
  offerText = "Hi 你好，星期六，4点的时间你方便吗？",
  bookingStatus = "none",
  existing = false,
  staffAuthored = true,
  relayedOfferText = null,
  appointmentAt = "2026-10-17T08:00:00.000Z",
  attentionUpdated = true,
  telegramStatus = "queued",
} = {}) {
  const queries = [], events = [], alerts = [], pushes = [], wakes = [];
  const database = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql: String(sql), params });
          if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql)) return { rows: [] };
          if (/SELECT id FROM contacts WHERE/.test(sql)) return { rows: [{ id: 372 }] };
          if (sql.includes("relay.content AS relay_text")) {
            return { rows: relayedOfferText ? [{
              staff_message_id: 1474, staff_text: offerText,
              relay_message_id: 1475, relay_text: relayedOfferText,
              lead_id: 116, appointment_status: bookingStatus, old_stage_id: 3,
              appointment_at: appointmentAt,
            }] : [] };
          }
          if (/SELECT staff\.id AS staff_message_id/.test(sql)) {
            return { rows: staffAuthored ? [{
              staff_message_id: 1475, staff_text: offerText,
              lead_id: 116, appointment_status: bookingStatus, old_stage_id: 3,
              appointment_at: appointmentAt,
            }] : [] };
          }
          if (/INSERT INTO lead_activities/.test(sql)) return { rows: existing ? [] : [{ id: 999 }] };
          if (/UPDATE contacts SET needs_attention/.test(sql)) return { rows: attentionUpdated ? [{ id: 372 }] : [] };
          throw new Error("Unexpected SQL: " + sql);
        },
        release() {},
      };
    },
  };
  return {
    queries, events, alerts, pushes, wakes,
    service: createStaffAppointmentAcceptanceService({
      database,
      lockContactAlertQueue: async (id, query) => {
        queries.push({ sql: "TEST_ADVISORY_LOCK", params: [id] });
      },
      async sendBookingReadyAlert(input) {
        alerts.push(input);
        return { status: telegramStatus };
      },
      wakeAlertQueue(ms) { wakes.push(ms); },
      sendWebPush(input) { pushes.push(input); },
      publish(type, payload) { events.push({ type, payload }); },
    }),
  };
}

test("brief Malaysian acknowledgments exclude price questions and negations", () => {
  for (const text of ["Ok", "好的 😊", "可以", "boleh", "yes"]) assert.equal(isBriefAcceptance(text), true, text);
  for (const text of ["Not ok", "不可以", "Ok, how much?", "可以改成星期日吗？", "yes but not Saturday"]) {
    assert.equal(isBriefAcceptance(text), false, text);
  }
});

test("only specific date, time, scheduling question qualifies", () => {
  assert.equal(hasSpecificStaffTimeOffer("星期六，4点的时间你方便吗？"), true);
  assert.equal(hasSpecificStaffTimeOffer("17/10 3.30pm 可以吗?"), true);
  assert.equal(hasSpecificStaffTimeOffer("Saturday at 4pm works?"), true);
  assert.equal(hasSpecificStaffTimeOffer("有空吗?"), false);
  assert.equal(hasSpecificStaffTimeOffer("优惠到星期六"), false);
  assert.equal(isExplicitRescheduleOffer("帮你改到星期六 4点可以吗"), true);
  assert.equal(isExplicitRescheduleOffer("星期六4点可以吗"), false);
});

test("Zanne: staff offered 4pm and customer Ok records a pending agreement and durable alert", async () => {
  const { service, queries, events, alerts, pushes, wakes } = harness();
  const result = await service(372, 1476, "Ok");
  assert.equal(result.leadId, 116);
  assert.match(result.agreedTimeText, /4点/);
  const select = queries.find(({ sql }) => /SELECT staff\.id AS/.test(sql));
  assert.match(select.sql, /staff\.id = \(SELECT MAX\(previous\.id\)/);
  assert.match(select.sql, /interval '24 hours'/);
  assert.match(select.sql, /later\.id > staff\.id AND later\.id < inbound\.id/);
  assert.match(select.sql, /staff\.sent_by_username IS NOT NULL/);
  const lockIndex = queries.findIndex(({ sql }) => sql === "TEST_ADVISORY_LOCK");
  const contactLockIndex = queries.findIndex(({ sql }) => /SELECT id FROM contacts WHERE/.test(sql));
  assert.ok(lockIndex < contactLockIndex);
  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  const meta = JSON.parse(activity.params[1]);
  assert.equal(meta.inboundMessageId, 1476);
  assert.equal(meta.staffMessageId, 1475);
  assert.equal(meta.outcome, "staff_time_accepted");
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].messageId, 1476);
  assert.equal(alerts[0].queueLockHeld, true);
  assert.equal(alerts[0].transactionClient != null, true);
  assert.equal(pushes.length, 1);
  assert.deepEqual(wakes, [0]);
  assert.ok(queries.some(({ sql }) => /UPDATE contacts SET/.test(sql)));
  assert.ok(events.some(({ type }) => type === "conversation_changed"));
});

test("confirmed original slot stays booked when staff offers and customer accepts a replacement", async () => {
  const { service, queries, alerts } = harness({
    bookingStatus: "set",
    appointmentAt: "2026-10-17T07:30:00.000Z",
  });
  assert.equal(conflictsWithConfirmedSlot("星期六，4点的时间你方便吗？", "2026-10-17T07:30:00.000Z"), true);
  const outcome = await service(372, 1476, "Ok");
  assert.ok(outcome);
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].reason, /clinic should finalize/i);
});

test("explicit alternative offered by staff also preserves the original confirmed booking", async () => {
  const { service, queries, alerts } = harness({
    offerText: "帮你改到星期六，4点的时间你方便吗？",
    bookingStatus: "set",
  });
  assert.ok(await service(372, 1476, "可以"));
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
  assert.equal(alerts.length, 1);
});

test("same confirmed time does not trigger an unnecessary booking alert", async () => {
  const { service, alerts, pushes, queries } = harness({ bookingStatus: "set" });
  await service(372, 1476, "Ok");
  assert.deepEqual(alerts, []);
  assert.deepEqual(pushes, []);
  assert.equal(queries.some(({ sql }) => /UPDATE leads SET/.test(sql)), false);
});

test("retries, missing staff and non-answers do not create duplicate events", async () => {
  const duplicate = harness({ existing: true });
  assert.equal(await duplicate.service(372, 1476, "Ok"), null);
  assert.deepEqual(duplicate.alerts, []);
  assert.equal(duplicate.queries.some(({ sql }) => /UPDATE contacts SET/.test(sql)), false);
  const missing = harness({ staffAuthored: false });
  assert.equal(await missing.service(372, 1476, "Ok"), null);
  const noTime = harness({ offerText: "星期六方便吗？" });
  assert.equal(await noTime.service(372, 1476, "Ok"), null);
  const refusal = harness();
  assert.equal(await refusal.service(372, 1476, "No"), null);
  assert.deepEqual(refusal.queries, []);
});

test("clinical attention remains protected and cannot be replaced by a booking alert", async () => {
  const { service, alerts, pushes, queries } = harness({ attentionUpdated: false });
  await service(372, 1476, "Ok");
  assert.deepEqual(alerts, []);
  assert.deepEqual(pushes, []);
  assert.ok(queries.some(({ sql }) => /ai_review_items/.test(sql)));
});

test("AI relay of the exact staff-offered date and time records a pending booking hold", async () => {
  const staffOffer = "10/11 星期2，10.30可以吗？";
  const relay = "另外，前面中医师有问你 10/11 星期二 10:30am 这个时间合适吗？如果 ok 我们就帮你留这个 slot";
  assert.equal(sameSpecificOfferedSlot(staffOffer, relay), true);
  const { service, alerts, queries } = harness({
    staffAuthored: false, offerText: staffOffer, relayedOfferText: relay,
  });
  const accepted = await service(372, 1476, "ok");
  assert.ok(accepted);
  assert.equal(accepted.leadId, 116);
  const metadata = JSON.parse(queries.find(q => /INSERT INTO lead_activities/.test(q.sql)).params[1]);
  assert.equal(metadata.outcome, "staff_time_accepted");
  assert.equal(metadata.staffMessageId, 1474);
  assert.equal(metadata.relayMessageId, 1475);
  assert.equal(alerts.length, 1);
  assert.equal(queries.some(q => q.sql.includes("UPDATE leads SET")), false);
  const check = queries.find(q => q.sql.includes("relay.content AS relay_text"));
  assert.match(check.sql, /staff\.sent_by_username IS NOT NULL/);
  assert.match(check.sql, /relay\.id=\(SELECT MAX\(previous\.id\)/);
});

test("AI-only suggestions, different slots and generic yes never record a staff acceptance", async () => {
  const staffOffer = "10/11 星期2，10.30可以吗？";
  const otherTime = "10/11 星期二 11:30am 这个时间合适吗？";
  const otherDate = "11/11 星期三 10:30am 这个时间合适吗？";
  assert.equal(sameSpecificOfferedSlot(staffOffer, otherTime), false);
  assert.equal(sameSpecificOfferedSlot(staffOffer, otherDate), false);
  assert.equal(sameSpecificOfferedSlot(staffOffer, "Would you like to know the price?"), false);
  for (const relayedOfferText of [otherTime, otherDate, "Would you like to know the price?"]) {
    const { service, alerts, queries } = harness({
      staffAuthored: false, offerText: staffOffer, relayedOfferText,
    });
    assert.equal(await service(372, 1476, "yes"), null);
    assert.equal(alerts.length, 0);
    assert.equal(queries.some(q => q.sql.includes("INSERT INTO lead_activities")), false);
  }
});

test("pending staff-slot acceptance appears in every primary and secondary follow-up gate", () => {
  const { pendingAcceptedAppointmentAllowedSql } =
    require("../src/utils/pendingAcceptedAppointmentFollowUp");
  const sql = pendingAcceptedAppointmentAllowedSql("c");
  assert.match(sql, /booking_acceptance\.metadata->>'outcome' IN/);
  assert.match(sql, /ORDER BY latest_booking_lead\.created_at DESC/);
  assert.match(sql, /appointment_status,'none'\) = 'reschedule'/);
  assert.throws(() => pendingAcceptedAppointmentAllowedSql("c;DROP TABLE"), /alias/);
  const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");
  assert.match(followUpAttentionAllowedSql("c"), /staff_time_accepted/);
  const secondary = require("../src/services/whatsappSecondaryFollowUpService");
  const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");
  const extended = require("../src/services/whatsappFreeEntryFollowUpService");
  for (const query of [secondary.CANDIDATES_SQL, secondary.RECHECK_SQL,
    marketing.CANDIDATES_SQL, marketing.RECHECK_SQL,
    extended.CANDIDATES_SQL, extended.POTENTIAL_DUE_SQL].filter(Boolean)) {
    assert.match(query, /staff_time_accepted/);
  }
});

test("direct booking requests exclude exploratory and pricing questions",()=>{
 for(const s of ["我想预约明天10点","请帮我预约","I want to book tomorrow","nak book appointment"])
   assert.equal(isDirectBookingIntent(s),true,s);
 for(const s of ["How to book?","多少钱？","I want to book if there is a discount","I want to cancel booking"])
   assert.equal(isDirectBookingIntent(s),false,s);
});
