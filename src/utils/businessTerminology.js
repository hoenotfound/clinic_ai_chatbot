const DEFAULT_TERMINOLOGY = Object.freeze({
  customerSingular: "customer",
  customerPlural: "customers",
  serviceSingular: "service",
  servicePlural: "services",
  locationSingular: "location",
  locationPlural: "locations",
});

function configuredText(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}

function capitalizeTerm(value) {
  const text = configuredText(value, "customer");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function getBusinessTerminology(config = {}) {
  const configured = config?.terminology || {};
  return {
    businessType: configuredText(config?.businessType, "generic"),
    customerSingular: configuredText(
      configured.customerSingular,
      DEFAULT_TERMINOLOGY.customerSingular
    ),
    customerPlural: configuredText(
      configured.customerPlural,
      DEFAULT_TERMINOLOGY.customerPlural
    ),
    serviceSingular: configuredText(
      configured.serviceSingular,
      DEFAULT_TERMINOLOGY.serviceSingular
    ),
    servicePlural: configuredText(
      configured.servicePlural,
      DEFAULT_TERMINOLOGY.servicePlural
    ),
    locationSingular: configuredText(
      configured.locationSingular,
      DEFAULT_TERMINOLOGY.locationSingular
    ),
    locationPlural: configuredText(
      configured.locationPlural,
      DEFAULT_TERMINOLOGY.locationPlural
    ),
  };
}

function getOperationalLabels(config = {}) {
  const terms = getBusinessTerminology(config);
  const clinic = terms.businessType === "aesthetic_clinic";
  return {
    ...terms,
    customerLabel: capitalizeTerm(terms.customerSingular),
    serviceInterestLabel: clinic ? "Treatment" : "Service",
    locationLabel: clinic ? "Branch" : "Business location",
    nextStepTimingLabel: clinic ? "Appointment" : "Next-step timing",
  };
}

module.exports = {
  DEFAULT_TERMINOLOGY,
  capitalizeTerm,
  getBusinessTerminology,
  getOperationalLabels,
};
