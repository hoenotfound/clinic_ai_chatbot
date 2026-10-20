const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const clinicConfig = require("../src/config/clinicConfig");
const worker = require("../src/services/whatsappFreeEntryFollowUpService");

test("extended follow-up requires both global kill switch and clinic enable", () => {
  const old = clinicConfig.automatedFollowUp;
  try {
    clinicConfig.automatedFollowUp = {
      enabled: true,
      freeEntry: {
        enabled: true,
        activatedAt: "2026-10-08T00:00:00Z",
        templateName: "lead_follow_up",
        language: "zh_CN",
        slotsHours: [36, 60, 84, 108, 132, 156],
      },
    };
    assert.equal(worker.settings({}), null);
    const active = worker.settings({ WHATSAPP_FEP_FOLLOWUPS_ENABLED: "true" });
    assert.equal(active?.templateName, "lead_follow_up");
    assert.deepEqual(active?.slots, [36,60,84,108,132,156]);
    clinicConfig.automatedFollowUp.freeEntry.enabled = false;
    assert.equal(worker.settings({ WHATSAPP_FEP_FOLLOWUPS_ENABLED: "true" }), null);
  } finally {
    clinicConfig.automatedFollowUp = old;
  }
});

test("a silent lead gets one eligible day slot, never batches older reminders", () => {
  const candidate = {
    first_inbound_at: "2026-10-01T00:00:00Z",
    first_reply_at: "2026-10-01T00:02:00Z",
    last_inbound_at: "2026-10-01T00:00:00Z",
    source_is_ctwa: true,
    evidence_type: "free_entry_point",
  };
  assert.equal(worker.selectedSlot(candidate, [36,60,84], new Date("2026-10-02T12:05:00Z")), 36);
  assert.equal(worker.selectedSlot(candidate, [36,60,84], new Date("2026-10-03T13:00:00Z")), 60);
  assert.equal(worker.selectedSlot({ ...candidate, evidence_type: null }, [36,60,84], new Date("2026-10-03T13:00:00Z")), null);
  assert.equal(worker.selectedSlot({ ...candidate, last_inbound_at: "2026-10-02T14:00:00Z" }, [36,60,84], new Date("2026-10-03T13:00:00Z")), null);
});

test("worker has durable attempt, marketing and billed-message safety guards", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /ON CONFLICT \(first_reply_message_id, slot_hours\) DO NOTHING/);
  assert.match(code, /lead\.marketing_consent = 'opted_in'/);
  assert.match(code, /evidence\.pricing_type = 'free_entry_point'/);
  assert.match(code, /prior_billing\.billable IS DISTINCT FROM false/);
  assert.match(code, /quietHoursStatus/);
  assert.match(code, /checkTemplateAllowed|sendApprovedTemplate/);
  assert.match(code, /item.category === "MARKETING"/);
});


test("pre-activation CTWA grace remains limited to verified consenting leads", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /first_reply\.created_at >= \$1::timestamptz - interval '24 hours'/);
  assert.match(code, /c\.whatsapp_opt_in_at <= \$1::timestamptz/);
  assert.match(code, /evidence\.pricing_type = 'free_entry_point'/);
  assert.match(code, /evidence\.billable = false/);
  assert.match(code, /now\(\) >= last_inbound\.created_at \+ interval '24 hours'/);
  assert.match(code, /now\(\) < first_reply\.created_at \+ \(slot\.hours \+ 12\)/);
});

test("extended marketing candidates respect terminal stop and legacy decline decisions", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /NOT EXISTS \(\s*SELECT 1 FROM follow_up_ai_decisions d/);
  assert.match(code, /decision_anchor\.created_at >= origin\.created_at/);
  assert.match(code, /terminalFollowUpDecisionSql\("d"\)/);
  // Candidate discovery is repeated inside both the atomic claim and final
  // pre-send check so staff or customer state changes prevent stale sends.
  assert.match(code, /const fresh = \(await listCandidates\(active, client, candidate\.contact_id\)\)\[0\]/);
  assert.match(code, /await listCandidates\(liveActive, pool, candidate\.contact_id/);
});

