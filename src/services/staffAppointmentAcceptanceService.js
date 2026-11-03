const { pool } = require("../db/db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("./telegramImmediateAlertService");
const telegramAlertRepo = require("../db/telegramImmediateAlertRepo");
const webPushNotifications = require("./webPushNotificationService");
const { markBookingReadyForContact } = require("./bookingReadyOutcomeService");

const AGREED_TIME_REASON =
  "Booking ready: customer accepted a staff-offered time; clinic should finalize the appointment.";

function isBriefAcceptance(value) {
  const text = String(value || "").trim().replace(/[.!！。～~😊🙏👍\s]+$/gu, "").trim();
  if (!text || text.length > 45) return false;
  return /^(?:ok(?:ay)?|yes|sure|can|confirmed?|alright|fine|好的?|可以(?:的)?|没问题|沒問題|行|嗯|好呀|可以呀|是的|boleh|baik|ya|setuju)$/iu.test(text);
}

function isDirectBookingIntent(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 220) return false;
  if (/(?:how\s+to\s+book|how\s+much|price|cost|discount|if\s+i\s+book|cancel|not\s+booking|多少钱|价格|价钱|优惠|如何预约|怎样预约|不想预约|取消|berapa\s+harga)/iu.test(text)) return false;
  return /(?:我想(?:要)?(?:预约|預約)|我要(?:预约|預約)|帮我(?:预约|預約)|幫我(?:预约|預約)|请帮我(?:预约|預約)|請幫我(?:預約|预约)|(?:i\s+(?:want|would\s+like|need)\s+to\s+book|please\s+book\s+me|book\s+me\s+(?:in|for))\b|(?:saya\s+nak|nak)\s+(?:book|temujanji|appointment))/iu.test(text);
}

function hasSpecificStaffTimeOffer(value) {
  const text = String(value || "");
  const date = /(?:\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|星期[一二三四五六日天]|周[一二三四五六日天]|週[一二三四五六日天]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b)/iu;
  const time = /(?:\b(?:[01]?\d|2[0-3])[:：.][0-5]\d\s*(?:a\.?m\.?|p\.?m\.?)?\b|\b(?:1[0-2]|0?[1-9])\s*(?:a\.?m\.?|p\.?m\.?)\b|(?:[一二三四五六七八九十]|\d{1,2})\s*[点點](?:半|[0-5]?\d\s*分)?)/iu;
  const isSchedulingOffer = /(?:方便吗|方便嗎|可以吗|可以嗎|合适吗|合適嗎|这个时间|這個時間|预约|預約|安排|时间你|時間你|works?\??|availab|time\s*slot|appointment|booking|temujanji|boleh\s*(?:tak|ke)|sesuai\s*(?:tak|ke))/iu;
  return date.test(text) && time.test(text) && isSchedulingOffer.test(text);
}

function isExplicitRescheduleOffer(value) {
  return /(?:改(?:到|成|去|为|為|时间|時間)|换(?:去|到|成|时间|時間)|調整|调整|改期|改约|改約|reschedul|change\s+(?:the\s+)?(?:date|time|slot)|another\s+(?:date|time|slot)|tukar\s+(?:masa|tarikh)|ubah\s+(?:masa|tarikh))/iu.test(String(value || ""));
}


