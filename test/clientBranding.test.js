const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEFAULT_LOGIN_TAGLINE,
  buildClientBranding,
  buildWebAppManifest,
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


test("web app manifest uses exact client app-icon sizes for installable identity", () => {
  const manifest = buildWebAppManifest(
    { businessName: "Neutro Sense TCM" },
    {
      CLIENT_APP_ICON_192_URL: "https://cdn.example.com/neutro-192.png",
      CLIENT_APP_ICON_512_URL: "https://cdn.example.com/neutro-512.png",
    }
  );

  assert.equal(manifest.name, "Neutro Sense TCM");
  assert.equal(manifest.short_name, "Neutro Sense TCM");
  assert.equal(manifest.start_url, "/login");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#0f172a");
  assert.deepEqual(manifest.icons, [
    {
      src: "https://cdn.example.com/neutro-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "https://cdn.example.com/neutro-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
  ]);
});

test("web app manifest falls back to packaged DA icons when client install icons are missing or unsafe", () => {
  const unsafe = buildWebAppManifest(
    { businessName: "Test Clinic" },
    {
      CLIENT_APP_ICON_192_URL: "javascript:alert(1)",
      CLIENT_APP_ICON_512_URL: "http://example.com/icon.png",
    }
  );
  const missing = buildWebAppManifest(
    { businessName: "Test Clinic" },
    {}
  );

  const expected = [
    {
      src: "/app-icons/da-chatbot-192.png",
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: "/app-icons/da-chatbot-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "any",
    },
  ];
  assert.deepEqual(unsafe.icons, expected);
  assert.deepEqual(missing.icons, expected);
});

test("branding exposes only sanitized dedicated app-icon URLs", () => {
  const branding = buildClientBranding({}, {
    CLIENT_APP_ICON_180_URL: "https://cdn.example.com/app-180.png",
    CLIENT_APP_ICON_192_URL: "/client-assets/app-192.png",
    CLIENT_APP_ICON_512_URL: "javascript:alert(1)",
  });

  assert.equal(branding.clientAppIcon180Url, "https://cdn.example.com/app-180.png");
  assert.equal(branding.clientAppIcon192Url, "/client-assets/app-192.png");
  assert.equal(branding.clientAppIcon512Url, "");
});


function readPngDimensions(filePath) {
  const bytes = fs.readFileSync(filePath);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

test("packaged DA fallback icons have the exact declared PNG dimensions", () => {
  const publicDir = path.join(__dirname, "../portal-frontend/public/app-icons");
  assert.deepEqual(
    readPngDimensions(path.join(publicDir, "da-chatbot-180.png")),
    { width: 180, height: 180 }
  );
  assert.deepEqual(
    readPngDimensions(path.join(publicDir, "da-chatbot-192.png")),
    { width: 192, height: 192 }
  );
  assert.deepEqual(
    readPngDimensions(path.join(publicDir, "da-chatbot-512.png")),
    { width: 512, height: 512 }
  );
});
