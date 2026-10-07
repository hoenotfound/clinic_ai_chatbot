const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const inboxSource = read("portal-frontend/src/pages/Inbox.jsx");
const conversationsSource = read("src/routes/conversations.js");

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

test("Inbox backend accepts iPhone video containers and normalizes non-MP4 uploads", () => {
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
    /forceTranscode: inboxVideoNeedsTranscode\(req\.file\)/
  );
  assert.match(
    conversationsSource,
    /normalizedInboxVideoFilename\(req\.file\.originalname\)/
  );
});
