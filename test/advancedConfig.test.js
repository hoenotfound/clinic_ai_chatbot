const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  prepareConfigUpdatePayload,
} = require("../src/routes/config");
const {
  EDITABLE_KEYS,
  buildConfigDiff,
  buildLineDiff,
  configFingerprint,
  tokenizeDiffText,
  editableConfigView,
  restorableEditableConfigView,
  prepareAdvancedConfigPayload,
} = require("../src/routes/advancedConfig");
const {
  MAX_CONFIG_IMPORT_SNAPSHOTS,
  collectPromoImageIds,
  listReferencedPromoImageIds,
  pruneOldSnapshots,
} = require("../src/db/configImportHistoryRepo");
const { getIndustryProfile } = require("../src/config/industryProfiles");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function currentConfig() {
  return {
    businessName: "Test Clinic",
    clinicName: "Test Clinic",
    businessDescription: "Clinic description",
    aiAssistantName: "Ava",
    introMessage: "Hello",
    tone: "Warm",
    messagingStyle: "Short replies",
    closingPlaybook: "Guide naturally",
    sop: "Follow SOP",
    hours: { general: "Mon-Fri", closed: "Sun" },
    contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
    branches: [{ name: "HQ", address: "KL", phone: "" }],
    serviceAreas: [],
    promotions: [],
    resultMedia: [],
    services: [{ name: "Consultation", description: "", priceRange: "", duration: "" }],
    serviceAliases: [],
    faqs: [],
    escalation: { outOfScopeTriggers: ["Complaint"], handoffMessage: "Staff will help.", handoffNote: "" },
    guardrails: ["Do not invent facts."],
    automatedFollowUp: {
      enabled: false,
      delayMinutes: 10,
      triggerMode: "all",
      message: "Following up",
      translations: { en: "Following up", ms: "Following up", zh: "Following up" },
      imageUrl: "",
      activatedAt: null,
    },
    commentAutomation: {
      enabled: false,
      facebookEnabled: false,
      instagramEnabled: false,
      publicReplyEnabled: false,
      privateReplyEnabled: false,
      publicReplyStyle: "ai",
      fixedPublicReply: "",
      skipEmojiOnly: true,
      skipNestedReplies: true,
      activatedAt: null,
    },
    leadScoring: {
      enabled: false,
      inactivityMinutes: 10,
      maxConversationMinutes: 60,
      maxMessages: 40,
      activatedAt: null,
    },
    leadDistribution: {
      enabled: false,
      strategy: "round_robin",
      assignByBranch: true,
    },
    businessType: "aesthetic_clinic",
    industrySetup: { locked: true },
    clientSetup: { requiredComplete: true },
  };
}

test("shared config preparation accepts partial editable JSON and rejects internal keys", () => {
  const current = currentConfig();

  const partial = prepareConfigUpdatePayload(
    { tone: "Short and friendly", faqs: [{ q: "Price?", a: "Ask us for the latest price." }] },
    current
  );
  assert.equal(partial.ok, true);
  assert.equal(partial.updates.tone, "Short and friendly");
  assert.deepEqual(partial.updates.faqs, [{ q: "Price?", a: "Ask us for the latest price." }]);

  const internal = prepareConfigUpdatePayload(
    { businessType: "tcm_clinic", industrySetup: { locked: false } },
    current
  );
  assert.equal(internal.ok, false);
  assert.deepEqual(internal.unknownKeys, ["businessType", "industrySetup"]);
});

test("follow-up config accepts a targeted sequence and keeps legacy one-step payloads compatible", () => {
  const current = currentConfig();

  const legacy = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        triggerMode: "all",
        message: "Checking in",
        translations: {
          en: "Checking in",
          ms: "Checking in",
          zh: "Checking in",
        },
        imageUrl: "",
      },
    },
    current
  );
  assert.equal(legacy.ok, true);
  assert.equal(legacy.updates.automatedFollowUp.messageMode, "fixed");
  assert.equal(legacy.updates.automatedFollowUp.aiInstruction, "");
  assert.deepEqual(legacy.updates.automatedFollowUp.serviceOverrides, []);
  assert.deepEqual(legacy.updates.automatedFollowUp.additionalSteps, []);
  assert.deepEqual(legacy.updates.automatedFollowUp.quietHours, {
    enabled: true,
    start: "00:00",
    end: "07:00",
  });

  const sequence = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        triggerMode: "all",
        message: "Checking in",
        translations: {
          en: "Checking in",
          ms: "Checking in",
          zh: "Checking in",
        },
        imageUrl: "",
        serviceOverrides: [
          {
            serviceName: "Consultation",
            message: "Consultation follow-up",
            translations: {
              en: "Consultation follow-up",
              ms: "Susulan konsultasi",
              zh: "咨询跟进",
            },
          },
        ],
        additionalSteps: [
          {
            delayMinutes: 480,
            message: "Second follow-up",
            translations: {
              en: "Second follow-up",
              ms: "Susulan kedua",
              zh: "第二次跟进",
            },
            imageUrl: "",
            serviceOverrides: [],
          },
          {
            delayMinutes: 1200,
            message: "Final follow-up",
            translations: {
              en: "Final follow-up",
              ms: "Susulan terakhir",
              zh: "最后一次跟进",
            },
            imageUrl: "",
            serviceOverrides: [],
          },
        ],
      },
    },
    current
  );

  assert.equal(sequence.ok, true);
  assert.equal(sequence.updates.automatedFollowUp.additionalSteps.length, 2);
  assert.equal(
    sequence.updates.automatedFollowUp.serviceOverrides[0].serviceName,
    "Consultation"
  );

  const outOfOrder = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...sequence.updates.automatedFollowUp,
        additionalSteps: [
          {
            ...sequence.updates.automatedFollowUp.additionalSteps[0],
            delayMinutes: 60,
          },
        ],
      },
    },
    current
  );
  assert.equal(outOfOrder.ok, false);
  assert.match(outOfOrder.error, /increasing delays/i);

  const aiMode = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...sequence.updates.automatedFollowUp,
        messageMode: "ai",
        aiInstruction: "Continue from the unresolved concern without being pushy.",
      },
    },
    current
  );
  assert.equal(aiMode.ok, true);
  assert.equal(aiMode.updates.automatedFollowUp.messageMode, "ai");
  assert.equal(
    aiMode.updates.automatedFollowUp.aiInstruction,
    "Continue from the unresolved concern without being pushy."
  );
});

