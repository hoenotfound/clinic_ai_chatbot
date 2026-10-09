const { pool } = require("../db/db");
const { sessionLateralSql } = require("../db/whatsappFreeEntrySessionSql");
const { CONVERSATION_LOCK_NAMESPACE } = require("../db/conversationLock");
const clinicConfig = require("../config/clinicConfig");
const { automatedRepliesEnabled } = require("./automaticReplyControl");
const whatsappTemplates = require("./whatsappTemplateService");
const zeroCostGuard = require("./whatsappZeroCostGuard");
const whatsapp = require("./whatsappService");
const promoImagesRepo = require("../db/promoImagesRepo");
const mediaCache = require("./whatsappFreeEntryMediaCache");
const messagesRepo = require("../db/messagesRepo");
const freeEntryReport = require("../db/whatsappFreeEntryReportRepo");
const realtimeEvents = require("../utils/realtimeEvents");
const { quietHoursStatus } = require("../utils/quietHours");
const { effectiveSlotDueAt } = require("../utils/freeEntrySchedule");
const { selectTemplateSpec, buildStaticMarketingTemplate, materializeTemplateMediaSpec, validateApprovedMedia, validateTemplateRules, enrichAutomatedTemplateSpec, prepareAutoPromotionMedia, SUPPORTED_LANGUAGES } = require("../utils/freeEntryTemplateSelection");
const {
  freeEntryEnabled,
  eligibleFreeEntryTime,
} = require("../utils/whatsappFreeEntryWindow");

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BATCH_SIZE = 20;
// Only a strictly policy-rejected request that NEVER reached Meta can be
// re-claimed. Unknown, failed, accepted, and manual cancellations stay one-shot.
const SAFE_POLICY_DEFERRAL = "FREE_ONLY_POLICY_DEFERRED_NO_PROVIDER_SEND";
function safelyDeferredAttemptSql(alias) {
  return `${alias}.status = 'cancelled'
    AND ${alias}.error = '${SAFE_POLICY_DEFERRAL}'
    AND ${alias}.wamid IS NULL
    AND ${alias}.message_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM messages deferred_message
      WHERE deferred_message.id = ${alias}.message_id
        AND deferred_message.contact_id = ${alias}.contact_id
        AND deferred_message.role = 'assistant'
        AND deferred_message.whatsapp_message_id IS NULL
        AND deferred_message.delivery_status = 'cancelled'
    )`;
}
let running = false;
let timer = null;

