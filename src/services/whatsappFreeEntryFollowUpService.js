const { pool } = require("../db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../db/conversationLock");
const clinicConfig = require("../config/clinicConfig");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
const whatsappTemplates = require("./whatsappTemplateService");
const messagesRepo = require("../db/messagesRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { quietHoursStatus } = require("../utils/quietHours");
const {
  freeEntryEnabled,
  eligibleFreeEntryTime,
} = require("../utils/whatsappFreeEntryWindow");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BATCH_SIZE = 20;
let running = false;
let timer = null;

// A fresh Meta pricing callback on the first real business response is required.
// Ad attribution alone is not sufficient billing proof. Do not backfill leads:
// clinicConfig.automatedFollowUp.freeEntry.activatedAt is the cutover boundary.
const candidateSql = `
  SELECT c.id AS contact_id, c.whatsapp_number, c.mode,
         origin.created_at AS first_inbound_at,
         first_reply.id AS first_reply_message_id,
         first_reply.created_at AS first_reply_at,
         last_inbound.created_at AS last_inbound_at,
         evidence.pricing_type AS evidence_type,
         lead.treatment_interest,
         (SELECT array_agg(text_content ORDER BY msg_time DESC) FROM (
           SELECT m.content AS text_content, m.created_at AS msg_time
           FROM messages m WHERE m.contact_id = c.id AND m.role = 'user'
           ORDER BY m.created_at DESC, m.id DESC LIMIT 8
         ) recent) AS recent_inbound_messages,
         (SELECT COALESCE(array_agg(slot_hours), '{}') FROM whatsapp_free_entry_followup_attempts existing
          WHERE existing.first_reply_message_id = first_reply.id) AS claimed_slots,
         true AS source_is_ctwa
  FROM contacts c
  JOIN LATERAL (
    SELECT l.id, l.is_closed, l.appointment_status, l.marketing_consent, l.treatment_interest,
           s.stage_type, s.system_key
    FROM leads l
    LEFT JOIN pipeline_stages s ON s.id = l.stage_id
    WHERE l.contact_id = c.id
    ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC
    LIMIT 1
  ) lead ON true
  JOIN lead_attributions attribution ON attribution.lead_id = lead.id
  JOIN messages origin ON origin.id = attribution.first_message_id
       AND origin.contact_id = c.id AND origin.role = 'user'
  JOIN LATERAL (
    SELECT reply.id, reply.created_at, reply.whatsapp_message_id
    FROM messages reply
    WHERE reply.contact_id = c.id AND reply.role = 'assistant'
      AND reply.whatsapp_message_id IS NOT NULL
      AND reply.created_at >= origin.created_at
      AND reply.created_at < origin.created_at + interval '24 hours'
    ORDER BY reply.created_at ASC, reply.id ASC
    LIMIT 1
  ) first_reply ON true
  JOIN whatsapp_free_entry_pricing_evidence evidence
       ON evidence.wamid = first_reply.whatsapp_message_id
  JOIN LATERAL (
    SELECT inbound.created_at
    FROM messages inbound
    WHERE inbound.contact_id = c.id AND inbound.role = 'user'
    ORDER BY inbound.created_at DESC, inbound.id DESC LIMIT 1
  ) last_inbound ON true
  WHERE c.channel = 'whatsapp'
    AND c.whatsapp_number IS NOT NULL
    AND COALESCE(c.mode, 'ai') <> 'human'
    AND c.needs_attention = false
    AND c.whatsapp_opt_in_at IS NOT NULL
    AND NULLIF(BTRIM(c.whatsapp_opt_in_source), '') IS NOT NULL
    AND c.whatsapp_opt_out_at IS NULL
    AND c.whatsapp_marketing_opt_out_at IS NULL
    AND lead.marketing_consent = 'opted_in'
    AND lead.is_closed = false
    AND COALESCE(lead.stage_type, 'open') = 'open'
    AND COALESCE(lead.system_key, '') NOT IN ('appointment_set','visited')
    AND COALESCE(lead.appointment_status, 'none') NOT IN ('set','visited')
    AND attribution.channel = 'whatsapp'
    AND LOWER(COALESCE(attribution.meta_source_type, '')) = 'ad'
    AND (attribution.ctwa_clid IS NOT NULL OR attribution.meta_ad_id IS NOT NULL)
    AND evidence.pricing_type = 'free_entry_point'
    AND evidence.billable = false
    AND evidence.delivery_status IN ('sent','delivered','read')
    -- Do not advance after a rejected, unconfirmed or unreconciled send.
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_free_entry_followup_attempts prior
      LEFT JOIN whatsapp_free_entry_pricing_evidence prior_billing
        ON prior_billing.wamid = prior.wamid
      WHERE prior.first_reply_message_id = first_reply.id
        AND (
          prior.status IN ('sending', 'failed', 'unknown')
          OR (
            prior.status = 'accepted'
            AND (
              prior_billing.wamid IS NULL
              OR prior_billing.pricing_type <> 'free_entry_point'
              OR prior_billing.billable IS DISTINCT FROM false
              OR prior_billing.delivery_status = 'failed'
            )
          )
        )
    )
    AND first_reply.created_at >= $1::timestamptz
    AND first_reply.created_at > now() - interval '7 days'
    -- Later customer replies are allowed; restart silence only after
    -- a genuine business response to the latest inbound WhatsApp message.
    AND EXISTS (
      SELECT 1 FROM messages responded
      WHERE responded.contact_id = c.id AND responded.role = 'assistant'
        AND responded.whatsapp_message_id IS NOT NULL
        AND responded.created_at > last_inbound.created_at
        AND responded.delivery_status IS DISTINCT FROM 'failed'
    )
    -- Coordinate with Follow-up 3, pricing graphics and manual staff sends.
    AND NOT EXISTS (
      SELECT 1 FROM messages recent_send
      WHERE recent_send.contact_id = c.id
        AND recent_send.role = 'assistant'
        AND recent_send.created_at > now() - interval '5 hours'
        AND recent_send.delivery_status IS DISTINCT FROM 'cancelled'
    )
    -- Staff interventions take precedence over automated marketing.
    AND NOT EXISTS (
      SELECT 1 FROM messages staff_reply
      WHERE staff_reply.contact_id = c.id
        AND staff_reply.role = 'assistant'
        AND staff_reply.sent_by_username IS NOT NULL
        AND staff_reply.sent_by_username <> 'Automation'
        AND (staff_reply.created_at, staff_reply.id) >
          (first_reply.created_at, first_reply.id)
    )
    AND ($2::integer IS NULL OR c.id = $2::integer)
    -- Only take due, unclaimed slots. Completed/old contacts cannot fill the
    -- page and starve more recent leads when ad volume rises.
    AND ($2::integer IS NOT NULL OR EXISTS (
      SELECT 1
      FROM unnest($4::integer[]) AS slot(hours)
      WHERE NOT EXISTS (
        SELECT 1 FROM whatsapp_free_entry_followup_attempts prior
        WHERE prior.first_reply_message_id = first_reply.id
          AND prior.slot_hours = slot.hours
      )
      AND now() >= first_reply.created_at + slot.hours * interval '1 hour'
      AND now() < first_reply.created_at + (slot.hours + 12) * interval '1 hour'
      AND now() >= last_inbound.created_at + interval '24 hours'
    ))
  ORDER BY first_reply.created_at ASC, c.id ASC
  LIMIT $3::integer
`;

function settings(env = process.env) {
  if (!freeEntryEnabled(env) || !automatedRepliesEnabled(env)) return null;
  const cfg = clinicConfig.automatedFollowUp;
  if (cfg?.enabled !== true || cfg?.freeEntry?.enabled !== true) return null;
  const activatedAt = cfg.freeEntry.activatedAt;
  const activatedTime = new Date(activatedAt).getTime();
  const templateName = String(cfg.freeEntry.templateName || "").trim();
  const language = String(cfg.freeEntry.language || "").trim();
  const slots = cfg.freeEntry.slotsHours;
  if (!activatedAt || !Number.isFinite(activatedTime) ||
      !templateName || !/^[a-z0-9_]+$/.test(templateName) ||
      !/^(?:[a-z]{2,3}_[A-Z]{2}|ms)$/.test(language) ||
      !Array.isArray(slots) || !slots.length || slots.length > 6 ||
      slots.some((hour) => !Number.isInteger(hour) || hour < 25 || hour > 166))
    return null;
  return { activatedAt: new Date(activatedTime).toISOString(),
    templateName, language, slots };
}

function selectedSlot(candidate, slots, now = new Date()) {
  const reply = new Date(candidate.first_reply_at).getTime();
  const clock = new Date(now).getTime();
  for (const slotHours of slots) {
    const due = reply + slotHours * 3600000;
    // Never catch up a missed day by blasting several templates together.
    if (clock > due + 12 * 3600000 || candidate.claimed_slots?.includes(slotHours)) continue;
    if (eligibleFreeEntryTime({
      firstInboundAt: candidate.first_inbound_at,
      firstReplyAt: candidate.first_reply_at,
      lastInboundAt: candidate.last_inbound_at,
      evidenceType: candidate.evidence_type,
      sourceIsCtwa: candidate.source_is_ctwa,
      slotHours, now,
    })) return slotHours;
  }
  return null;
}

async function listCandidates(active, database = pool, contactId = null) {
  const query = await database.query(candidateSql,
    [active.activatedAt, contactId, contactId ? 1 : MAX_BATCH_SIZE, active.slots]);
  return query.rows;
}

async function claim(candidate, slotHours, active) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [CONVERSATION_LOCK_NAMESPACE, candidate.contact_id]);
    const fresh = (await listCandidates(active, client, candidate.contact_id))[0];
    if (!fresh || fresh.first_reply_message_id !== candidate.first_reply_message_id ||
        !active.slots.includes(slotHours) ||
        !eligibleFreeEntryTime({
          firstInboundAt: fresh.first_inbound_at,
          firstReplyAt: fresh.first_reply_at,
          lastInboundAt: fresh.last_inbound_at,
          evidenceType: fresh.evidence_type,
          sourceIsCtwa: fresh.source_is_ctwa,
          slotHours,
        })) {
      await client.query("ROLLBACK");
      return null;
    }
    const result = await client.query(
      `INSERT INTO whatsapp_free_entry_followup_attempts
       (contact_id, first_reply_message_id, slot_hours)
       VALUES ($1, $2, $3)
       ON CONFLICT (first_reply_message_id, slot_hours) DO NOTHING
       RETURNING id`,
      [candidate.contact_id, candidate.first_reply_message_id, slotHours]
    );
    await client.query("COMMIT");
    return result.rows[0]?.id || null;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally { client.release(); }
}