test("follow-up quiet hours validate and do not reset an active sequence", () => {
  const current = currentConfig();
  current.automatedFollowUp = {
    ...current.automatedFollowUp,
    enabled: true,
    activatedAt: "2026-10-01T00:00:00.000Z",
  };

  const changed = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
        quietHours: {
          enabled: true,
          start: "00:00",
          end: "07:00",
        },
      },
    },
    current
  );
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.updates.automatedFollowUp.quietHours, {
    enabled: true,
    start: "00:00",
    end: "07:00",
  });
  assert.equal(
    changed.updates.automatedFollowUp.activatedAt,
    current.automatedFollowUp.activatedAt
  );

  const invalid = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
        quietHours: {
          enabled: true,
          start: "07:00",
          end: "07:00",
        },
      },
    },
    current
  );
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /automated follow-up settings/i);
});

test("follow-up service targeting cannot reference removed or unknown services", () => {
  const current = currentConfig();
  current.automatedFollowUp = {
    ...current.automatedFollowUp,
    serviceOverrides: [
      {
        serviceName: "Consultation",
        message: "Consultation follow-up",
        translations: {
          en: "Consultation follow-up",
          ms: "Susulan konsultasi",
          zh: "咨询跟进",
        },
      },
    ],
    additionalSteps: [],
  };

  const renameBreaksTargeting = prepareConfigUpdatePayload(
    {
      services: [
        {
          name: "Renamed Consultation",
          description: "",
          priceRange: "",
          duration: "",
        },
      ],
    },
    current
  );
  assert.equal(renameBreaksTargeting.ok, false);
  assert.deepEqual(renameBreaksTargeting.invalidKeys, ["automatedFollowUp"]);
  assert.match(renameBreaksTargeting.error, /Consultation/);
  assert.match(renameBreaksTargeting.error, /remap or remove/i);

  const unknownTarget = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
        serviceOverrides: [
          {
            serviceName: "Missing Service",
            message: "Missing service follow-up",
            translations: {
              en: "Missing service follow-up",
              ms: "Susulan servis",
              zh: "服务跟进",
            },
          },
        ],
      },
    },
    current
  );
  assert.equal(unknownTarget.ok, false);
  assert.deepEqual(unknownTarget.invalidKeys, ["automatedFollowUp"]);
});

test("changing follow-up timing starts a fresh activation window", () => {
  const current = currentConfig();
  current.automatedFollowUp = {
    ...current.automatedFollowUp,
    enabled: true,
    activatedAt: "2026-10-01T00:00:00.000Z",
  };

  const sameSchedule = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
      },
    },
    current
  );
  assert.equal(sameSchedule.ok, true);
  assert.equal(
    sameSchedule.updates.automatedFollowUp.activatedAt,
    "2026-10-01T00:00:00.000Z"
  );

  const expandedSchedule = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
        additionalSteps: [
          {
            delayMinutes: 480,
            message: "Second follow-up",
            translations: {
              en: "Second follow-up",
              ms: "Susulan kedua",
              zh: "第二次跟进",
            },
            imageUrl: "",
            serviceOverrides: [],
          },
        ],
      },
    },
    current
  );
  assert.equal(expandedSchedule.ok, true);
  assert.notEqual(
    expandedSchedule.updates.automatedFollowUp.activatedAt,
    current.automatedFollowUp.activatedAt
  );
  assert.ok(
    Date.parse(expandedSchedule.updates.automatedFollowUp.activatedAt) >
      Date.parse(current.automatedFollowUp.activatedAt)
  );
});

test("changing follow-up trigger mode starts a fresh activation window", () => {
  const current = currentConfig();
  current.automatedFollowUp = {
    ...current.automatedFollowUp,
    enabled: true,
    triggerMode: "staff",
    activatedAt: "2026-10-01T00:00:00.000Z",
  };

  const changedMode = prepareConfigUpdatePayload(
    {
      automatedFollowUp: {
        ...current.automatedFollowUp,
        triggerMode: "all",
      },
    },
    current
  );

  assert.equal(changedMode.ok, true);
  assert.notEqual(
    changedMode.updates.automatedFollowUp.activatedAt,
    current.automatedFollowUp.activatedAt
  );
  assert.ok(
    Date.parse(changedMode.updates.automatedFollowUp.activatedAt) >
      Date.parse(current.automatedFollowUp.activatedAt)
  );
});

test("Advanced Config exposes business and AI content only", () => {
  const current = currentConfig();
  const editable = editableConfigView(current);

  assert.equal(editable.businessName, "Test Clinic");
  for (const excludedKey of [
    "clinicName",
    "businessType",
    "industrySetup",
    "clientSetup",
    "automatedFollowUp",
    "commentAutomation",
    "leadScoring",
    "leadDistribution",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(editable, excludedKey),
      false,
      `${excludedKey} must stay out of Advanced Config`
    );
    assert.equal(EDITABLE_KEYS.includes(excludedKey), false);
  }

  const changes = buildConfigDiff(current, { businessName: "New Clinic" });
  assert.deepEqual(changes.map((change) => change.key), ["businessName"]);

  for (const excludedKey of [
    "automatedFollowUp",
    "commentAutomation",
    "leadScoring",
    "leadDistribution",
    "clinicName",
  ]) {
    const rejected = prepareAdvancedConfigPayload(
      { [excludedKey]: excludedKey === "clinicName" ? "Legacy Name" : current[excludedKey] },
      current
    );
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.unknownKeys, [excludedKey]);
  }
});