// A fresh Meta pricing callback on the first real business response is required.
// Ad attribution alone is not sufficient billing proof. Do not backfill leads:
// clinicConfig.automatedFollowUp.freeEntry.activatedAt is the cutover boundary.
const candidateSql = `
  SELECT c.id AS contact_id, c.whatsapp_number, c.mode, c.whatsapp_opt_in_at,
         origin.created_at AS first_inbound_at,
         first_reply.id AS first_reply_message_id,
         first_reply.created_at AS first_reply_at,
         last_inbound.created_at AS last_inbound_at,
         evidence.pricing_type AS evidence_type,
         lead.treatment_interest,
         lead.started_message_id AS lead_started_message_id,
         origin.id AS epoch_origin_message_id,
         latest_ad.treatment_interest AS referral_treatment_interest,
         COALESCE(NULLIF(latest_ad.ad_name,''),ad_insights.ad_name) AS referral_ad_name,
         latest_ad.origin_message_id AS latest_ad_message_id,
         (SELECT array_agg(text_content ORDER BY msg_time DESC) FROM (
           SELECT m.content AS text_content, m.created_at AS msg_time
           FROM messages m WHERE m.contact_id = c.id AND m.role = 'user'
             AND (m.created_at,m.id) >= (latest_ad.origin_at,latest_ad.origin_message_id)
           ORDER BY m.created_at DESC, m.id DESC LIMIT 8
         ) recent) AS recent_inbound_messages,
         (SELECT COALESCE(array_agg(slot_hours), '{}') FROM whatsapp_free_entry_followup_attempts existing
          WHERE existing.first_reply_message_id = first_reply.id
            AND NOT (${safelyDeferredAttemptSql('existing')})) AS claimed_slots,
         (SELECT COALESCE(array_agg(DISTINCT m.whatsapp_template->>'name'), '{}')
            FROM whatsapp_free_entry_followup_attempts previous
            JOIN messages m ON m.id=previous.message_id
            WHERE previous.first_reply_message_id=first_reply.id
              AND previous.status='accepted'
              AND m.whatsapp_template->>'name' IS NOT NULL) AS used_template_names,
         (SELECT COUNT(*)::integer
            FROM whatsapp_free_entry_followup_attempts previous
            WHERE previous.first_reply_message_id=first_reply.id
              AND previous.status='accepted') AS accepted_extended_sends,
         true AS source_is_ctwa
  FROM contacts c
  JOIN LATERAL (
    SELECT l.id, l.is_closed, l.appointment_status, l.marketing_consent, l.treatment_interest,
           l.started_message_id,
           s.stage_type, s.system_key
    FROM leads l
    LEFT JOIN pipeline_stages s ON s.id = l.stage_id
    WHERE l.contact_id = c.id
    ORDER BY l.is_closed ASC, l.created_at DESC, l.id DESC
    LIMIT 1
  ) lead ON true
  ${sessionLateralSql({ contactAlias: 'c', ceilingParam: '$8' })}
  JOIN messages origin ON origin.id = referral.origin_message_id
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
    SELECT e.origin_message_id, e.treatment_interest, e.ad_name, e.meta_ad_id,
      message.created_at AS origin_at
    FROM whatsapp_free_entry_referrals e
    JOIN messages message ON message.id=e.origin_message_id
    WHERE e.contact_id=c.id
      AND (message.created_at,message.id) >= (origin.created_at,origin.id)
      AND message.created_at < first_reply.created_at +
        ($8::integer * interval '1 hour')
    ORDER BY message.created_at DESC,message.id DESC LIMIT 1
  ) latest_ad ON true
  LEFT JOIN LATERAL (
    SELECT insight.ad_name FROM meta_ad_insights_daily insight
    WHERE insight.ad_id=latest_ad.meta_ad_id
      AND NULLIF(BTRIM(insight.ad_name),'') IS NOT NULL
    ORDER BY insight.insight_date DESC, insight.updated_at DESC LIMIT 1
  ) ad_insights ON true
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
    AND (SELECT count(*) FROM whatsapp_free_entry_followup_attempts sent
         WHERE sent.first_reply_message_id=first_reply.id AND sent.status='accepted') < 3
    AND lead.is_closed = false
    AND COALESCE(lead.stage_type, 'open') = 'open'
    AND COALESCE(lead.system_key, '') NOT IN ('appointment_set','visited')
    AND COALESCE(lead.appointment_status, 'none') NOT IN ('set','visited')
    AND (referral.ctwa_clid IS NOT NULL OR referral.meta_ad_id IS NOT NULL)
    AND evidence.pricing_type = 'free_entry_point'
    AND evidence.billable = false
    AND evidence.delivery_status IN ('sent','delivered','read')
    -- Do not advance after a rejected, unconfirmed or unreconciled send.
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_free_entry_followup_attempts prior
      LEFT JOIN whatsapp_free_entry_pricing_evidence prior_billing
        ON prior_billing.wamid = prior.wamid
      WHERE prior.first_reply_message_id = first_reply.id
        AND prior.id IS DISTINCT FROM $6::bigint
        -- Reconciliation never retries the original claimed slot. It only
        -- permits later eligible slots to advance after manual review.
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_free_only_reconciliations audit
          WHERE audit.attempt_id=prior.id
            AND audit.verified_billing_hub=true
        )
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
        AND recent_send.id IS DISTINCT FROM $5::integer
        AND recent_send.delivery_status IS DISTINCT FROM 'cancelled'
    )
    -- Staff interventions take precedence over automated marketing.
    AND NOT EXISTS (
      SELECT 1 FROM messages staff_reply
      WHERE staff_reply.contact_id = c.id
        AND staff_reply.role = 'assistant'
        AND staff_reply.sent_by_username IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM users human_staff
          WHERE human_staff.username = staff_reply.sent_by_username
        )
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
          AND NOT (${safelyDeferredAttemptSql('prior')})
      )
      AND now() >= first_reply.created_at +
        (slot.hours - CASE WHEN slot.hours = (SELECT max(n) FROM unnest($4::integer[]) AS n WHERE n < $8::integer)
         THEN 12 ELSE 0 END) * interval '1 hour'
      AND now() < first_reply.created_at + (slot.hours + 12) * interval '1 hour'
      AND now() >= last_inbound.created_at + interval '24 hours'
    ))
  ORDER BY first_reply.created_at ASC, c.id ASC
  LIMIT $3::integer OFFSET $7::integer
`;

