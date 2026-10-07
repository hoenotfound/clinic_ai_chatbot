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
const preparationSource = read("src/services/followUpVideoPreparationService.js");
const toolsSource = read("portal-frontend/src/pages/Tools.jsx");

test("Inbox video picker keeps iOS file selection broad but only accepts MP4 for sending", () => {
  assert.match(inboxSource, /accept="\.mp4,video\/\*"/);
  assert.match(
    inboxSource,
    /INBOX_VIDEO_EXTENSIONS = new Set\(\["mp4"\]\)/
  );
  assert.match(
    inboxSource,
    /MAX_INBOX_VIDEO_BYTES = 16 \* 1024 \* 1024/
  );
  assert.match(
    inboxSource,
    /WhatsApp requires H\.264 video with AAC audio/
  );
  assert.doesNotMatch(inboxSource, /Will compress automatically/);
});

test("Inbox backend validates compatible MP4 without a transcode path", () => {
  assert.match(
    conversationsSource,
    /INBOX_VIDEO_EXTENSIONS = new Set\(\["mp4"\]\)/
  );
  assert.match(
    conversationsSource,
    /ensureWhatsAppCompatible: true/
  );
  assert.doesNotMatch(
    conversationsSource,
    /forceTranscode:/
  );
  assert.doesNotMatch(
    conversationsSource,
    /normalizeStoredWhatsAppVideoForRetry/
  );
});

test("historical codec-rejected videos require a compatible re-upload on Retry", () => {
  assert.match(
    conversationsSource,
    /isKnownWhatsAppVideoCodecFailure/
  );
  assert.match(
    conversationsSource,
    /video_requires_compatible_reupload/
  );
  assert.match(
    conversationsSource,
    /Please send a new MP4 exported as H\.264 video with AAC audio and keep it under 16MB/
  );
});

test("follow-up video upload is validation-only and capped at 16MB", () => {
  assert.match(
    configSource,
    /ensureWhatsAppCompatible: true/
  );
  assert.match(
    toolsSource,
    /MAX_FOLLOW_UP_VIDEO_BYTES = 16 \* 1024 \* 1024/
  );
  assert.match(
    toolsSource,
    /Automatic video compression is disabled/
  );
});

test("video preparation service contains no encoder or compression implementation", () => {
  assert.doesNotMatch(preparationSource, /libx264/);
  assert.doesNotMatch(preparationSource, /transcodeWhatsAppVideo/);
  assert.doesNotMatch(preparationSource, /createCompressionQueue/);
  assert.doesNotMatch(preparationSource, /bitratePlan/);
  assert.doesNotMatch(preparationSource, /FOLLOW_UP_VIDEO_COMPRESSION_TIMEOUT/);
});
