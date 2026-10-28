"use strict";

// PR #411 release gate. No secrets, no database or Meta/Render writes.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

const PROD = "c13d82192c5acca938fdf2a6b7da415004f0a46e";
const ROLLBACK = "9e05a529170a1ea6c51bf93a84eae1f16c5d9dcb";
const BRANCH = "refs/remotes/origin/safety/neutro-cloudapi-rollback-v079-20261028";
const FILES = [
  "src/db/migrations/078_sales_follow_up_tasks.sql",
  "src/db/migrations/079_sales_follow_up_corrections.sql"
];
function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
try {
  // An actual retrievable, pinned rollback commit is required, not just a
  // document claiming old code can be rolled back.
  let sha;
  try { sha = git("rev-parse", BRANCH); } catch (_) {
    git("fetch", "--no-tags", "origin",
      "refs/heads/safety/neutro-cloudapi-rollback-v079-20261028:" + BRANCH);
    sha = git("rev-parse", BRANCH);
  }
  assert.equal(sha, ROLLBACK, "rollback source moved without a new review");
  assert.equal(git("merge-base", PROD, ROLLBACK), PROD,
    "rollback build must descend from the exact working Neutro commit");
  const changed = git("diff", "--name-only", PROD, ROLLBACK).split("\n").filter(Boolean);
  assert.deepEqual(changed, FILES,
    "rollback candidate must contain exactly the two additive migrations");
  assert.equal(git("rev-parse", PROD + ":src/createApp.js"),
    git("rev-parse", ROLLBACK + ":src/createApp.js"),
    "rollback must preserve the original Cloud API webhook source");
  assert.equal(git("rev-parse", PROD + ":src/db/migrationRunner.js"),
    git("rev-parse", ROLLBACK + ":src/db/migrationRunner.js"),
    "rollback must preserve the original strict migration runner");
  for (const file of FILES) {
    assert.equal(git("rev-parse", "HEAD:" + file),
      git("rev-parse", ROLLBACK + ":" + file),
      "release and rollback migration contents/checksums must match: " + file);
  }
  console.log("PASS: working Neutro code + exact 078/079 migration history is pinned for rollback");
} catch (error) {
  console.error("FAIL: Neutro rollback compatibility: " + error.message);
  process.exitCode = 1;
}