function settings(env = process.env) {
  if (!freeEntryEnabled(env) || !automatedRepliesEnabled(env)) return null;
  const cfg = clinicConfig.automatedFollowUp;
  if (cfg?.enabled !== true || cfg?.freeEntry?.enabled !== true) return null;
  const activatedAt = cfg.freeEntry.activatedAt;
  const activatedTime = new Date(activatedAt).getTime();
  const templateName = String(cfg.freeEntry.templateName || "").trim();
  const language = String(cfg.freeEntry.language || "").trim();
  const fallbackLanguage = String(cfg.freeEntry.fallbackLanguage || "zh_CN").trim();
  const slots = cfg.freeEntry.slotsHours;
  const templateRules = cfg.freeEntry.templateRules || [];
  // Conservative by default: seven-day rollout must be verified for this account.
  const sevenDayVerified = String(env.WHATSAPP_FEP_7DAY_VERIFIED || "").toLowerCase() === "true";
  if (!activatedAt || !Number.isFinite(activatedTime) ||
      !templateName || !/^[a-z0-9_]+$/.test(templateName) ||
      !SUPPORTED_LANGUAGES.has(language) ||
      !["zh_CN","en_US","ms"].includes(fallbackLanguage) ||
      !Array.isArray(slots) || !slots.length || slots.length > 6 ||
      slots.some((hour) => !Number.isInteger(hour) || hour < 25 || hour > 166) ||
      !validateTemplateRules(templateRules, slots, clinicConfig.services || []))
    return null;
  return { activatedAt: new Date(activatedTime).toISOString(),
    templateName, language, fallbackLanguage, slots, templateRules, sevenDayVerified };
}

// The worker and the final provider-send guard MUST agree on the ceiling.
// When free-only mode is on, the seven-day flag alone cannot consume slots
// beyond 72h. Fail closed when pricing evidence is unavailable, before any
// attempt is claimed or a template is uploaded to Meta.
async function alignedSettings(active, database = pool) {
  if (!active || !zeroCostGuard.enabled()) return active;
  const ceiling = await zeroCostGuard.authorizedCeilingHours({ database });
  return { ...active, sevenDayVerified: ceiling === 168 };
}

function selectedSlot(candidate, slots, now = new Date()) {
  const reply = new Date(candidate.first_reply_at).getTime();
  const clock = new Date(now).getTime();
  for (const slotHours of slots) {
    const due = reply + slotHours * 3600000;
    const effectiveDue = effectiveSlotDueAt(candidate.first_reply_at, slotHours,
      slots, clinicConfig.automatedFollowUp?.quietHours,
      { maxCeilingHours: candidate.sevenDayVerified ? 168 : 72 });
    // Never catch up a missed day by blasting several templates together.
    if (clock > due + 12 * 3600000 || candidate.claimed_slots?.includes(slotHours)) continue;
    if (eligibleFreeEntryTime({
      firstInboundAt: candidate.first_inbound_at,
      firstReplyAt: candidate.first_reply_at,
      lastInboundAt: candidate.last_inbound_at,
      evidenceType: candidate.evidence_type,
      sourceIsCtwa: candidate.source_is_ctwa,
      slotHours, now, earlyDueAt: effectiveDue,
      maxCeilingHours: candidate.sevenDayVerified ? 168 : 72,
    })) return slotHours;
  }
  return null;
}