test("Advanced Config enforces handoff rules and protected industry guardrails", () => {
  const current = currentConfig();
  current.businessType = "generic";
  const protectedRule = getIndustryProfile("generic").guardrails[0];
  current.guardrails = [protectedRule, "Custom client rule"];

  const removedProtected = prepareAdvancedConfigPayload(
    { guardrails: ["Custom client rule"] },
    current
  );
  assert.equal(removedProtected.ok, false);
  assert.deepEqual(removedProtected.invalidKeys, ["guardrails"]);
  assert.match(removedProtected.error, /cannot be removed/i);

  const emptyGuardrails = prepareAdvancedConfigPayload({ guardrails: [] }, current);
  assert.equal(emptyGuardrails.ok, false);
  assert.deepEqual(emptyGuardrails.invalidKeys, ["guardrails"]);

  const emptyMessage = prepareAdvancedConfigPayload(
    {
      escalation: {
        ...current.escalation,
        handoffMessage: "   ",
      },
    },
    current
  );
  assert.equal(emptyMessage.ok, false);
  assert.deepEqual(emptyMessage.invalidKeys, ["escalation"]);

  const emptyTriggers = prepareAdvancedConfigPayload(
    {
      escalation: {
        ...current.escalation,
        outOfScopeTriggers: ["  "],
      },
    },
    current
  );
  assert.equal(emptyTriggers.ok, false);
  assert.deepEqual(emptyTriggers.invalidKeys, ["escalation"]);

  const valid = prepareAdvancedConfigPayload(
    {
      guardrails: [protectedRule, "Updated custom rule"],
      escalation: {
        ...current.escalation,
        outOfScopeTriggers: ["Refund request"],
        handoffMessage: "A team member will help you.",
      },
    },
    current
  );
  assert.equal(valid.ok, true);
});

