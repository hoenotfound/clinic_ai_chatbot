const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("result-media uploads are private from the moment they are stored", () => {
  const route = read("src/routes/config.js");
  const repo = read("src/db/promoImagesRepo.js");
  const migration = read("src/db/migrations/032_private_result_media.sql");

  assert.match(
    route,
    /purpose:\s*promoImagesRepo\.IMAGE_PURPOSES\.RESULT_MEDIA/
  );
  assert.match(route, /privatePreview:\s*true/);
  assert.match(
    route,
    /url:\s*`\/api\/config\/result-media\/image\/\$\{id\}`/
  );
  assert.match(repo, /RESULT_MEDIA:\s*"result_media"/);
  assert.match(
    migration,
    /purpose IN \('public_config', 'result_media'\)/
  );
});

test("private result-media previews require portal authentication and are never served by the public route", () => {
  const app = read("src/createApp.js");
  const route = read("src/routes/config.js");

  assert.match(
    app,
    /app\.use\("\/api\/config", requireAuth, configRoutes\)/
  );
  assert.match(
    app,
    /app\.get\("\/promo-images\/:id"[\s\S]*promoImagesRepo\.getPublicImage/
  );
  assert.match(
    route,
    /router\.get\("\/result-media\/image\/:id"[\s\S]*IMAGE_PURPOSES\.RESULT_MEDIA/
  );
  assert.match(route, /Cache-Control", "private, no-store"/);
});

test("stored result media is delivered through provider uploads instead of permanent public URLs", () => {
  const messaging = read("src/services/channelMessagingService.js");

  assert.match(
    messaging,
    /api\\\/config\\\/result-media\\\/image/
  );
  assert.match(
    messaging,
    /return sendImageBuffer\([\s\S]*Buffer\.from\(image\.data, "base64"\)/
  );
  assert.match(
    messaging,
    /whatsapp\.uploadMedia\([\s\S]*whatsapp\.sendImageById/
  );
  assert.match(
    messaging,
    /uploadTemporaryMedia\([\s\S]*sendUrlAttachment/
  );
});

test("legacy result-media URLs are reclassified and normalized to the private preview path", () => {
  const configRepo = read("src/db/configRepo.js");
  const migration = read("src/db/migrations/032_private_result_media.sql");

  assert.match(
    configRepo,
    /promoImagesRepo\.markResultMedia\(resultImageIds, client\)/
  );
  assert.match(
    configRepo,
    /\/api\/config\/result-media\/image\/\$\{id\}/
  );
  assert.match(migration, /ADD COLUMN IF NOT EXISTS purpose/);
  assert.match(migration, /SET purpose = 'result_media'/);
  assert.match(migration, /config->'resultMedia'/);
  assert.match(migration, /FROM config_import_snapshots/);
});