function conflictsWithConfirmedSlot(offerText, appointmentAt) {
  if (!appointmentAt) return false;
  const saved = new Date(appointmentAt);
  if (!Number.isFinite(saved.getTime())) return false;
  const local = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kuala_Lumpur", weekday: "long",
      day: "2-digit", month: "2-digit", hour: "2-digit",
      minute: "2-digit", hour12: false,
    }).formatToParts(saved).map((part) => [part.type, part.value])
  );
  const offer = String(offerText || "").toLowerCase();
  const calendar = offer.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-]\d{2,4})?\b/);
  if (calendar && (Number(calendar[1]) !== Number(local.day) ||
      Number(calendar[2]) !== Number(local.month))) return true;
  const weekdays = [
    /(?:星期日|星期天|周日|周天|週日|週天|sunday|ahad)/iu,
    /(?:星期一|周一|週一|monday|isnin)/iu,
    /(?:星期二|周二|週二|tuesday|selasa)/iu,
    /(?:星期三|周三|週三|wednesday|rabu)/iu,
    /(?:星期四|周四|週四|thursday|khamis)/iu,
    /(?:星期五|周五|週五|friday|jumaat)/iu,
    /(?:星期六|周六|週六|saturday|sabtu)/iu,
  ];
  const namedDay = weekdays.findIndex((expression) => expression.test(offer));
  const savedDay = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    .indexOf(String(local.weekday || "").toLowerCase());
  if (namedDay >= 0 && savedDay >= 0 && namedDay !== savedDay) return true;

  const numbered = offer.match(/\b(\d{1,2})[:：.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/iu);
  const chinese = numbered ? null : offer.match(/(\d{1,2})\s*[点點]\s*(半|\d{1,2}\s*分)?/iu);
  const meridian = numbered || chinese ? null : offer.match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/iu);
  const parsed = numbered || chinese || meridian;
  if (!parsed) return false;
  let hour = Number(parsed[1]);
  let minute = numbered ? Number(numbered[2])
    : chinese && chinese[2] ? (chinese[2] === "半" ? 30 : Number(chinese[2].replace(/\s*分/, ""))) : 0;
  if (!Number.isInteger(hour) || hour > 23 || hour < 0 || minute > 59) return false;
  const ampm = numbered ? String(numbered[3] || "")
    : meridian ? String(meridian[2] || "") : "";
  if (/p\.?m/i.test(ampm) || /下午|傍晚|晚上|晚间|晚間/u.test(offer)) {
    if (hour < 12) hour += 12;
  } else if (/a\.?m/i.test(ampm) || /早上|上午/u.test(offer)) {
    if (hour === 12) hour = 0;
  } else if (hour > 0 && hour <= 7) {
    // Ordinary Malaysian clinic opening hours make "4点" mean 4 PM.
    hour += 12;
  } else if (hour === 8 || hour === 9) {
    // Could be morning or evening. Never reschedule on an ambiguous time.
    return false;
  }
  return hour !== Number(local.hour) || minute !== Number(local.minute);
}


/**
 * An AI may repeat a genuine staff-offered slot. Only treat the customer's
 * immediately following brief acceptance as a pending agreement when BOTH
 * proposals name the same concrete date/day and clock time.
 * AI-only offers must never create a booking or a staff acceptance event.
 */
function sameSpecificOfferedSlot(staffText, relayText) {
  if (!hasSpecificStaffTimeOffer(staffText) || !hasSpecificStaffTimeOffer(relayText)) return false;
  function slot(text) {
    const date = String(text).match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/u);
    const weekday = String(text).match(/星期[一二三四五六日天1-7]|(?:周|週)[一二三四五六日天1-7]|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b/iu);
    const numbered = String(text).match(/\b(\d{1,2})[:：.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/iu);
    const chinese = numbered ? null : String(text).match(/(\d{1,2})\s*[点點]\s*(半|\d{1,2}\s*分)?/u);
    const clockAmPm = numbered || chinese ? null : String(text).match(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/iu);
    if (!numbered && !chinese && !clockAmPm) return null;
    const hour = Number(numbered ? numbered[1] : chinese ? chinese[1] : clockAmPm[1]);
    const minute = numbered ? Number(numbered[2]) : chinese?.[2]
      ? chinese[2] === "半" ? 30 : Number(chinese[2].replace(/\s*分/u, "")) : 0;
    if (hour > 23 || minute > 59) return null;
    const suffix = numbered?.[3] || clockAmPm?.[2] || "";
    const daypart = suffix ? /p/i.test(suffix) ? "pm" : "am"
      : /下午|傍晚|晚上/u.test(text) ? "pm"
        : /早上|上午/u.test(text) ? "am" : "";
    return {
      date: date ? [Number(date[1]), Number(date[2]), date[3] || ""].join("/") : "",
      weekday: weekday ? weekday[0].toLowerCase() : "",
      hour: daypart ? (hour % 12) + (daypart === 'pm' ? 12 : 0) : hour,
      minute, daypart,
    };
  }
  const offered = slot(staffText), relayed = slot(relayText);
  if (!offered || !relayed) return false;
  if (offered.date || relayed.date) {
    if (!offered.date || !relayed.date) return false;
    const aParts = offered.date.split("/"), bParts = relayed.date.split("/");
    if (aParts[0] !== bParts[0] || aParts[1] !== bParts[1] ||
        (aParts[2] && bParts[2] && aParts[2] !== bParts[2])) return false;
  } else if (!offered.weekday || !relayed.weekday ||
      offered.weekday !== relayed.weekday) return false;
  return offered.hour % 12 === relayed.hour % 12 && offered.minute === relayed.minute &&
    (!offered.daypart || !relayed.daypart || offered.daypart === relayed.daypart);
}