test("Advanced Config matches core Settings validation for business details, hours, contact, and clinic branches", () => {
  const current = currentConfig();

  const blankDescription = prepareAdvancedConfigPayload(
    { businessDescription: "   " },
    current
  );
  assert.equal(blankDescription.ok, false);
  assert.deepEqual(blankDescription.invalidKeys, ["businessDescription"]);
  assert.match(blankDescription.error, /description can't be empty/i);

  const blankHours = prepareAdvancedConfigPayload(
    { hours: { general: "   ", closed: "Sunday" } },
    current
  );
  assert.equal(blankHours.ok, false);
  assert.deepEqual(blankHours.invalidKeys, ["hours"]);
  assert.match(blankHours.error, /opening hours can't be empty/i);

  const badWhatsapp = prepareAdvancedConfigPayload(
    {
      contact: {
        whatsapp: "not-a-whatsapp-contact",
        instagram: "",
        facebook: "",
        tiktok: "",
      },
    },
    current
  );
  assert.equal(badWhatsapp.ok, false);
  assert.deepEqual(badWhatsapp.invalidKeys, ["contact"]);
  assert.match(badWhatsapp.error, /valid WhatsApp number or WhatsApp link/i);

  const validWhatsappNumber = prepareAdvancedConfigPayload(
    {
      contact: {
        whatsapp: "+60 12-345 6789",
        instagram: "",
        facebook: "",
        tiktok: "",
      },
    },
    current
  );
  assert.equal(validWhatsappNumber.ok, true);

  const validWhatsappLink = prepareAdvancedConfigPayload(
    {
      contact: {
        whatsapp: "https://wa.me/60123456789",
        instagram: "",
        facebook: "",
        tiktok: "",
      },
    },
    current
  );
  assert.equal(validWhatsappLink.ok, true);

  for (const businessType of ["aesthetic_clinic", "tcm_clinic"]) {
    const clinic = { ...current, businessType };
    const missingAddress = prepareAdvancedConfigPayload(
      { branches: [{ name: "HQ", address: "   ", phone: "" }] },
      clinic
    );
    assert.equal(missingAddress.ok, false);
    assert.deepEqual(missingAddress.invalidKeys, ["branches"]);
    assert.match(missingAddress.error, /clinic branch needs an address/i);
  }

  const renovation = { ...current, businessType: "home_renovation" };
  const renovationWithoutAddress = prepareAdvancedConfigPayload(
    { branches: [{ name: "Showroom", address: "", phone: "" }] },
    renovation
  );
  assert.equal(renovationWithoutAddress.ok, true);

  const legacyBlankDescription = { ...current, businessDescription: "" };
  const unrelatedPartialUpdate = prepareAdvancedConfigPayload(
    { tone: "Short and friendly" },
    legacyBlankDescription
  );
  assert.equal(
    unrelatedPartialUpdate.ok,
    true,
    "an unrelated partial import should not be blocked by pre-existing legacy data"
  );
});

test("Advanced Config enforces alias, FAQ, and promotion integrity across partial imports", () => {
  const current = currentConfig();

  const badAlias = prepareAdvancedConfigPayload(
    { serviceAliases: [{ alias: "facial", officialService: "Missing service" }] },
    current
  );
  assert.equal(badAlias.ok, false);
  assert.deepEqual(badAlias.invalidKeys, ["serviceAliases"]);

  const blankAliasTarget = prepareAdvancedConfigPayload(
    { serviceAliases: [{ alias: "facial", officialService: "   " }] },
    current
  );
  assert.equal(blankAliasTarget.ok, false);
  assert.deepEqual(blankAliasTarget.invalidKeys, ["serviceAliases"]);

  const validServiceAndAlias = prepareAdvancedConfigPayload(
    {
      services: [
        ...current.services,
        { name: "Facial", description: "Deep cleanse", priceRange: "RM100", duration: "60 min" },
      ],
      serviceAliases: [{ alias: "deep clean", officialService: "Facial" }],
    },
    current
  );
  assert.equal(validServiceAndAlias.ok, true);

  const blankFaq = prepareAdvancedConfigPayload(
    { faqs: [{ q: "How much?", a: "   " }] },
    current
  );
  assert.equal(blankFaq.ok, false);
  assert.deepEqual(blankFaq.invalidKeys, ["faqs"]);

  const invalidDate = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "October Promo",
        imageUrl: "",
        caption: "Promo",
        validFrom: "01-10-2026",
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(invalidDate.ok, false);
  assert.deepEqual(invalidDate.invalidKeys, ["promotions"]);

  const pricePromoMissingService = prepareConfigUpdatePayload(
    {
      promotions: [{
        name: "Consultation Promo",
        linkedService: "",
        sendOnPriceQuery: true,
        imageUrl: "https://example.com/promo.jpg",
        caption: "RM88",
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(pricePromoMissingService.ok, false);
  assert.deepEqual(pricePromoMissingService.invalidKeys, ["promotions"]);

  const configWithLinkedPromo = currentConfig();
  configWithLinkedPromo.promotions = [{
    name: "Consultation Promo",
    linkedService: "Consultation",
    sendOnPriceQuery: true,
    imageUrl: "https://example.com/promo.jpg",
    caption: "RM88",
    validFrom: null,
    validUntil: null,
  }];
  const serviceRenameBreaksPromo = prepareConfigUpdatePayload(
    {
      services: [{ name: "Renamed Consultation", description: "", priceRange: "", duration: "" }],
    },
    configWithLinkedPromo
  );
  assert.equal(serviceRenameBreaksPromo.ok, false);
  assert.deepEqual(serviceRenameBreaksPromo.invalidKeys, ["promotions"]);

  const pricePromoMissingImage = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Promo",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "",
        caption: "RM88",
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(pricePromoMissingImage.ok, false);
  assert.deepEqual(pricePromoMissingImage.invalidKeys, ["promotions"]);

  const validPricePromo = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Promo",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "https://example.com/promo.jpg",
        caption: "RM88",
        validFrom: "2026-10-01",
        validUntil: "2026-10-31",
      }],
    },
    current
  );
  assert.equal(validPricePromo.ok, true);

  const validPackagePromotion = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Packages",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "",
        caption: "",
        packages: [
          {
            name: "Package A",
            title: "Basic",
            aliases: ["A"],
            imageUrl: "https://example.com/package-a.jpg",
            caption: "Package A RM88",
          },
          {
            name: "Package B",
            title: "Premium",
            aliases: ["B"],
            imageUrl: "https://example.com/package-b.jpg",
            caption: "Package B RM188",
          },
        ],
        validFrom: "2026-10-01",
        validUntil: "2026-10-31",
      }],
    },
    current
  );
  assert.equal(validPackagePromotion.ok, true);

  const packageWithoutOptionalTitleOrAliases = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Packages Minimal",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "",
        caption: "",
        packages: [{
          name: "Package A",
          imageUrl: "https://example.com/package-a-minimal.jpg",
          caption: "Package A RM88",
        }],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(packageWithoutOptionalTitleOrAliases.ok, true);

  const packageMissingMedia = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Packages",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "",
        caption: "",
        packages: [{
          name: "Package A",
          title: "Basic",
          aliases: ["A"],
          imageUrl: "",
          caption: "Package A RM88",
        }],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(packageMissingMedia.ok, false);
  assert.deepEqual(packageMissingMedia.invalidKeys, ["promotions"]);

  const ambiguousPackageAliases = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Packages",
        linkedService: "Consultation",
        sendOnPriceQuery: true,
        imageUrl: "",
        caption: "",
        packages: [
          {
            name: "Package A",
            title: "",
            aliases: ["same"],
            imageUrl: "https://example.com/a.jpg",
            caption: "A",
          },
          {
            name: "Package B",
            title: "",
            aliases: ["same"],
            imageUrl: "https://example.com/b.jpg",
            caption: "B",
          },
        ],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(ambiguousPackageAliases.ok, false);
  assert.deepEqual(ambiguousPackageAliases.invalidKeys, ["promotions"]);
  assert.match(ambiguousPackageAliases.error, /ambiguous/i);

  const followUpMissingService = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Manual Follow-up Promo",
        linkedService: "",
        sendOnPriceQuery: false,
        imageUrl: "",
        caption: "",
        followUpMessage: "Delayed offer",
        packages: [],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(followUpMissingService.ok, false);
  assert.deepEqual(followUpMissingService.invalidKeys, ["promotions"]);
  assert.match(followUpMissingService.error, /follow-up copy must link/i);

  const packageFollowUpMissingService = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Manual Package Follow-up Promo",
        linkedService: "",
        sendOnPriceQuery: false,
        imageUrl: "",
        caption: "",
        packages: [{
          name: "Package A",
          title: "Basic",
          aliases: ["A"],
          imageUrl: "",
          caption: "A",
          followUpMessage: "Delayed package offer",
        }],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(packageFollowUpMissingService.ok, false);
  assert.deepEqual(packageFollowUpMissingService.invalidKeys, ["promotions"]);
  assert.match(packageFollowUpMissingService.error, /follow-up copy must link/i);

  const ambiguousManualPackageAliases = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "Consultation Packages Manual",
        linkedService: "Consultation",
        sendOnPriceQuery: false,
        imageUrl: "",
        caption: "",
        packages: [
          {
            name: "Package A",
            title: "",
            aliases: ["same"],
            imageUrl: "",
            caption: "A",
            followUpMessage: "A follow-up",
          },
          {
            name: "Package B",
            title: "",
            aliases: ["same"],
            imageUrl: "",
            caption: "B",
            followUpMessage: "B follow-up",
          },
        ],
        validFrom: null,
        validUntil: null,
      }],
    },
    current
  );
  assert.equal(ambiguousManualPackageAliases.ok, false);
  assert.deepEqual(ambiguousManualPackageAliases.invalidKeys, ["promotions"]);
  assert.match(ambiguousManualPackageAliases.error, /ambiguous/i);

  const overlappingPricePromos = prepareConfigUpdatePayload(
    {
      promotions: [
        {
          name: "Consultation Early October",
          linkedService: "Consultation",
          sendOnPriceQuery: true,
          imageUrl: "https://example.com/promo-a.jpg",
          caption: "RM88",
          validFrom: "2026-10-01",
          validUntil: "2026-10-15",
        },
        {
          name: "Consultation Mid October",
          linkedService: "Consultation",
          sendOnPriceQuery: true,
          imageUrl: "https://example.com/promo-b.jpg",
          caption: "RM98",
          validFrom: "2026-10-15",
          validUntil: "2026-10-31",
        },
      ],
    },
    current
  );
  assert.equal(overlappingPricePromos.ok, false);
  assert.deepEqual(overlappingPricePromos.invalidKeys, ["promotions"]);
  assert.match(overlappingPricePromos.error, /only one automatic price promotion/i);
  assert.match(overlappingPricePromos.error, /Consultation Early October/);
  assert.match(overlappingPricePromos.error, /Consultation Mid October/);

  const scheduledPricePromos = prepareConfigUpdatePayload(
    {
      promotions: [
        {
          name: "Consultation October",
          linkedService: "Consultation",
          sendOnPriceQuery: true,
          imageUrl: "https://example.com/promo-oct.jpg",
          caption: "RM88",
          validFrom: "2026-10-01",
          validUntil: "2026-10-31",
        },
        {
          name: "Consultation November",
          linkedService: "Consultation",
          sendOnPriceQuery: true,
          imageUrl: "https://example.com/promo-nov.jpg",
          caption: "RM98",
          validFrom: "2026-11-01",
          validUntil: "2026-11-30",
        },
      ],
    },
    current
  );
  assert.equal(scheduledPricePromos.ok, true);

  const reversedDates = prepareAdvancedConfigPayload(
    {
      promotions: [{
        name: "October Promo",
        imageUrl: "",
        caption: "Promo",
        validFrom: "2026-10-20",
        validUntil: "2026-10-01",
      }],
    },
    current
  );
  assert.equal(reversedDates.ok, false);
  assert.deepEqual(reversedDates.invalidKeys, ["promotions"]);
  assert.match(reversedDates.error, /cannot be before/i);
});