async function finish(attemptId, status, values = {}) {
  await pool.query(
    `UPDATE whatsapp_free_entry_followup_attempts
     SET status = $2, message_id = COALESCE($3, message_id),
         wamid = COALESCE($4, wamid),
         error = $5, updated_at = now()
     WHERE id = $1`,
    [attemptId, status, values.messageId || null,
      values.wamid || null, values.error || null]
  );
}

async function processCandidate(candidate, active, template, now = new Date()) {
  const slotHours = selectedSlot(candidate, active.slots, now);
  if (!slotHours) return "not_due";
  const quiet = quietHoursStatus(now, clinicConfig.automatedFollowUp?.quietHours);
  if (quiet.active) return "quiet_hours";

  const attemptId = await claim(candidate, slotHours, active);
  if (!attemptId) return "already_claimed_or_ineligible";

  let message = null;
  try {
    // This is a fixed, already approved MARKETING template. No AI-authored
    // content or arbitrary variable substitution is permitted in automation.
    const values = whatsappTemplates.buildTemplateComponents(template, {});
    const preview = values.valid &&
      whatsappTemplates.renderTemplatePreview(template, values.values);
    if (!values.valid || !preview) {
      await finish(attemptId, "cancelled", { error: "Invalid template preview" });
      return "invalid_template";
    }
    const metadata = {
      name: template.name, language: template.language, category: "MARKETING",
      components: values.components, values: values.values,
      templateSignature: whatsappTemplates.templateSignature(template),
      automatedFreeEntry: true, slotHours,
      marketingConsentConfirmed: true,
    };
    message = await messagesRepo.saveMessage(
      candidate.contact_id, "assistant", preview,
      null, "Automation", null, null, null,
      { whatsappTemplate: metadata, initialDeliveryStatus: "unknown",
        initialDeliveryError: "Awaiting WhatsApp template delivery confirmation." }
    );
    await pool.query(
      "UPDATE whatsapp_free_entry_followup_attempts SET message_id=$2 WHERE id=$1",
      [attemptId, message.id]
    );

    // Recheck after writes and immediately before the provider call. If Meta's
    // approval or the lead's state changed, keep the claim terminal.
    const liveActive = settings();
    const fresh = liveActive &&
      (await listCandidates(liveActive, pool, candidate.contact_id))[0];
    if (!fresh || fresh.first_reply_message_id !== candidate.first_reply_message_id ||
      !eligibleFreeEntryTime({
        firstInboundAt: fresh.first_inbound_at,
        firstReplyAt: fresh.first_reply_at,
        lastInboundAt: fresh.last_inbound_at,
        evidenceType: fresh.evidence_type,
        sourceIsCtwa: fresh.source_is_ctwa,
        slotHours,
      }) ||
      quietHoursStatus(new Date(), clinicConfig.automatedFollowUp?.quietHours).active ||
      liveActive.templateName !== active.templateName ||
      liveActive.language !== active.language) {
      await messagesRepo.setDeliveryStatusById(message.id, "cancelled", "No longer eligible");
      await finish(attemptId, "cancelled", { messageId: message.id, error: "No longer eligible" });
      return "cancelled";
    }
    const response = await whatsappTemplates.sendApprovedTemplate(
      { id: candidate.contact_id, channel: "whatsapp",
        whatsapp_number: candidate.whatsapp_number },
      { templateName: template.name, languageCode: template.language,
        templateCategory: "MARKETING" }
    );
    if (response?.wamid) {
      await messagesRepo.setWhatsappMessageId(message.id, response.wamid);
      await finish(attemptId, "accepted", {
        messageId: message.id, wamid: response.wamid
      });
      realtimeEvents.publish("conversation_changed", {
        contactId: candidate.contact_id, messageId: message.id,
        reason: "free_entry_template_accepted"
      });
      return "accepted";
    }
    const status = response?.unknown ? "unknown" : "failed";
    await messagesRepo.setDeliveryStatusById(
      message.id, status, response?.error || "Template delivery not confirmed"
    );
    await finish(attemptId, status, {
      messageId: message.id, error: response?.error || "Not confirmed"
    });
    return status;
  } catch (err) {
    // An exception after the provider request is ambiguous. Never automatically
    // resend this slot because the first attempt might have reached Meta.
    if (message) {
      await messagesRepo.setDeliveryStatusById(
        message.id, "unknown", "Extended follow-up delivery not confirmed"
      ).catch(() => {});
    }
    await finish(attemptId, "unknown", {
      messageId: message?.id,
      error: String(err?.message || err).slice(0, 300),
    }).catch(() => {});
    console.error("[WhatsApp FEP] send outcome unknown:", err);
    return "unknown";
  }
}

