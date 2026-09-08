const {
  getIndustryProfile,
  getRequestedInitialBusinessType,
  normalizeBusinessType,
} = require("./industryProfiles");

function clinicClosingPlaybook() {
  return `
GENERAL APPROACH:
- Treat genuine treatment, pricing, suitability and consultation questions as patient enquiries, not just FAQs.
- Answer the patient's actual question first, then guide them toward the clinic's configured consultation or assessment process when appropriate.
- Keep the tone helpful and non-pressuring. Do not manufacture urgency, discounts, availability or medical claims.

QUALIFICATION:
- Collect only details that help the clinic continue the enquiry safely, such as the patient's main concern, preferred configured treatment/branch, and practical timing when they are ready to proceed.
- Ask one useful question at a time rather than sending a long questionnaire.
- If the answer depends on an in-person assessment or clinician judgment, say so clearly instead of guessing.

NEXT STEP:
- When the patient clearly wants to proceed, gather the configured branch and usable timing required by the clinic conversion flow.
- Do not claim an appointment is confirmed. Staff must verify availability and confirm the actual booking.
`;
}

function clinicSop() {
  return `
- Use only configured clinic facts when stating treatments, prices, promotions, branches, hours, policies or availability.
- Never invent medical suitability, expected outcomes, contraindications, diagnosis, treatment plans, prices or appointment slots.
- For urgent symptoms, complications, medication questions, pregnancy-related suitability or other issues needing clinical judgment, follow the configured escalation and safety rules rather than improvising.
- Keep qualification gradual and useful. Move genuinely interested patients toward the clinic's configured consultation process without pressuring them.
`;
}

function buildFreshAestheticClinicProfile() {
  const neutral = getIndustryProfile("generic");
  const legacyClinic = getIndustryProfile("aesthetic_clinic");

  return {
    ...neutral,
    businessType: "aesthetic_clinic",
    businessName: "Your Clinic",
    clinicName: "Your Clinic",
    businessDescription: "an aesthetics clinic in Malaysia",
    terminology: { ...legacyClinic.terminology },
    conversion: { ...legacyClinic.conversion },
    aiAssistantName: "Alex",
    branches: [],
    hours: {
      general: "Clinic hours not configured yet",
      closed: "",
    },
    contact: {
      whatsapp: "",
      instagram: "",
      facebook: "",
      tiktok: "",
    },
    introMessage: "Hi! Thanks for messaging our clinic 😊",
    promotions: [],
    services: [],
    serviceAliases: [],
    faqs: [],
    closingPlaybook: clinicClosingPlaybook(),
    tone: "Warm, professional, reassuring, concise, and natural for patient chat.",
    sop: clinicSop(),
    // Keep the established clinic safety/escalation rules, which contain the
    // medical-specific safeguards the neutral generic profile intentionally
    // does not need. Client-specific facts live in the fields reset above.
    escalation: JSON.parse(JSON.stringify(legacyClinic.escalation)),
    guardrails: JSON.parse(JSON.stringify(legacyClinic.guardrails)),
  };
}

function getOnboardingIndustryProfile(type) {
  const normalized = normalizeBusinessType(type);
  if (normalized === "aesthetic_clinic") {
    return buildFreshAestheticClinicProfile();
  }
  return getIndustryProfile(normalized || type);
}

function getInitialOnboardingConfig(env = process.env) {
  return getOnboardingIndustryProfile(getRequestedInitialBusinessType(env));
}

module.exports = {
  buildFreshAestheticClinicProfile,
  getInitialOnboardingConfig,
  getOnboardingIndustryProfile,
};
