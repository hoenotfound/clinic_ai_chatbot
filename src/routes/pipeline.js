const express = require("express");
const pipelineRepo = require("../db/pipelineRepo");
const analyticsRepo = require("../db/analyticsRepo");
const leadAttributionRepo = require("../db/leadAttributionRepo");
const contactsRepo = require("../db/contactsRepo");
const usersRepo = require("../db/usersRepo");
const clinicConfig = require("../config/clinicConfig");
const {
  PipelineValidationError,
  normalizeLeadPayload,
  normalizeStagePayload,
  normalizeStageOrder,
} = require("../utils/pipelineValidation");
const {
  AnalyticsValidationError,
  normalizeAnalyticsQuery,
} = require("../utils/analyticsValidation");

const router = express.Router();

function distinctNames(values) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))];
}

function configuredBranchNames() {
  return distinctNames((clinicConfig.branches || []).map((branch) => branch.name));
}

function publicAttribution(attribution) {
  if (!attribution) return null;
  return {
    source: attribution.source || null,
    platform: attribution.platform || null,
    channel: attribution.channel || null,
    meta_ad_id: attribution.meta_ad_id || null,
    meta_source_id: attribution.meta_source_id || null,
    meta_source_type: attribution.meta_source_type || null,
    referral_ref: attribution.referral_ref || null,
    referral_source: attribution.referral_source || null,
    referral_type: attribution.referral_type || null,
    ctwa_clid: attribution.ctwa_clid || null,
    source_url: attribution.source_url || null,
    headline: attribution.headline || null,
    body: attribution.body || null,
    media_type: attribution.media_type || null,
    media_url: attribution.media_url || null,
    campaign_id: attribution.campaign_id || null,
    campaign_name: attribution.campaign_name || null,
    adset_id: attribution.adset_id || null,
    adset_name: attribution.adset_name || null,
    ad_name: attribution.ad_name || null,
    attributed_at: attribution.attributed_at || null,
  };
}

function withAttribution(lead, attribution) {
  if (!lead) return lead;
  return { ...lead, attribution: publicAttribution(attribution) };
}

async function enrichLead(lead) {
  if (!lead) return null;
  return withAttribution(lead, await leadAttributionRepo.getForLead(lead.id));
}

function handlePipelineError(res, err, fallbackMessage) {
  if (err instanceof PipelineValidationError || err instanceof AnalyticsValidationError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (
    err.code === "P0001" &&
    (String(err.message || "").startsWith("Lead owner ") ||
      String(err.message || "").startsWith("Lead branch "))
  ) {
    return res.status(409).json({ error: err.message });
  }
  if (err.code === "23505") {
    return res.status(409).json({ error: "This contact already has an open lead, or that stage name is already in use." });
  }
  if (["DUPLICATE_STAGE", "STAGE_IN_USE", "LAST_OPEN_STAGE", "INVALID_STAGE_ORDER", "SYSTEM_STAGE"].includes(err.code)) {
    return res.status(409).json({ error: err.message });
  }
  if (["INVALID_STAGE", "NO_OPEN_STAGE"].includes(err.code)) {
    return res.status(400).json({ error: err.message });
  }
  console.error(fallbackMessage, err);
  return res.status(500).json({ error: fallbackMessage });
}

// GET /api/pipeline - complete lightweight board payload.
router.get("/", async (req, res) => {
  try {
    const [stages, rawLeads, assignableOwners] = await Promise.all([
      pipelineRepo.listStages(),
      pipelineRepo.listLeads(),
      usersRepo.listAssignableLeadOwners(),
    ]);
    const attributionByLead = await leadAttributionRepo.getForLeadIds(
      rawLeads.map((lead) => lead.id)
    );
    const leads = rawLeads.map((lead) =>
      withAttribution(lead, attributionByLead.get(Number(lead.id)))
    );
    const configuredBranches = configuredBranchNames();
    const savedBranches = distinctNames(leads.map((lead) => lead.branch_name));

    res.json({
      stages,
      leads,
      branches: distinctNames([...configuredBranches, ...savedBranches]),
      configuredBranches,
      owners: assignableOwners.map((owner) => owner.username),
      services: distinctNames((clinicConfig.services || []).map((service) => service.name)),
      noReplyHours: pipelineRepo.NO_REPLY_HOURS,
    });
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong loading the pipeline.");
  }
});

// Lightweight source of truth for branch-editing controls. This avoids loading
// the full Pipeline board again just to populate one select menu.
router.get("/configured-branches", (req, res) => {
  res.json({ branches: configuredBranchNames() });
});

// GET /api/pipeline/analytics - server-side aggregate dashboard payload.
router.get("/analytics", async (req, res) => {
  try {
    const filters = normalizeAnalyticsQuery(req.query);
    res.json(await analyticsRepo.getAnalytics(filters));
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong loading analytics.");
  }
});

router.get("/leads/:leadId/activities", async (req, res) => {
  try {
    const lead = await pipelineRepo.getLeadById(req.params.leadId);
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    res.json(await pipelineRepo.listActivities(lead.id));
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong loading lead activity.");
  }
});

router.post("/leads", async (req, res) => {
  try {
    const data = normalizeLeadPayload(req.body);
    const contact = await contactsRepo.getContactById(data.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found." });
    const result = await pipelineRepo.createLead(data, req.session.username);
    const lead = await enrichLead(await pipelineRepo.getLeadById(result.lead.id));
    res.status(result.created ? 201 : 200).json({ lead, created: result.created });
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong creating the lead.");
  }
});

router.patch("/leads/:leadId", async (req, res) => {
  try {
    const patch = normalizeLeadPayload(req.body, { partial: true });
    const updated = await pipelineRepo.updateLead(req.params.leadId, patch, req.session.username);
    if (!updated) return res.status(404).json({ error: "Lead not found." });
    res.json(await enrichLead(await pipelineRepo.getLeadById(updated.id)));
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong updating the lead.");
  }
});

router.post("/leads/:leadId/notes", async (req, res) => {
  try {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "Note can't be empty." });
    if (content.length > 3000) return res.status(400).json({ error: "Note is too long." });
    const activity = await pipelineRepo.addNote(req.params.leadId, content, req.session.username);
    if (!activity) return res.status(404).json({ error: "Lead not found." });
    res.status(201).json(activity);
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong saving the lead note.");
  }
});

router.post("/stages", async (req, res) => {
  try {
    const data = normalizeStagePayload(req.body);
    res.status(201).json(await pipelineRepo.createStage(data));
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong creating the stage.");
  }
});

router.patch("/stages/:stageId", async (req, res) => {
  try {
    const patch = normalizeStagePayload(req.body, { partial: true });
    const updated = await pipelineRepo.updateStage(req.params.stageId, patch);
    if (!updated) return res.status(404).json({ error: "Stage not found." });
    res.json(updated);
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong updating the stage.");
  }
});

router.post("/stages/reorder", async (req, res) => {
  try {
    res.json(await pipelineRepo.reorderStages(normalizeStageOrder(req.body)));
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong reordering stages.");
  }
});

router.delete("/stages/:stageId", async (req, res) => {
  try {
    const deleted = await pipelineRepo.deleteStage(req.params.stageId);
    if (!deleted) return res.status(404).json({ error: "Stage not found." });
    res.json({ deleted: true });
  } catch (err) {
    handlePipelineError(res, err, "Something went wrong deleting the stage.");
  }
});

module.exports = router;