test("extended WhatsApp templates never change the customer's chosen language", () => {
  const catalog = [
    { name: "ns_fu3_face_feedback", language: "zh_CN", status: "APPROVED", category: "MARKETING" },
    { name: "ns_fu3_face_feedback", language: "en", status: "APPROVED", category: "MARKETING" },
    { name: "ns_fu2_general_checkin", language: "ms", status: "APPROVED", category: "MARKETING" },
  ];
  assert.equal(worker.approvedInLanguage(catalog, "ns_fu3_face_feedback", "en_US")?.language, "en");
  assert.equal(worker.approvedInLanguage(catalog, "ns_fu3_face_feedback", "ms"), null);
  assert.equal(worker.approvedInLanguage(catalog, "ns_fu2_general_checkin", "ms")?.language, "ms");
});

test("extra WhatsApp reminders are selective without losing the first invitation", () => {
  const interested = {
    lead_temperature: "warm", treatment_interest: "骨盆调理",
  };
  assert.equal(worker.selectiveSlotAllowed(interested, 36), true);
  assert.equal(worker.selectiveSlotAllowed(interested, 48), true);
  assert.equal(worker.selectiveSlotAllowed(interested, 66), true);
  assert.equal(worker.selectiveSlotAllowed({ ...interested, lead_temperature: "cold" }, 48), false);
  assert.equal(worker.selectiveSlotAllowed({ lead_temperature: "warm" }, 66), false);
  assert.equal(worker.selectiveSlotAllowed({ lead_temperature: "warm" }, 36), true);
});

test("extended candidate SQL checks previously sent follow-up videos from all outbound messages", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /AS previously_sent_media_keys/);
  assert.match(code, /media\.created_at >= origin\.created_at/);
  assert.match(code, /previouslySent\.includes\(preferred\.mediaKey\)/);
  assert.match(code, /usedNames\.includes\(preferred\.templateName\)/);
  assert.match(code, /no_distinct_approved_template_in_customer_language/);
});


test("respect explicit deferral instead of automatically marketing to customers", () => {
  assert.equal(worker.customerRequestedPause({
    recent_inbound_messages: ["can I confirm tomorrow?"],
  }), true);
  assert.equal(worker.customerRequestedPause({
    recent_inbound_messages: ["我考虑一下再告诉你"],
  }), true);
  assert.equal(worker.customerRequestedPause({
    recent_inbound_messages: ["小腹凸，平时久坐"],
  }), false);
});

test("video duplicate protection is rechecked after a follow-up slot is claimed", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /Media already sent in this ad conversation/);
  assert.match(code, /SELECT DISTINCT media_key FROM messages/);
  assert.match(code, /mediaAlreadyShared\(spec\.mediaKey/);
});

test("extended follow-up detects identical bytes under different treatment video filenames", async () => {
  const one = "messages/follow-up-config/3d.mp4";
  const two = "messages/follow-up-config/9d.mp4";
  const other = "messages/follow-up-config/pelvis.mp4";
  const store = {
    isSharedFollowUpConfigKey: (key) => key.startsWith("messages/follow-up-config/"),
    getSharedFollowUpMediaInfo: async (key) => ({
      etag: key === other ? "different" : "same-video-bytes", bytes: 1000,
    }),
  };
  assert.equal(await worker.mediaAlreadyShared(one, [one], store), true);
  assert.equal(await worker.mediaAlreadyShared(one, [two], store), true);
  assert.equal(await worker.mediaAlreadyShared(one, [other], store), false);
  assert.equal(await worker.mediaAlreadyShared(one, [], store), false);
  assert.equal(await worker.mediaAlreadyShared(one, [two], {
    ...store, getSharedFollowUpMediaInfo: async () => { throw Error("R2 unavailable"); },
  }), true, "unverifiable duplicate should fall back to text instead of resending");
});

