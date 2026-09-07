const DEFAULT_CONVERSION_PROFILE = Object.freeze({
  enabled: false,
  mode: "disabled",
  label: "next step",
  guidanceTitle: "THE NEXT SALES STEP",
  staffConfirmationText: "the team will review the request and follow up",
  readyExamples: [],
  notReadyExamples: [],
  requirements: Object.freeze({}),
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
    requirements: Object.freeze({}),
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
      "Customer wants configured kitchen cabinets in Cheras, gives usable project context, and asks the team to continue with a quotation discussion.",
      "Customer shares a configured renovation service, usable project location and scope, then asks for a site visit and gives a preferred day/time.",
      "Customer has provided enough current project context to continue, the requested configured service is known, and the exact quotation/site-visit next step is clear.",
    ],
    notReadyExamples: [
      "How much per foot?",
      "Do you cover Kajang?",
      "Customer wants renovation work but the requested service does not map to a configured renovation service.",
      "Customer says they want kitchen cabinets but has not given a usable project location or project context.",
      "Customer asks for a site visit but has not provided a usable preferred day/time yet.",
      "Maybe later or another hesitant/tentative answer.",
    ],
    requirements: Object.freeze({
      quotation_discussion: Object.freeze([
        "treatment",
        "projectLocation",
        "projectSummary",
      ]),
      site_visit: Object.freeze([
        "treatment",
        "projectLocation",
        "projectSummary",
        "appointmentPreference",
      ]),
    }),
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

function configuredEnabled(base, configured, businessType) {
  // conversionReadyEnabled is the neutral override for current/future profiles.
  // When it is absent, preserve the historical clinic bookingReadyEnabled
  // behavior and each industry's default conversion contract.
  if (configured.conversionReadyEnabled === true) return base.enabled;
  if (configured.conversionReadyEnabled === false) return false;

  if (businessType === "aesthetic_clinic") {
    return base.enabled && configured.bookingReadyEnabled !== false;
  }

  // Renovation intentionally does not inherit PR96's temporary
  // bookingReadyEnabled:false gate. That value pre-dates the project-specific
  // conversion contract and remains only for compatibility with the old clinic
  // implementation.
  return base.enabled;
}

function getConversionProfile(config = {}) {
  const businessType = String(config.businessType || "generic").trim();
  const base = CONVERSION_PROFILES[businessType] || DEFAULT_CONVERSION_PROFILE;
  const configured = config.conversion || {};

  return {
    ...base,
    enabled: configuredEnabled(base, configured, businessType),
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
