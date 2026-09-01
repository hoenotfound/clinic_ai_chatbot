const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(
  path.join(__dirname, "../portal-frontend/src/pages/TeamAccess.jsx"),
  "utf8"
);

test("stale Sales branches remain visible and can be corrected explicitly", () => {
  assert.match(source, /staleBranch/);
  assert.match(source, /no longer configured/);
  assert.match(source, /choose a current branch or No fixed branch/i);
});

test("unrelated staff profile saves do not resubmit an unchanged stale branch", () => {
  assert.match(source, /const updates = \{ displayName \};/);
  assert.match(
    source,
    /staff\.role === "sales" && branchName !== savedBranchName[\s\S]*updates\.branchName = branchName/
  );
  assert.doesNotMatch(
    source,
    /const updates = \{\s*displayName,\s*branchName:/
  );
});

test("Team Access explains branch pools without implying fixed-branch reps leave the global pool", () => {
  assert.match(source, /Every eligible Sales account still participates in the global rotation/i);
  assert.match(source, /Later branch record changes never move the lead to another owner/i);
  assert.doesNotMatch(source, /No fixed branch · global fallback pool/);
});