test("Advanced Config review reports field-level collection changes", () => {
  const current = currentConfig();
  current.branches = [{ name: "HQ", address: "Old address", phone: "", whatsapp: null }];
  current.services = [
    { name: "Consultation", description: "Old", priceRange: "RM50", duration: "30 min" },
  ];
  current.serviceAliases = [{ alias: "consult", officialService: "Consultation" }];
  current.faqs = [{ q: "Price?", a: "Old answer" }];
  current.promotions = [{
    name: "Old Promo",
    imageUrl: "",
    caption: "Old",
    validFrom: null,
    validUntil: null,
  }];

  const changes = buildConfigDiff(current, {
    branches: [
      { name: "HQ", address: "New address", phone: "", whatsapp: null },
      { name: "PJ", address: "PJ", phone: "", whatsapp: null },
    ],
    services: [
      { name: "Consultation", description: "Updated description", priceRange: "RM50", duration: "30 min" },
      { name: "Facial", description: "New", priceRange: "RM100", duration: "60 min" },
    ],
    serviceAliases: [{ alias: "consult", officialService: "Facial" }],
    faqs: [
      { q: "Price?", a: "New answer with more detail" },
      { q: "Hours?", a: "Daily" },
    ],
    promotions: [{
      name: "New Promo",
      imageUrl: "",
      caption: "New",
      validFrom: null,
      validUntil: null,
    }],
  });

  const byKey = Object.fromEntries(changes.map((change) => [change.key, change]));

  assert.equal(byKey.branches.details.kind, "collection");
  assert.equal(byKey.branches.details.added[0].identity, "PJ");
  assert.equal(byKey.branches.details.added[0].item.address, "PJ");
  assert.equal(byKey.branches.details.updated[0].identity, "HQ");
  assert.deepEqual(
    byKey.branches.details.updated[0].changes.map((change) => change.field),
    ["address"]
  );

  assert.equal(byKey.services.details.added[0].identity, "Facial");
  assert.deepEqual(byKey.services.details.added[0].item, {
    description: "New",
    priceRange: "RM100",
    duration: "60 min",
  });
  const serviceUpdate = byKey.services.details.updated[0];
  assert.equal(serviceUpdate.identity, "Consultation");
  assert.equal(serviceUpdate.changes[0].field, "description");
  assert.equal(serviceUpdate.changes[0].textDiff.kind, "text");
  assert.equal(serviceUpdate.changes[0].textDiff.mode, "words");

  const aliasUpdate = byKey.serviceAliases.details.updated[0];
  assert.equal(aliasUpdate.identity, "consult");
  assert.equal(aliasUpdate.changes[0].field, "officialService");
  assert.equal(aliasUpdate.changes[0].after, "Facial");

  assert.equal(byKey.faqs.details.added[0].identity, "Hours?");
  assert.equal(byKey.faqs.details.added[0].item.a, "Daily");
  const faqUpdate = byKey.faqs.details.updated[0];
  assert.equal(faqUpdate.identity, "Price?");
  assert.equal(faqUpdate.changes[0].field, "a");
  assert.equal(faqUpdate.changes[0].textDiff.mode, "words");

  assert.equal(byKey.promotions.details.added[0].identity, "New Promo");
  assert.equal(byKey.promotions.details.removed[0].identity, "Old Promo");
});


