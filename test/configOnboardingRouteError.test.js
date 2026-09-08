const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Settings preserves the one-time onboarding conflict instead of returning a generic 500", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/routes/config.js"),
    "utf8"
  );

  assert.match(source, /const status = Number\(err\?\.status\) \|\| 500/);
  assert.match(source, /res\.status\(status\)\.json\(\{/);
  assert.match(source, /code: err\?\.code \|\| null/);
  assert.doesNotMatch(
    source,
    /catch \(err\) \{\s*console\.error\("Failed to update clinic config:", err\);\s*res\.status\(500\)\.json\(\{ error: "Something went wrong saving settings\." \}\);/
  );
});