async function listCandidates(active, database = pool, contactId = null, {
  excludeMessageId = null, currentAttemptId = null, offset = 0,
} = {}) {
  const effective = await alignedSettings(active, database);
  const query = await database.query(candidateSql,
    [effective.activatedAt, contactId, contactId ? 1 : MAX_BATCH_SIZE, effective.slots,
      excludeMessageId, currentAttemptId, offset, effective.sevenDayVerified ? 168 : 72]);
  return query.rows;
}

async function claim(candidate, slotHours, requested, database = pool) {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [CONVERSATION_LOCK_NAMESPACE, candidate.contact_id]);
    const active = await alignedSettings(requested, client);
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
          maxCeilingHours: active.sevenDayVerified ? 168 : 72,
          earlyDueAt: effectiveSlotDueAt(fresh.first_reply_at, slotHours,
            active.slots, clinicConfig.automatedFollowUp?.quietHours,
            { maxCeilingHours: active.sevenDayVerified ? 168 : 72 }),
        })) {
      await client.query("ROLLBACK");
      return null;
    }
    // Only a conclusively unattempted, strictly policy-blocked slot may
    // be recycled under the same per-conversation advisory lock.
    let result = await client.query(
      `UPDATE whatsapp_free_entry_followup_attempts deferred
       SET status='sending',message_id=NULL,wamid=NULL,error=NULL,
           updated_at=now()
       WHERE deferred.contact_id=$1
         AND deferred.first_reply_message_id=$2
         AND deferred.slot_hours=$3
         AND (${safelyDeferredAttemptSql('deferred')})
       RETURNING deferred.id`,
      [candidate.contact_id,candidate.first_reply_message_id,slotHours]
    );
    if (!result.rows.length) {
      result = await client.query(
        `INSERT INTO whatsapp_free_entry_followup_attempts
         (contact_id, first_reply_message_id, slot_hours)
         VALUES ($1, $2, $3)
         ON CONFLICT (first_reply_message_id, slot_hours) DO NOTHING
         RETURNING id`,
        [candidate.contact_id, candidate.first_reply_message_id, slotHours]
      );
    }
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