test("Advanced Config review shows promotion follow-up copy changes", () => {
  const current = currentConfig();
  current.promotions = [{
    name: "October Promo",
    linkedService: "Consultation",
    sendOnPriceQuery: false,
    imageUrl: "",
    caption: "RM88",
    followUpMessage: "Old follow-up",
    validFrom: "2026-10-01",
    validUntil: "2026-10-31",
  }];

  const changes = buildConfigDiff(current, {
    promotions: [{
      ...current.promotions[0],
      followUpMessage: "New follow-up",
    }],
  });

  const promotionChange = changes.find((change) => change.key === "promotions");
  assert.equal(promotionChange.details.kind, "collection");
  assert.deepEqual(
    promotionChange.details.updated[0].changes.map((change) => change.field),
    ["followUpMessage"]
  );
  assert.equal(
    promotionChange.details.updated[0].changes[0].textDiff.kind,
    "text"
  );
});

test("Advanced Config preserves full long FAQ identities in review payloads", () => {
  const current = currentConfig();
  const longQuestion = "我明明不胖可是小腹一直很凸，而且站久了腰容易酸，裤子左右穿起来也不太一样，这种情况是不是跟骨盆或体态有关，应该先做什么评估比较适合我？另外我平时坐办公室很久，生完孩子后身形也有变化，我想知道这种情况到底应该先看骨盆、体态还是其他问题，会不会需要先做一对一评估再决定适合的护理？";
  assert.ok(longQuestion.length > 88);

  current.faqs = [{ q: longQuestion, a: "旧答案" }];
  const changes = buildConfigDiff(current, {
    faqs: [{ q: longQuestion, a: "新的完整答案，会先了解你的情况再建议合适的评估。" }],
  });

  const faqChange = changes.find((change) => change.key === "faqs");
  assert.equal(faqChange.details.kind, "collection");
  assert.equal(faqChange.details.updated[0].identity, longQuestion);
  assert.equal(faqChange.details.updated[0].identity.endsWith("…"), false);
});

test("Advanced Config reports pure guardrail and service-area reordering meaningfully", () => {
  const current = currentConfig();
  current.guardrails = ["Rule A", "Rule B", "Rule C"];
  current.serviceAreas = ["Cheras", "Balakong", "Serdang"];

  const changes = buildConfigDiff(current, {
    guardrails: ["Rule C", "Rule A", "Rule B"],
    serviceAreas: ["Serdang", "Cheras", "Balakong"],
  });
  const byKey = Object.fromEntries(changes.map((change) => [change.key, change]));

  assert.deepEqual(byKey.guardrails.details, {
    kind: "string_list",
    added: [],
    removed: [],
    orderChanged: true,
    beforeOrder: ["Rule A", "Rule B", "Rule C"],
    afterOrder: ["Rule C", "Rule A", "Rule B"],
  });
  assert.deepEqual(byKey.serviceAreas.details, {
    kind: "string_list",
    added: [],
    removed: [],
    orderChanged: true,
    beforeOrder: ["Cheras", "Balakong", "Serdang"],
    afterOrder: ["Serdang", "Cheras", "Balakong"],
  });
});

test("Advanced Config review produces readable text, guardrail, and handoff diffs", () => {
  const current = currentConfig();
  current.businessDescription = "A clinic focused on posture and wellness.";
  current.sop = [
    "BUSINESS FACTS",
    "Use configured information only.",
    "Ask one question at a time.",
  ].join("\n");
  current.guardrails = ["Do not invent facts.", "Do not guarantee results."];
  current.escalation = {
    outOfScopeTriggers: ["Complaint"],
    handoffMessage: "A staff member will help.",
    handoffNote: "Check the conversation.",
  };

  const changes = buildConfigDiff(current, {
    businessDescription: "A clinic focused on pelvic care and wellness.",
    sop: [
      "BUSINESS FACTS",
      "Use configured information only.",
      "Ask one focused question at a time.",
    ].join("\n"),
    guardrails: [
      "Do not invent facts.",
      "Do not guarantee results.",
      "Do not diagnose medical conditions.",
    ],
    escalation: {
      outOfScopeTriggers: ["Complaint", "Severe pain"],
      handoffMessage: "A team member will help you shortly.",
      handoffNote: "Check the conversation.",
    },
  });

  const byKey = Object.fromEntries(changes.map((change) => [change.key, change]));

  assert.equal(byKey.businessDescription.details.kind, "text");
  assert.equal(byKey.businessDescription.details.mode, "words");
  assert.ok(byKey.businessDescription.details.segments.some((segment) => segment.type === "added"));
  assert.ok(byKey.businessDescription.details.segments.some((segment) => segment.type === "removed"));

  assert.equal(byKey.sop.details.kind, "text");
  assert.equal(byKey.sop.details.mode, "lines");
  assert.ok(
    byKey.sop.details.segments.some(
      (segment) => segment.type === "added" && segment.lines.includes("Ask one focused question at a time.")
    )
  );

  assert.deepEqual(byKey.guardrails.details, {
    kind: "string_list",
    added: ["Do not diagnose medical conditions."],
    removed: [],
  });

  assert.equal(byKey.escalation.details.kind, "object");
  const handoffFields = Object.fromEntries(
    byKey.escalation.details.changes.map((change) => [change.field, change])
  );
  assert.deepEqual(handoffFields.outOfScopeTriggers.details, {
    kind: "string_list",
    added: ["Severe pain"],
    removed: [],
  });
  assert.equal(handoffFields.handoffMessage.textDiff.mode, "words");
});

