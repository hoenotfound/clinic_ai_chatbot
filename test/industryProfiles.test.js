const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_BUSINESS_TYPE,
  getIndustryProfile,
  getRequestedInitialBusinessType,
  hydrateBusinessConfig,
  normalizeBusinessType,
} = require("../src/config/industryProfiles");

test("existing deployments keep aesthetic clinic as the safe default", () => {
  assert.equal(DEFAULT_BUSINESS_TYPE, "aesthetic_clinic");
  assert.equal(getRequestedInitialBusinessType({}), "aesthetic_clinic");
});

test("common industry aliases normalize to the supported profile", () => {
  assert.equal(normalizeBusinessType("clinic"), "aesthetic_clinic");
  assert.equal(normalizeBusinessType("Home Renovation"), "home_renovation");
  assert.equal(normalizeBusinessType("carpentry"), "home_renovation");
  assert.equal(normalizeBusinessType("business"), "generic");
});

test("invalid explicit initial industry fails closed instead of seeding the wrong business", () => {
  assert.throws(
    () => getRequestedInitialBusinessType({ INITIAL_BUSINESS_TYPE: "restaurant" }),
    /Unsupported INITIAL_BUSINESS_TYPE/
  );
});

test("home renovation starts neutral and never inherits Beleco treatment data", () => {
  const profile = getIndustryProfile("home_renovation");
  const serialized = JSON.stringify(profile).toLowerCase();

  assert.equal(profile.businessType, "home_renovation");
  assert.equal(profile.conversion.bookingReadyEnabled, false);
  assert.deepEqual(profile.services, []);
  assert.deepEqual(profile.branches, []);
  assert.doesNotMatch(serialized, /beleco/);
  assert.doesNotMatch(serialized, /hifu/);
  assert.doesNotMatch(serialized, /aesthetics clinic/);
  assert.match(profile.closingPlaybook, /quotation discussion/i);
  assert.match(profile.closingPlaybook, /site visit/i);
});

test("generic starts neutral without clinic or renovation client facts", () => {
  const profile = getIndustryProfile("generic");
  const serialized = JSON.stringify(profile).toLowerCase();

  assert.equal(profile.businessType, "generic");
  assert.equal(profile.conversion.bookingReadyEnabled, false);
  assert.deepEqual(profile.services, []);
  assert.deepEqual(profile.branches, []);
  assert.deepEqual(profile.promotions, []);
  assert.deepEqual(profile.faqs, []);
  assert.doesNotMatch(serialized, /beleco/);
  assert.doesNotMatch(serialized, /hifu/);
});

test("legacy stored clinic config is inferred as aesthetic clinic and preserved", () => {
  const stored = {
    clinicName: "Existing Clinic",
    services: [
      {
        name: "Existing Service",
        description: "Existing description",
        priceRange: "RM 100",
        duration: "30 mins",
      },
    ],
  };

  const hydrated = hydrateBusinessConfig(stored, {
    INITIAL_BUSINESS_TYPE: "home_renovation",
  });

  assert.equal(hydrated.businessType, "aesthetic_clinic");
  assert.equal(hydrated.businessName, "Existing Clinic");
  assert.equal(hydrated.clinicName, "Existing Clinic");
  assert.deepEqual(hydrated.services, stored.services);
  assert.equal(hydrated.conversion.bookingReadyEnabled, true);
});

test("stored industry and configured values win over deployment defaults", () => {
  const stored = {
    businessType: "home_renovation",
    businessName: "ABC Cabinet",
    clinicName: "ABC Cabinet",
    businessDescription: "Custom cabinetry specialist",
    services: [
      {
        name: "Kitchen Cabinets",
        description: "Custom kitchen cabinetry",
        priceRange: "Quotation required",
        duration: "Depends on scope",
      },
    ],
    hours: {
      general: "Mon-Sat 10am-6pm",
      closed: "Sunday",
    },
  };

  const hydrated = hydrateBusinessConfig(stored, {
    INITIAL_BUSINESS_TYPE: "aesthetic_clinic",
  });

  assert.equal(hydrated.businessType, "home_renovation");
  assert.equal(hydrated.businessName, "ABC Cabinet");
  assert.equal(hydrated.businessDescription, "Custom cabinetry specialist");
  assert.deepEqual(hydrated.services, stored.services);
  assert.deepEqual(hydrated.hours, stored.hours);
  assert.equal(hydrated.conversion.bookingReadyEnabled, false);
});

test("neutral businessName is canonical and repairs a stale legacy clinicName alias", () => {
  const hydrated = hydrateBusinessConfig({
    businessType: "home_renovation",
    businessName: "New Renovation Name",
    clinicName: "Old Clinic Alias",
  });

  assert.equal(hydrated.businessName, "New Renovation Name");
  assert.equal(hydrated.clinicName, "New Renovation Name");
});
