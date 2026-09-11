const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_LOGIN_TAGLINE,
  buildClientBranding,
  humanizeClientSlug,
  safeLogoUrl,
} = require("../src/services/clientBrandingService");
const {
  getInitialOnboardingConfig,
} = require("../src/config/onboardingIndustryProfiles");

test("saved real business name is the branding source of truth", () => {
  const branding = buildClientBranding(
    { businessName: "Acme Renovation" },
    {
      CLIENT_DISPLAY_NAME: "Old Provisioning Name",
      CLIENT_SLUG: "acme-renovation",
    }
  );

  assert.equal(branding.clientName, "Acme Renovation");
});

test("fresh placeholder business name falls back to provisioned display name", () => {
  for (const placeholder of ["Your Clinic", "Your Renovation Business", "Your Business"]) {
    const branding = buildClientBranding(
      { businessName: placeholder },
      { CLIENT_DISPLAY_NAME: "Client Company" }
    );
    assert.equal(branding.clientName, "Client Company");
  }
});

test("client slug is humanized when no saved or provisioned display name exists", () => {
  assert.equal(humanizeClientSlug("abc-home_renovation"), "Abc Home Renovation");
  assert.equal(
    buildClientBranding({}, { CLIENT_SLUG: "abc-home-renovation" }).clientName,
    "Abc Home Renovation"
  );
});

test("branding only accepts HTTPS or root-relative logo URLs", () => {
  assert.equal(safeLogoUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(safeLogoUrl("/client-assets/logo.png"), "/client-assets/logo.png");
  assert.equal(safeLogoUrl("http://example.com/logo.png"), "");
  assert.equal(safeLogoUrl("javascript:alert(1)"), "");
  assert.equal(safeLogoUrl("data:image/svg+xml,unsafe"), "");
  assert.equal(safeLogoUrl("//example.com/logo.png"), "");
});

test("branding uses a generic login tagline unless the client overrides it", () => {
  assert.equal(buildClientBranding({}, {}).loginTagline, DEFAULT_LOGIN_TAGLINE);
  assert.equal(
    buildClientBranding({}, { CLIENT_LOGIN_TAGLINE: "Staff sign in" }).loginTagline,
    "Staff sign in"
  );
});

test("provisioned display name seeds only the fresh client identity", () => {
  const config = getInitialOnboardingConfig({
    INITIAL_BUSINESS_TYPE: "generic",
    CLIENT_DISPLAY_NAME: "Acme Holdings",
  });

  assert.equal(config.businessName, "Acme Holdings");
  assert.equal(config.clinicName, "Acme Holdings");
  assert.deepEqual(config.services, []);
  assert.deepEqual(config.promotions, []);
  assert.deepEqual(config.branches, []);
});