test("text diff tokenization highlights Mandarin changes instead of replacing the whole sentence", () => {
  assert.deepEqual(
    tokenizeDiffText("我腰很酸，适合什么？"),
    ["我", "腰", "很", "酸", "，", "适", "合", "什", "么", "？"]
  );

  const diff = buildLineDiff("我腰酸，适合什么？", "我腰很酸，适合什么？");
  assert.equal(diff.mode, "words");
  assert.ok(
    diff.segments.some(
      (segment) => segment.type === "added" && segment.text.includes("很")
    )
  );
  assert.ok(
    diff.segments.some(
      (segment) => segment.type === "same" && segment.text.includes("我腰")
    )
  );
});

test("line diff keeps unchanged context while marking additions and removals", () => {
  const diff = buildLineDiff(
    "Line one\nOld instruction\nLine three",
    "Line one\nNew instruction\nLine three"
  );
  assert.equal(diff.kind, "text");
  assert.equal(diff.mode, "lines");
  assert.ok(diff.segments.some((segment) => segment.type === "removed"));
  assert.ok(diff.segments.some((segment) => segment.type === "added"));
  assert.ok(diff.segments.some((segment) => segment.type === "same"));
});

test("Advanced Config fingerprint is stable for equivalent nested object key order", () => {
  const left = currentConfig();
  const right = currentConfig();
  left.hours = { general: "Mon-Fri", closed: "Sun" };
  right.hours = { closed: "Sun", general: "Mon-Fri" };

  assert.equal(configFingerprint(left), configFingerprint(right));
});

test("Advanced Config snapshot retention keeps at most 50 newest backups", async () => {
  assert.equal(MAX_CONFIG_IMPORT_SNAPSHOTS, 50);
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };

  await pruneOldSnapshots(database);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /DELETE FROM config_import_snapshots/);
  assert.match(calls[0].sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(calls[0].sql, /OFFSET \$1/);
  assert.deepEqual(calls[0].params, [50]);

  const repo = read("src/db/configImportHistoryRepo.js");
  assert.match(repo, /await client\.query\("BEGIN"\)/);
  assert.match(repo, /await pruneOldSnapshots\(client\)/);
  assert.match(repo, /await client\.query\("COMMIT"\)/);
});



test("config image cleanup includes retained snapshot image references", () => {
  const configRepoSource = read("src/db/configRepo.js");
  assert.match(
    configRepoSource,
    /configImportHistoryRepo\.listReferencedPromoImageIds\(\)/
  );
  assert.match(
    configRepoSource,
    /promoImagesRepo\.pruneUnreferenced\(\[\.\.\.new Set\(referencedIds\)\]\)/
  );
});

test("retained Advanced Config snapshots protect their stored image URLs from cleanup", async () => {
  const database = {
    async query(sql, params) {
      assert.match(sql, /SELECT editable_config/);
      assert.match(sql, /FROM config_import_snapshots/);
      assert.match(sql, /LIMIT \$1/);
      assert.deepEqual(params, [MAX_CONFIG_IMPORT_SNAPSHOTS]);
      return {
        rows: [
          {
            editable_config: {
              promotions: [{
                imageUrl: "https://example.test/promo-images/101",
                packages: [{
                  imageUrl: "https://example.test/promo-images/102?cache=1",
                }],
              }],
              resultMedia: [{
                service: "Consultation",
                items: [{
                  imageUrl: "https://example.test/promo-images/103#result",
                }],
              }],
            },
          },
          {
            editable_config: {
              automatedFollowUp: {
                imageUrl: "https://example.test/promo-images/104/",
              },
              duplicateReference: "https://example.test/promo-images/101",
              externalImage: "https://cdn.example.test/image.jpg",
            },
          },
        ],
      };
    },
  };

  assert.deepEqual(
    (await listReferencedPromoImageIds(database)).sort((a, b) => a - b),
    [101, 102, 103, 104]
  );
});

test("snapshot image reference extraction walks nested arrays and ignores invalid URLs", () => {
  const ids = collectPromoImageIds({
    one: "https://host.test/promo-images/12",
    nested: [
      "https://host.test/promo-images/13?x=1",
      { value: "prefix /promo-images/14#fragment" },
      "/promo-images/not-a-number",
      null,
    ],
  });

  assert.deepEqual([...ids].sort((a, b) => a - b), [12, 13, 14]);
});

test("Advanced Config is admin-only, snapshots imports, and rejects stale previews", () => {
  const route = read("src/routes/advancedConfig.js");
  const migration = read("src/db/migrations/026_config_import_snapshots.sql");
  const createApp = read("src/createApp.js");

  assert.match(route, /router\.use\(requireAdministrator\)/);
  assert.match(route, /req\.user\?\.role !== "admin"/);
  assert.match(route, /CONFIG_PREVIEW_STALE/);
  assert.match(route, /reason: "before_json_import"/);
  assert.match(route, /reason: "before_restore"/);
  assert.match(route, /configImportHistoryRepo\.createSnapshot/);
  assert.match(route, /configRepo\.updateConfig\(prepared\.updates\)/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS config_import_snapshots/);
  assert.match(createApp, /app\.use\("\/api\/advanced-config", requireAuth, advancedConfigRoutes\)/);
  assert.match(createApp, /createAdvancedConfigJsonParser/);
  assert.match(createApp, /req\.path === "\/advanced-config"/);
  assert.match(createApp, /req\.path\.startsWith\("\/advanced-config\/"\)/);
});