async function run({ now = new Date() } = {}) {
  if (running) return { skipped: true };
  const active = settings();
  if (!active) return { disabled: true };
  running = true;
  try {
    const result = { candidates: 0, accepted: 0, skipped: 0 };
    const catalog = await whatsappTemplates.resolveApprovedTemplate(
      active.templateName, active.language);
    if (!catalog.success || !catalog.template?.sendable ||
      catalog.template.category !== "MARKETING" ||
      catalog.template.variableFields.length !== 0) {
      console.warn("[WhatsApp FEP] Approved static MARKETING template unavailable. No sends.");
      return { disabled: true, reason: "template_not_approved" };
    }
    const candidates = await listCandidates(active);
    result.candidates = candidates.length;
    for (const candidate of candidates) {
      const outcome = await processCandidate(candidate, active, catalog.template, now);
      if (outcome === "accepted") result.accepted++;
      else result.skipped++;
    }
    return result;
  } finally { running = false; }
}

function start() {
  if (timer) return () => clearInterval(timer);
  if (!freeEntryEnabled()) return () => {};
  // Only start after the schema and clinic config are loaded.
  const tick = () => run().catch((error) =>
    console.error("[WhatsApp FEP] worker failed:", error));
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref?.();
  tick();
  return () => { clearInterval(timer); timer = null; };
}

module.exports = { settings, selectedSlot, listCandidates, claim, processCandidate, run, start };