async function processCandidate(candidate, requested, template, now = new Date(), explicitSpec = null) {
  const active = await alignedSettings(requested);
  const slotHours = selectedSlot({...candidate, sevenDayVerified:active.sevenDayVerified}, active.slots, now);
  if (!slotHours) return "not_due";
  const spec = explicitSpec || enrichAutomatedTemplateSpec(
    selectTemplateSpec(candidate, slotHours, active), template
  );
  if (!spec) return "unsupported_or_ambiguous_template_media";
  if (candidate.used_template_names?.includes(spec.templateName)) return "template_already_used";
  if (!await validateApprovedMedia(template, spec)) return "media_validation_failed";
  const quiet = quietHoursStatus(now, clinicConfig.automatedFollowUp?.quietHours);
  if (quiet.active) return "quiet_hours";

  // Never claim/consume a follow-up slot to discover that the provider-send
  // guard is going to reject it. If another send is pending or the strict
  // 7-day billing evidence is absent, leave this slot eligible for a later
  // sweep. Final reserve() still locks and rechecks right before calling Meta.
  const preflight = await zeroCostGuard.preflightTemplate(candidate.whatsapp_number, { now });
  if (!preflight.allowed) {
    console.warn("[WhatsApp FEP] deferred before claim:", preflight.code);
    return "billing_preflight_deferred";
  }

  const attemptId = await claim(candidate, slotHours, active);
  if (!attemptId) return "already_claimed_or_ineligible";

  let message = null;
  let acceptedWamid = null;
  try {
    // Every value comes from a configured service/active clinic promotion;
    // never from AI-generated text or arbitrary customer-supplied URLs.
    // Upload image assets to Meta using the already validated public-config
    // clinic image bytes. No server-side video compression is performed.
    let uploadedImageId = null;
    let uploadedImageMime = null;
    if (spec.autoPromoImageId) {
      const metadata = await promoImagesRepo.getPublicImageMetadata(spec.autoPromoImageId);
      if (!["image/jpeg","image/png"].includes(metadata?.mime_type)) {
        await finish(attemptId, "cancelled", { error: "Configured promotion image is no longer public" });
        return "media_unavailable";
      }
      uploadedImageMime = metadata.mime_type;
      uploadedImageId = mediaCache.get(spec.autoPromoImageId, uploadedImageMime);
      if (!uploadedImageId) {
        const prepared = await prepareAutoPromotionMedia(spec);
        if (!prepared || prepared.mimeType !== uploadedImageMime) {
          await finish(attemptId, "cancelled", { error: "Configured promotion image no longer available or valid" });
          return "media_unavailable";
        }
        uploadedImageId = await whatsapp.uploadMedia(
          prepared.buffer, prepared.mimeType, prepared.filename
        );
        if (!uploadedImageId) {
          await finish(attemptId, "cancelled", { error: "Meta refused the promotion image upload" });
          return "media_upload_failed";
        }
        mediaCache.put(spec.autoPromoImageId, uploadedImageMime, uploadedImageId);
      }
    }
    const built = buildStaticMarketingTemplate(
      template, materializeTemplateMediaSpec(spec), whatsappTemplates,
      { mediaId: uploadedImageId }
    );
    if (!built) {
      await finish(attemptId, "cancelled", { error: "Unapproved or invalid media/template pairing" });
      return "invalid_template";
    }
    const metadata = {
      name: template.name, language: template.language, category: "MARKETING",
      components: built.components, values: built.values,
      sourceService: spec.identifiedTreatment || spec.serviceName,
      mediaKey: spec.mediaKey || null,
      mediaUrl: spec.autoPromoImageId ? "/promo-images/" + spec.autoPromoImageId :
        spec.mediaKey ? null : spec.mediaUrl || null,
      templateSignature: whatsappTemplates.templateSignature(template),
      automatedFreeEntry: true, slotHours,
      marketingConsentConfirmed: true,
      consentOptInAt: candidate.whatsapp_opt_in_at,
    };
    message = await messagesRepo.saveMessage(
      candidate.contact_id, "assistant", built.preview,
      null, null,
      spec.autoPromoImageId ? "/promo-images/" + spec.autoPromoImageId :
        spec.mediaKey ? null : (spec.mediaUrl || null),
      null, uploadedImageMime || (template.header?.format === "VIDEO" ? "video/mp4" :
        template.header?.format === "IMAGE" ?
          (String(spec.mediaKey || spec.mediaUrl || "").toLowerCase().includes(".png") ?
            "image/png" : "image/jpeg") : null),
      { mediaKey: spec.mediaKey || null, whatsappTemplate: metadata,
        isAutomatedFollowUp: true,
        initialDeliveryStatus: "unknown",
        initialDeliveryError: "Awaiting WhatsApp template delivery confirmation." }
    );
    await pool.query(
      "UPDATE whatsapp_free_entry_followup_attempts SET message_id=$2 WHERE id=$1",
      [attemptId, message.id]
    );

    // Recheck after writes and immediately before the provider call. If Meta's
    // approval or the lead's state changed, keep the claim terminal.
    const liveActive = await alignedSettings(settings());
    const fresh = liveActive &&
      (await listCandidates(liveActive, pool, candidate.contact_id, {
        excludeMessageId: message.id, currentAttemptId: attemptId,
      }))[0];
    if (!fresh || fresh.first_reply_message_id !== candidate.first_reply_message_id ||
      fresh.used_template_names?.includes(spec.templateName) ||
      !eligibleFreeEntryTime({
        firstInboundAt: fresh.first_inbound_at,
        firstReplyAt: fresh.first_reply_at,
        lastInboundAt: fresh.last_inbound_at,
        evidenceType: fresh.evidence_type,
        sourceIsCtwa: fresh.source_is_ctwa,
        slotHours,
        maxCeilingHours: liveActive.sevenDayVerified ? 168 : 72,
        earlyDueAt: effectiveSlotDueAt(fresh.first_reply_at, slotHours,
          liveActive.slots, clinicConfig.automatedFollowUp?.quietHours,
          { maxCeilingHours: liveActive.sevenDayVerified ? 168 : 72 }),
      }) ||
      quietHoursStatus(new Date(), clinicConfig.automatedFollowUp?.quietHours).active ||
      !(() => {
        const selected = selectTemplateSpec(fresh, slotHours, liveActive);
        const current = selected && enrichAutomatedTemplateSpec(
          { ...selected, language: template.language }, template
        );
        return current && current.templateName === spec.templateName &&
          current.mediaKey === spec.mediaKey &&
          current.mediaUrl === spec.mediaUrl &&
          current.serviceName === spec.serviceName &&
          current.autoPromoImageId === spec.autoPromoImageId &&
          current.bodyValue === spec.bodyValue &&
          (selected.language === spec.language ||
            spec.language === liveActive.fallbackLanguage);
      })()) {
      await messagesRepo.setDeliveryStatusById(message.id, "cancelled", "No longer eligible");
      await finish(attemptId, "cancelled", { messageId: message.id, error: "No longer eligible" });
      return "cancelled";
    }
    const readyToSend = buildStaticMarketingTemplate(
      template, materializeTemplateMediaSpec(spec), whatsappTemplates,
      { mediaId: uploadedImageId }
    );
    if (!readyToSend || !await validateApprovedMedia(template, spec)) {
      await messagesRepo.setDeliveryStatusById(message.id, "cancelled",
        "Media unavailable or outside WhatsApp format/size limits");
      await finish(attemptId, "cancelled", { messageId: message.id,
        error: "Media unavailable or outside WhatsApp format/size limits" });
      return "media_unavailable";
    }
    const response = await whatsappTemplates.sendApprovedTemplate(
      { id: candidate.contact_id, channel: "whatsapp",
        whatsapp_number: candidate.whatsapp_number },
      { templateName: template.name, languageCode: template.language,
        templateCategory: "MARKETING", components: readyToSend.components,
        treatmentInterest: spec.identifiedTreatment || null,
        expectedOptInAt: fresh.whatsapp_opt_in_at,
        currentMessageId: message.id,
        currentFollowUpAttemptId: attemptId }
    );
    if (response?.wamid) {
      acceptedWamid = response.wamid;
      // Keep provider identity in the durable attempt before the Inbox write.
      // A DB interruption must not discard the only Meta message ID.
      await finish(attemptId, "sending", {
        messageId: message.id, wamid: acceptedWamid
      });
      await messagesRepo.setWhatsappMessageId(message.id, acceptedWamid);
      await finish(attemptId, "accepted", {
        messageId: message.id, wamid: acceptedWamid
      });
      realtimeEvents.publish("conversation_changed", {
        contactId: candidate.contact_id, messageId: message.id,
        reason: "free_entry_template_accepted"
      });
      return "accepted";
    }
    // Provider-policy blocks are not a failed send attempt. They cannot
    // generate WhatsApp charges, and must not poison eligibility for later
    // slots as though a provider request had actually been attempted.
    if (response?.policyBlocked===true && !response?.wamid) {
      await messagesRepo.setDeliveryStatusById(
        message.id,"cancelled",response.error||"WhatsApp policy blocked send"
      );
      // Only central free-only guard denials can be retryable; consent and
      // opt-out denials must not silently restart marketing sends.
      const retryable = String(response?.policyCode || "").startsWith("zero_cost_");
      await finish(attemptId,"cancelled",{
        messageId:message.id,
        error:retryable ? SAFE_POLICY_DEFERRAL :
          (response.error || "WhatsApp messaging policy denied send")
      });
      return retryable ? "policy_deferred" : "policy_cancelled";
    }
    const status = response?.unknown ? "unknown" : "failed";
    // An explicit Meta rejection can indicate an invalid/expired media ID.
    // Force a fresh upload next time; never retry this ambiguous slot.
    if (spec.autoPromoImageId && status === "failed") mediaCache.forget(spec.autoPromoImageId);
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
    if (message && !acceptedWamid) {
      await messagesRepo.setDeliveryStatusById(
        message.id, "unknown", "Extended follow-up delivery not confirmed"
      ).catch(() => {});
    }
    // Never clear an accepted WAMID after an unrelated persistence failure.
    // The terminal 'unknown' claim prevents a blind repeat of that step.
    await finish(attemptId, "unknown", {
      messageId: message?.id, wamid: acceptedWamid,
      error: String(err?.message || err).slice(0, 300),
    }).catch(() => {});
    console.error("[WhatsApp FEP] send outcome unknown:", err);
    return "unknown";
  }
}