test("Advanced Config portal route stays admin-only and exposes validate, apply, and restore APIs", () => {
  const app = read("portal-frontend/src/App.jsx");
  const page = read("portal-frontend/src/pages/AdvancedConfig.jsx");
  const api = read("portal-frontend/src/api.js");
  const layout = read("portal-frontend/src/components/SettingsSectionLayout.jsx");
  const settings = read("portal-frontend/src/pages/Settings.jsx");

  assert.match(app, /path="\/settings\/advanced-config"[\s\S]*<ProtectedRoute adminOnly>/);
  assert.match(layout, /label: "Advanced Config"/);
  assert.match(settings, /label: "Advanced Config", to: "\/settings\/advanced-config"/);
  assert.match(page, /Partial JSON is supported/);
  assert.match(page, /Validate & review/);
  assert.match(page, /Import history/);
  assert.match(page, /function CollectionDiff/);
  assert.match(page, /function TextDiff/);
  assert.match(page, /function ChangeSection/);
  assert.match(page, /reviewSummary/);
  assert.match(page, /Apply changes/);
  assert.match(page, /Automation Tools settings are intentionally excluded/);
  assert.match(page, /Up to 50 snapshots are retained/);
  assert.match(page, /refreshUser/);
  assert.match(api, /getAdvancedConfig/);
  assert.match(api, /previewAdvancedConfig/);
  assert.match(api, /applyAdvancedConfig/);
  assert.match(api, /restoreAdvancedConfig/);
});


test("result media config is editable, service-linked, complete and unique", () => {
  const current = currentConfig();
  const validSet = {
    service: "Consultation",
    enabled: true,
    sendAfterPrice: true,
    autoSendCount: 1,
    items: [
      {
        imageUrl: "https://example.test/before-after.jpg",
        caption: "Example result. Individual results vary.",
      },
    ],
  };

  const valid = prepareAdvancedConfigPayload(
    { resultMedia: [validSet] },
    current
  );
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.updates.resultMedia, [validSet]);
  assert.equal(EDITABLE_KEYS.includes("resultMedia"), true);

  const unknownService = prepareAdvancedConfigPayload(
    {
      resultMedia: [{
        ...validSet,
        service: "Missing Treatment",
      }],
    },
    current
  );
  assert.equal(unknownService.ok, false);
  assert.deepEqual(unknownService.invalidKeys, ["resultMedia"]);
  assert.match(unknownService.error, /currently configured service/i);

  const incomplete = prepareAdvancedConfigPayload(
    {
      resultMedia: [{
        ...validSet,
        items: [{ imageUrl: "https://example.test/result.jpg", caption: "" }],
      }],
    },
    current
  );
  assert.equal(incomplete.ok, false);
  assert.deepEqual(incomplete.invalidKeys, ["resultMedia"]);

  const duplicateService = prepareAdvancedConfigPayload(
    {
      resultMedia: [
        validSet,
        {
          ...validSet,
          items: [{
            imageUrl: "https://example.test/result-2.jpg",
            caption: "Second example",
          }],
        },
      ],
    },
    current
  );
  assert.equal(duplicateService.ok, false);
  assert.deepEqual(duplicateService.invalidKeys, ["resultMedia"]);
  assert.match(duplicateService.error, /only one result media set/i);
});

test("removing a service is blocked while result media still targets it", () => {
  const current = currentConfig();
  current.resultMedia = [{
    service: "Consultation",
    enabled: true,
    sendAfterPrice: true,
    autoSendCount: 1,
    items: [{
      imageUrl: "https://example.test/result.jpg",
      caption: "Example result",
    }],
  }];

  const renamedService = prepareConfigUpdatePayload(
    {
      services: [{
        name: "Renamed Consultation",
        description: "",
        priceRange: "",
        duration: "",
      }],
    },
    current
  );

  assert.equal(renamedService.ok, false);
  assert.deepEqual(renamedService.invalidKeys, ["resultMedia"]);
  assert.match(renamedService.error, /currently configured service/i);
});


test("legacy Advanced Config snapshots restore result media to the old disabled state", () => {
  const legacySnapshot = editableConfigView(currentConfig());
  delete legacySnapshot.resultMedia;

  const restored = restorableEditableConfigView(legacySnapshot);
  assert.deepEqual(restored.resultMedia, []);

  const modernSnapshot = {
    ...legacySnapshot,
    resultMedia: [{
      service: "Consultation",
      enabled: true,
      sendAfterPrice: true,
      autoSendCount: 1,
      items: [{
        imageUrl: "https://example.test/result.jpg",
        caption: "Example result",
      }],
    }],
  };
  assert.deepEqual(
    restorableEditableConfigView(modernSnapshot).resultMedia,
    modernSnapshot.resultMedia
  );
});


test("result media accepts new trigger modes while preserving legacy snapshots", () => {
  const current = currentConfig();
  const baseSet = {
    service: "Consultation",
    enabled: true,
    autoSendCount: 1,
    items: [{
      imageUrl: "https://example.test/result.jpg",
      caption: "Example result",
    }],
  };

  for (const triggerMode of ["service_enquiry", "price_only", "off"]) {
    const prepared = prepareAdvancedConfigPayload(
      { resultMedia: [{ ...baseSet, triggerMode }] },
      current
    );
    assert.equal(prepared.ok, true, triggerMode);
  }

  const legacy = prepareAdvancedConfigPayload(
    { resultMedia: [{ ...baseSet, sendAfterPrice: true }] },
    current
  );
  assert.equal(legacy.ok, true);

  const invalid = prepareAdvancedConfigPayload(
    { resultMedia: [{ ...baseSet, triggerMode: "always" }] },
    current
  );
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.invalidKeys, ["resultMedia"]);
});


test("config repository normalizes legacy result-media triggers without changing old behavior", () => {
  const source = read("src/db/configRepo.js");
  assert.match(
    source,
    /entry\?\.sendAfterPrice === true\s*\? "price_only"\s*:\s*"off"/
  );
  assert.match(
    source,
    /\["off", "price_only", "service_enquiry"\]\.includes\(configuredMode\)/
  );
  assert.match(
    source,
    /const \{ sendAfterPrice: _legacySendAfterPrice, \.\.\.rest \} = entry \|\| \{\}/
  );
});
