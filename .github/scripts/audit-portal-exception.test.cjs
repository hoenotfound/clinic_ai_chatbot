"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateKnownDevOnlyAdvisory: validate, EXPECTED, ADVISORY_URL } =
  require("./audit-portal-exception.cjs");

function fixture() {
  const packages = { "": { dependencies: { react: "^19" } } };
  const vulnerabilities = {};
  for (const [name, entry] of Object.entries(EXPECTED)) {
    const location = "node_modules/" + name;
    packages[location] = { version: entry.version, dev: true };
    vulnerabilities[name] = {
      name, severity: "high", nodes: [location],
      via: name === "picomatch"
        ? [{ name: "picomatch", severity: "high", url: ADVISORY_URL }]
        : entry.via.slice(),
    };
  }
  return {
    lock: { lockfileVersion: 3, packages },
    report: {
      auditReportVersion: 2,
      metadata: { vulnerabilities: { high: 5, moderate: 0, critical: 0 } },
      vulnerabilities,
    },
  };
}

const now = Date.parse("2026-11-18T12:00:00Z");

test("explicitly reviewed dev-only chain is temporarily accepted", () => {
  const { lock, report } = fixture();
  const v = validate(report, lock, now);
  assert.equal(v.accepted, true);
  assert.match(v.reason, /GHSA-fc5q-39xc-vjpf/u);
});

test("clean audit passes with no temporary exception", () => {
  const { lock, report } = fixture();
  report.vulnerabilities = {};
  assert.equal(validate(report, lock, now).accepted, false);
});

test("unknown advisory, even on reviewed package, is blocked", () => {
  const { lock, report } = fixture();
  report.vulnerabilities.picomatch.via.push({
    name: "picomatch", url: "https://github.com/advisories/GHSA-new-cve",
    severity: "high",
  });
  assert.throws(() => validate(report, lock, now), /Unapproved security advisory/u);
});

test("unreviewed vulnerability in unrelated package is blocked", () => {
  const { lock, report } = fixture();
  report.vulnerabilities.axios = {
    name: "axios", severity: "high", via: ["picomatch"],
    nodes: ["node_modules/axios"],
  };
  assert.throws(() => validate(report, lock, now), /Unexpected npm audit finding/u);
});

test("runtime copy of affected dependency is blocked even with unchanged CVE", () => {
  const { lock, report } = fixture();
  lock.packages["node_modules/picomatch"].dev = false;
  assert.throws(() => validate(report, lock, now), /dev-only/u);
});

test("nested unreviewed or wrong-version picomatch copy is blocked", () => {
  const { lock, report } = fixture();
  lock.packages["node_modules/vite/node_modules/picomatch"] = {
    version: "4.0.7", dev: true,
  };
  assert.throws(() => validate(report, lock, now), /version-pinned/u);
});

test("changed dev tooling version requires new security review", () => {
  const { lock, report } = fixture();
  lock.packages["node_modules/vite"].version = "8.3.0";
  assert.throws(() => validate(report, lock, now), /version-pinned/u);
});

test("new transitive dependency chain and unexpected advisory are blocked", () => {
  const { lock, report } = fixture();
  report.vulnerabilities.fdir.via.push("some-new-library");
  assert.throws(() => validate(report, lock, now), /Unapproved vulnerable dependency chain/u);
});

test("expiry fails closed and requires a review even if vulnerability unchanged", () => {
  const { lock, report } = fixture();
  assert.throws(() =>
    validate(report, lock, Date.parse("2026-12-01T00:00:00Z")),
  /expired/u);
});

test("registry errors or malformed advisory evidence fail closed", () => {
  const { lock, report } = fixture();
  delete report.metadata;
  assert.throws(() => validate(report, lock, now), /missing required/u);
});

test("unexpected audit node locations are blocked", () => {
  const { lock, report } = fixture();
  report.vulnerabilities.picomatch.nodes = ["node_modules/not-picomatch"];
  assert.throws(() => validate(report, lock, now), /Unreviewed vulnerable node/u);
});