function createStaffAppointmentAcceptanceService({
  database = pool,
  publish = realtimeEvents.publish,
  lockContactAlertQueue = telegramAlertRepo.lockContactAlertQueue,
  sendBookingReadyAlert = telegramImmediateAlerts.sendBookingReadyAlert,
  wakeAlertQueue = telegramImmediateAlerts.wakeImmediateAlertQueue,
  sendWebPush = webPushNotifications.sendContactAlertBestEffort,
} = {}) {
  return async function recordStaffAppointmentAcceptance(contactId, inboundMessageId, customerText) {
    if (!Number.isSafeInteger(Number(contactId)) || !Number.isSafeInteger(Number(inboundMessageId))) return null;
    if (!isBriefAcceptance(customerText)) {
      if (isDirectBookingIntent(customerText)) {
        await markBookingReadyForContact(contactId,inboundMessageId,{
          reason:"Booking ready: customer explicitly requested an appointment; staff should confirm availability.",
          activityDescription:"Customer explicitly requested booking. Staff must verify an available date and time.",
          details:{appointmentPreference:String(customerText).trim().slice(0,200)},
        });
      }
      return null;
    }
    const client = await database.connect();
    let outcome = null;
    let alertQueued = false;
    let staffAlertUpdated = false;
    try {
      await client.query("BEGIN");
      // Same lock order as Booking Ready/Telegram workers: advisory alert lock
      // first, then the contact. No provider network calls while locked.
      await lockContactAlertQueue(contactId, client.query.bind(client));
      await client.query("SELECT id FROM contacts WHERE id = $1 FOR UPDATE", [contactId]);
      const selected = await client.query(
        [
          "SELECT staff.id AS staff_message_id, staff.content AS staff_text,",
          "       lead.id AS lead_id, lead.appointment_status, lead.stage_id AS old_stage_id, lead.appointment_at",
          "FROM messages inbound",
          "JOIN LATERAL (",
          "  SELECT m.id, m.content, m.sent_by_username, m.created_at",
          "  FROM messages m",
          "  WHERE m.contact_id = inbound.contact_id AND m.id < inbound.id",
          "    AND m.role = 'assistant' AND m.is_automated_follow_up = false",
          "    AND m.created_at >= inbound.created_at - interval '24 hours'",
          "    AND COALESCE(m.delivery_status, 'pending') IN ('pending','sent','delivered','read')",
          "    AND m.whatsapp_message_id IS NOT NULL",
          "  ORDER BY m.id DESC LIMIT 1",
          ") staff ON true",
          "JOIN LATERAL (",
          "  SELECT l.id, l.appointment_status, l.stage_id, l.appointment_at FROM leads l",
          "  WHERE l.contact_id = inbound.contact_id AND l.is_closed = false",
          "  ORDER BY l.created_at DESC, l.id DESC LIMIT 1",
          ") lead ON true",
          "WHERE inbound.id = $2 AND inbound.contact_id = $1 AND inbound.role = 'user'",
          "  AND staff.sent_by_username IS NOT NULL",
          "  AND staff.id = (SELECT MAX(previous.id) FROM messages previous",
          "    WHERE previous.contact_id = inbound.contact_id AND previous.id < inbound.id)",
          "  AND inbound.created_at >= staff.created_at",
          "  AND inbound.created_at <= staff.created_at + interval '24 hours'",
          "  AND NOT EXISTS (SELECT 1 FROM messages later",
          "    WHERE later.contact_id = inbound.contact_id",
          "      AND later.id > staff.id AND later.id < inbound.id)",
          "LIMIT 1",
        ].join("\n"),
        [contactId, inboundMessageId]
      );
      let offer = selected.rows[0];
      if (!offer) {
        // The immediately preceding message may be an AI relay of an actual
        // staff offer. Require a same-slot staff message within 24 hours.
        // Matching the date AND time avoids taking "ok" to an unrelated AI
        // suggestion as permission to record a booking.
        const relayed = await client.query(
          [
            "SELECT staff.id AS staff_message_id, staff.content AS staff_text,",
            "  lead.id AS lead_id, lead.appointment_status, lead.stage_id AS old_stage_id,",
            "  lead.appointment_at, relay.id AS relay_message_id,",
            "  relay.content AS relay_text",
            "FROM messages inbound",
            "JOIN LATERAL (",
            "  SELECT m.id, m.content, m.created_at FROM messages m",
            "  WHERE m.contact_id=inbound.contact_id AND m.id < inbound.id",
            "    AND m.role='assistant' AND m.sent_by_username IS NULL",
            "    AND m.is_automated_follow_up=false AND m.whatsapp_message_id IS NOT NULL",
            "    AND COALESCE(m.delivery_status,'pending') IN ('pending','sent','delivered','read')",
            "  ORDER BY m.id DESC LIMIT 1",
            ") relay ON true",
            "JOIN LATERAL (",
            "  SELECT l.id, l.appointment_status, l.stage_id, l.appointment_at",
            "  FROM leads l WHERE l.contact_id=inbound.contact_id AND l.is_closed=false",
            "  ORDER BY l.created_at DESC, l.id DESC LIMIT 1",
            ") lead ON true",
            "JOIN messages staff ON staff.contact_id=inbound.contact_id",
            "  AND staff.role='assistant' AND staff.sent_by_username IS NOT NULL",
            "  AND staff.is_automated_follow_up=false AND staff.whatsapp_message_id IS NOT NULL",
            "  AND COALESCE(staff.delivery_status,'pending') IN ('pending','sent','delivered','read')",
            "WHERE inbound.id=$2 AND inbound.contact_id=$1 AND inbound.role='user'",
            "  AND relay.id=(SELECT MAX(previous.id) FROM messages previous",
            "    WHERE previous.contact_id=inbound.contact_id AND previous.id<inbound.id)",
            "  AND relay.created_at >= inbound.created_at - interval '24 hours'",
            "  AND staff.id<relay.id AND staff.created_at >= inbound.created_at - interval '24 hours'",
            "ORDER BY staff.id DESC LIMIT 25",
          ].join("\n"),
          [contactId, inboundMessageId]
        );
        offer = relayed.rows.find(row =>
          sameSpecificOfferedSlot(row.staff_text, row.relay_text));
      }
      if (!offer || !hasSpecificStaffTimeOffer(offer.staff_text)) {
        await client.query("COMMIT");
        return null;
      }
      const metadata = {
        outcome: "staff_time_accepted",
        source: "authenticated_staff_offer",
        inboundMessageId: Number(inboundMessageId),
        staffMessageId: Number(offer.staff_message_id),
        ...(offer.relay_message_id ? { relayMessageId: Number(offer.relay_message_id) } : {}),
        agreedTimeText: String(offer.staff_text).trim().slice(0, 400),
      };
      const inserted = await client.query(
        [
          "INSERT INTO lead_activities (lead_id, activity_type, description, actor, metadata)",
          "SELECT $1, 'updated', 'Customer accepted a staff-offered time; availability needs confirmation.', 'Automation', $2::jsonb",
          "WHERE NOT EXISTS (",
          "  SELECT 1 FROM lead_activities a",
          "  WHERE a.lead_id = $1 AND a.metadata->>'outcome' = 'staff_time_accepted'",
          "    AND a.metadata->>'inboundMessageId' = $3::text",
          ") RETURNING id",
        ].join("\n"),
        [offer.lead_id, JSON.stringify(metadata), inboundMessageId]
      );
      if (inserted.rows.length) {
        // An acceptance is evidence of a pending alternative, never permission
        // to overwrite a booked slot. Staff must confirm the replacement.
        const changedConfirmedSlot = offer.appointment_status === "set" &&
          (isExplicitRescheduleOffer(offer.staff_text) ||
            conflictsWithConfirmedSlot(offer.staff_text, offer.appointment_at));
        if (offer.appointment_status !== "set" || changedConfirmedSlot) {
          const attentionUpdate = await client.query(
            [
              "UPDATE contacts SET needs_attention = true, attention_reason = $2, updated_at = now()",
              "WHERE id = $1 AND mode = 'ai'",
              "  AND (needs_attention = false OR attention_reason LIKE 'Booking ready:%')",
              "  AND NOT EXISTS (SELECT 1 FROM ai_review_items r WHERE r.contact_id = contacts.id",
              "    AND r.status = 'pending' AND r.category <> 'information')",
              "RETURNING id",
            ].join("\n"),
            [contactId, AGREED_TIME_REASON]
          );
          staffAlertUpdated = Boolean(attentionUpdate.rows[0]);
          if (staffAlertUpdated) {
            const queued = await sendBookingReadyAlert({
              contactId, messageId: Number(inboundMessageId),
              reason: AGREED_TIME_REASON,
              details: { appointmentPreference: metadata.agreedTimeText },
              transactionClient: client, queueLockHeld: true,
            });
            alertQueued = queued?.status === "queued";
          }
        }
        outcome = { leadId: offer.lead_id, agreedTimeText: metadata.agreedTimeText };
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    if (alertQueued) wakeAlertQueue(0);
    if (staffAlertUpdated) sendWebPush({ contactId, type: "booking_ready" });
    if (outcome) {
      publish("pipeline_changed", { leadId: outcome.leadId });
      publish("conversation_changed", { contactId, reason: "staff_time_accepted" });
    }
    return outcome;
  };
}
const recordStaffAppointmentAcceptance = createStaffAppointmentAcceptanceService();
module.exports = {
  AGREED_TIME_REASON, isBriefAcceptance, isDirectBookingIntent, hasSpecificStaffTimeOffer,
  isExplicitRescheduleOffer, conflictsWithConfirmedSlot, sameSpecificOfferedSlot,
  createStaffAppointmentAcceptanceService,
  recordStaffAppointmentAcceptance,
};
