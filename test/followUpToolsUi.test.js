const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

test("follow-up tools use a unified media picker and collapsible additional steps", () => {
  const source = read("portal-frontend/src/pages/Tools.jsx");

  assert.match(source, /function FollowUpMediaPicker\(/);
  assert.match(source, /No media/);
  assert.match(source, /Follow-up 1 media/);
  assert.match(source, /Keep them collapsed when you are not editing them/);
  assert.match(source, /Preview Follow-up/);
  assert.match(source, /Toggle follow-up preview/);
  assert.match(source, /Sending rules/);
  assert.match(source, /order-2 space-y-5 xl:order-1/);
  assert.match(source, /order-1 xl:order-2 xl:sticky/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1\.3fr\)_minmax\(19rem,0\.7fr\)\]/);
  assert.doesNotMatch(source, />Sequence<\/h2>/);
  assert.doesNotMatch(source, /function followUpMediaSummary/);
});

test("follow-up video preview stays private and validates stored keys", () => {
  const source = read("src/routes/config.js");

  assert.match(source, /router\.get\("\/automated-follow-up\/video-preview"/);
  assert.match(source, /!key \|\| !isFollowUpVideoKey\(key\)/);
  assert.match(source, /mediaStorage\.downloadMedia\(key/);
  assert.match(source, /Cache-Control", "private, no-store"/);
  assert.match(source, /Content-Disposition", "inline"/);
});