test("post-window template fallback is revalidated without counting its own pending message as earlier media", () => {
  const code = fs.readFileSync(path.join(__dirname, "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code, /media\.id IS DISTINCT FROM \$5::integer/);
  assert.match(code, /await selectEligibleTemplate\(fresh, slotHours, liveActive, templateCatalog\)/);
  assert.match(code, /resolve\(candidate, slotHours, active, catalog, \{ skipPreferred: true \}\)/);
  assert.match(code, /mediaAlreadyShared\(spec\.mediaKey/);
});


test("seven-day follow-ups work with Strict RM0 OFF only with real independent Meta proof", async () => {
  const original = clinicConfig.automatedFollowUp;
  const prior = process.env.WHATSAPP_FEP_7DAY_VERIFIED;
  try {
    process.env.WHATSAPP_FEP_7DAY_VERIFIED = "true";
    clinicConfig.automatedFollowUp = {
      ...original, whatsappFreeOnly: { enabled: false, activatedAt: null },
    };
    const slots = [48, 66, 96, 144];
    let proofLookups = 0;
    const verified = await worker.alignedSettings({ sevenDayVerified:true, slots }, {
      query: async () => {
        proofLookups++;
        return { rows: [{ verified:true }] };
      },
    });
    assert.equal(proofLookups,1);
    assert.equal(verified.sevenDayVerified,true,
      "independent post-72h nonbillable evidence allows the seven-day schedule without Strict RM0");

    const customer = {
      first_inbound_at:"2026-10-01T00:00:00Z",
      first_reply_at:"2026-10-01T00:02:00Z",
      last_inbound_at:"2026-10-01T00:00:00Z",
      evidence_type:"free_entry_point", source_is_ctwa:true,
      sevenDayVerified:verified.sevenDayVerified,
    };
    assert.equal(worker.selectedSlot(customer,slots,new Date("2026-10-05T01:05:00Z")),96);
    assert.equal(worker.selectedSlot({
      ...customer,claimed_slots:[48,66,96],
    },slots,new Date("2026-10-07T01:05:00Z")),144);
  } finally {
    clinicConfig.automatedFollowUp=original;
    if (prior === undefined) delete process.env.WHATSAPP_FEP_7DAY_VERIFIED;
    else process.env.WHATSAPP_FEP_7DAY_VERIFIED=prior;
  }
});

test("independent seven-day proof fails closed when missing, flag OFF or DB unavailable", async () => {
  const original = clinicConfig.automatedFollowUp;
  const prior = process.env.WHATSAPP_FEP_7DAY_VERIFIED;
  try {
    clinicConfig.automatedFollowUp = {
      ...original, whatsappFreeOnly: { enabled:false, activatedAt:null },
    };
    process.env.WHATSAPP_FEP_7DAY_VERIFIED="true";
    const notVerified = await worker.alignedSettings({sevenDayVerified:true}, {
      query:async () => ({rows:[{verified:false}]}),
    });
    assert.equal(notVerified.sevenDayVerified,false);
    const unavailable = await worker.alignedSettings({sevenDayVerified:true}, {
      query:async () => { throw Error("temporary Neon failure"); },
    });
    assert.equal(unavailable.sevenDayVerified,false);
    // An account-level proof outage must NOT block the already working 48h slot.
    const candidate = {
      first_inbound_at:"2026-10-01T00:00:00Z",
      first_reply_at:"2026-10-01T00:02:00Z",
      last_inbound_at:"2026-10-01T00:00:00Z",
      evidence_type:"free_entry_point",source_is_ctwa:true,
      sevenDayVerified:unavailable.sevenDayVerified,
    };
    assert.equal(worker.selectedSlot(candidate,[48,66,96,144],
      new Date("2026-10-03T00:05:00Z")),48);
    assert.equal(worker.selectedSlot(candidate,[48,66,96,144],
      new Date("2026-10-05T01:05:00Z")),null);

    process.env.WHATSAPP_FEP_7DAY_VERIFIED="false";
    let queries=0;
    const disabled=await worker.alignedSettings({sevenDayVerified:true}, {
      query:async () => { queries++; return {rows:[{verified:true}]}; },
    });
    assert.equal(disabled.sevenDayVerified,false,
      "verified account history alone does not override the explicit rollout flag");
    assert.equal(queries,0);
    const notRequested=await worker.alignedSettings({sevenDayVerified:false}, {
      query:async () => { throw Error("should not query"); },
    });
    assert.equal(notRequested.sevenDayVerified,false);
  } finally {
    clinicConfig.automatedFollowUp=original;
    if (prior === undefined) delete process.env.WHATSAPP_FEP_7DAY_VERIFIED;
    else process.env.WHATSAPP_FEP_7DAY_VERIFIED=prior;
  }
});

test("four configured extended slots are not stopped by the old three-send cap", () => {
  const code = fs.readFileSync(path.join(__dirname,
    "../src/services/whatsappFreeEntryFollowUpService.js"), "utf8");
  assert.match(code,/sent.status='accepted'\) < LEAST\(CARDINALITY\(\$4::integer\[\]\), 4\)/);
  assert.match(code,/sent.status = 'accepted'\) < LEAST\(CARDINALITY\(\$2::integer\[\]\), 4\)/);
});
