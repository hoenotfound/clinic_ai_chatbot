const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");
const conversationsSource = read("src/routes/conversations.js");
const configSource = read("src/routes/config.js");

test("Inbox video picker does not restrict iOS Files to exact video/mp4 MIME", () => {
  assert.match(
    inboxSource,
    /accept="video\/\*,\.mp4,\.mov,\.m4v"/
  );
  assert.match(
    inboxSource,
    /INBOX_VIDEO_EXTENSIONS = new Set\(\["mp4", "mov", "m4v"\]\)/
  );
  assert.match(
    inboxSource,
    /type\.startsWith\("video\/"\)\s*\|\|\s*INBOX_VIDEO_EXTENSIONS\.has\(extension\)/
  );
});

test("Inbox backend accepts iPhone containers and checks codec compatibility before sending", () => {
  assert.match(
    conversationsSource,
    /INBOX_VIDEO_EXTENSIONS = new Set\(\["mp4", "mov", "m4v"\]\)/
  );
  assert.match(
    conversationsSource,
    /if \(!isAllowedInboxVideo\(file\)\)/
  );
  assert.match(
    conversationsSource,
    /forceTranscode: inboxVideoNeedsContainerNormalization\(req\.file\)/
  );
  assert.match(
    conversationsSource,
    /ensureWhatsAppCompatible: true/
  );
  assert.match(
    conversationsSource,
    /normalizedInboxVideoFilename\(req\.file\.originalname\)/
  );
});


test("configured follow-up videos are normalized before reuse", () => {
  assert.match(
    configSource,
    /prepareFollowUpVideoFile\([\s\S]*ensureWhatsAppCompatible: true/
  );
  assert.match(
    configSource,
    /transcoded: prepared\.transcoded === true/
  );
});


test("Retry repairs historical WhatsApp codec-rejected videos before resending", () => {
  assert.match(
    conversationsSource,
    /shouldNormalizeStoredWhatsAppVideoForRetry/
  );
  assert.match(
    conversationsSource,
    /Video file uploaded with mimetype\|\(\?:videoCodec\|audioCodec\)\\s\*=/
  );
  assert.match(
    conversationsSource,
    /normalizeStoredWhatsAppVideoForRetry[\s\S]*forceTranscode: true/
  );
  assert.match(
    conversationsSource,
    /await normalizeStoredWhatsAppVideoForRetry\(contact, message\)/
  );
});