async function run({ now = new Date() } = {}) {
  if (running) return { skipped: true };
  const configured = settings();
  if (!configured) return { disabled: true };
  running = true;
  try {
    const active = await alignedSettings(configured);
    const result = { candidates: 0, accepted: 0, skipped: 0 };
    const catalog = await whatsappTemplates.listApprovedTemplates();
    if (!catalog.success) return { disabled: true, reason: "template_catalog_unavailable" };
    // The queue is paged so 20 contacts missing template variants cannot
    // continually starve all contacts behind them.
    const allCandidates = [];
    for (let offset = 0; offset < 5000; offset += MAX_BATCH_SIZE) {
      const page = await listCandidates(active, pool, null, { offset });
      allCandidates.push(...page);
      if (page.length < MAX_BATCH_SIZE) break;
    }
    result.candidates = allCandidates.length;
    for (const candidate of allCandidates) {
      const slotHours = selectedSlot({...candidate, sevenDayVerified:active.sevenDayVerified}, active.slots, now);
      if (!slotHours) { result.skipped++; continue; }
      const preferred = selectTemplateSpec(candidate, slotHours, active);
      const matches = (locale) => catalog.templates.find((item) =>
        item.name === preferred?.templateName && item.language === locale &&
        item.status === "APPROVED" && item.category === "MARKETING"
      );
      const template = matches(preferred?.language) ||
        matches(active.fallbackLanguage);
      const spec = template && preferred
        ? enrichAutomatedTemplateSpec({ ...preferred, language: template.language }, template)
        : null;
      if (template && candidate.used_template_names?.includes(template.name)) {
        result.skipped++;
        await freeEntryReport.recordSkip(candidate.contact_id,
          candidate.first_reply_message_id, slotHours, "template_already_used_in_entry")
          .catch(() => {});
        continue;
      }
      if (!template || !spec ||
          !buildStaticMarketingTemplate(template, materializeTemplateMediaSpec(spec), whatsappTemplates,
            { allowUnuploadedMedia: true }) ||
          !await validateApprovedMedia(template, spec)) {
        result.skipped++;
        const reason = template ? "unsupported_or_unavailable_media" : "approved_language_variant_missing";
        await freeEntryReport.recordSkip(candidate.contact_id,
          candidate.first_reply_message_id, slotHours, reason).catch((error) =>
            console.warn("[WhatsApp FEP] failed to record skip:", error?.message));
        console.warn("[WhatsApp FEP] skipped", candidate.contact_id, slotHours, reason);
        continue;
      }
      const outcome = await processCandidate(candidate, active, template, now, spec);
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

module.exports = { settings, alignedSettings, selectedSlot, listCandidates, claim, processCandidate, run, start, SAFE_POLICY_DEFERRAL, safelyDeferredAttemptSql };
