const DEFAULT_CONVERSION_PROFILE = Object.freeze({
  enabled: false,
  mode: "disabled",
  label: "next step",
  guidanceTitle: "THE NEXT SALES STEP",
  staffConfirmationText: "the team will review the request and follow up",
  readyExamples: [],
  notReadyExamples: [],
  alertTitle: "🔥 Lead Ready",
  attentionReason: "Conversion ready: customer is ready for the next sales step; staff should follow up.",
  activityDescription: "AI marked this conversation ready for the next sales step. Staff should review the conversation and continue from the customer's latest request.",
  alertAction: "Open the conversation, review the request, and continue the next sales step with the customer.",
});

const CONVERSION_PROFILES = Object.freeze({
  aesthetic_clinic: Object.freeze({
    enabled: true,
    mode: "appointment",
    label: "free consultation",
    guidanceTitle: "BOOKING A FREE CONSULTATION",
    staffConfirmationText: "the team will check availability and follow up shortly",
    readyExamples: [
      "Customer already wants HIFU, then says \"Puchong, Saturday afternoon works.\"",
      "Customer says \"yes book me at PJ tomorrow around 3pm.\"",
      "Customer confirms the branch and a proposed day/time after you asked for those details.",
    ],
    notReadyExamples: [
      "How much is HIFU?",
      "Can I book?",
      "Any slots this weekend?",
      "Puchong when you still do not have a day/time preference.",
      "Maybe next week or another hesitant/tentative answer.",
    ],
    alertTitle: "🔥 Booking Ready",
    attentionReason: "Booking ready: customer provided scheduling preferences; staff should confirm availability.",
    activityDescription: "AI marked this conversation Booking Ready. Staff should verify the requested branch/time and confirm availability before setting the appointment.",
    alertAction: "Open the conversation, verify the requested branch/time, and confirm the appointment availability with the customer.",
  }),
  home_renovation: Object.freeze({
    enabled: true,
    mode: "project",
    label: "site visit or quotation discussion",
    guidanceTitle: "SITE VISIT / QUOTATION NEXT STEP",
    staffConfirmationText: "the team will review the project details and confirm the next step",
    readyExamples: [
      "Customer wants kitchen cabinets in Cheras, gives the project/property context, and asks the team to prepare a quotation discussion.",
      "Customer shares a usable project location and scope, then asks to arrange a site visit.",
      "Customer has provided enough project context to continue and clearly says they want to proceed with a quotation or site visit.",
    ],
    notReadyExamples: [
      "How much per foot?",
      "Do you cover Kajang?",
      "Customer says they want kitchen cabinets but has not given a usable project location or project context.",
      "Customer asks for a site visit while the property location or project scope is still unclear.",
      "Maybe later or another hesitant/tentative answer.",
    ],
    alertTitle: "🔥 Renovation Lead Ready",
    attentionReason: "Conversion ready: customer wants to proceed with a renovation quotation or site visit and provided usable project details.",
    activityDescription: "AI marked this renovation enquiry ready for staff follow-up. Staff should review the project location/scope and continue the quotation or site-visit next step.",
    alertAction: "Open the conversation, review the project location/scope, and continue the quotation or site-visit arrangement with the customer.",
  }),
  generic: DEFAULT_CONVERSION_PROFILE,
});

function configuredText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function configuredExamples(value, fallback) {
  return Array.isArray(value) && value.length ? value : fallback;
}

function getConversionProfile(config = {}) {
  const businessType = String(config.businessType || "generic").trim();
  const base = CONVERSION_PROFILES[businessType] || DEFAULT_CONVERSION_PROFILE;
  const configured = config.conversion || {};

  // bookingReadyEnabled is a compatibility control retained from the clinic
  // implementation. Existing clinic deployments can still explicitly disable
  // that executable outcome. Renovation intentionally does not inherit the old
  // false value because PR96 stored it only as a temporary safety gate before
  // an industry-aware conversion contract existed.
  const enabled = businessType === "aesthetic_clinic"
    ? base.enabled && configured.bookingReadyEnabled !== false
    : base.enabled;

  return {
    ...base,
    enabled,
    label: configuredText(configured.label, base.label),
    guidanceTitle: configuredText(configured.guidanceTitle, base.guidanceTitle),
    staffConfirmationText: configuredText(
      configured.staffConfirmationText,
      base.staffConfirmationText
    ),
    readyExamples: configuredExamples(configured.readyExamples, base.readyExamples),
    notReadyExamples: configuredExamples(configured.notReadyExamples, base.notReadyExamples),
  };
}

module.exports = {
  CONVERSION_PROFILES,
  DEFAULT_CONVERSION_PROFILE,
  getConversionProfile,
};
