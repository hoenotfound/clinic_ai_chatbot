#!/usr/bin/env node
"use strict";

/*
 * Temporary, narrowly reviewed CI exception for GHSA-fc5q-39xc-vjpf in
 * portal-frontend's DEV-ONLY picomatch@4.0.5 toolchain.
 *
 * This is NOT a vulnerability fix. It is a time-limited risk acceptance
 * to unblock the backend-only pricing release (#674) until upstream publishes
 * a verified patched version. Production dependencies remain strictly audited.
 *
 * Security invariants:
 *  - perform the complete npm audit; never use --omit=dev here
 *  - any advisory other than GHSA-fc5q-39xc-vjpf fails
 *  - only the existing known-dev-only transitive chain is allowed
 *  - all installed package versions and lockfile dev flags must match the
 *    reviewed versions; extra vulnerabilities or packages fail closed
 *  - expiry stops future releases, not silently extending the exception
 *  - npm registry transport errors and malformed/absent audit data fail closed
 *
 * Once a patched picomatch is published, update dependencies and delete this
 * exception. See https://github.com/hoenotfound/clinic_ai_chatbot/pull/674
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ADVISORY_URL = "https://github.com/advisories/GHSA-fc5q-39xc-vjpf";
const EXCEPTION_UNTIL_UTC = "2026-12-01T00:00:00Z";
const EXPECTED = Object.freeze({
  picomatch: { version: "4.0.5", via: [] },
  fdir: { version: "6.5.0", via: ["picomatch"] },
  tinyglobby: { version: "0.2.17", via: ["fdir", "picomatch"] },
  vite: { version: "8.2.4", via: ["picomatch", "tinyglobby"] },
  "@vitejs/plugin-react": { version: "6.0.5", via: ["vite"] },
});

function validateKnownDevOnlyAdvisory(report, lock, now = Date.now()) {
  if (!report || report.auditReportVersion !== 2 ||
      !report.metadata?.vulnerabilities ||
      typeof report.vulnerabilities !== "object" ||
      Array.isArray(report.vulnerabilities)) {
    throw new Error("Full npm audit response missing required vulnerability evidence");
  }

  const issues = Object.entries(report.vulnerabilities);
  if (issues.length === 0) return { accepted: false, reason: "Full npm audit clean" };
  if (!Number.isFinite(now) || now >= Date.parse(EXCEPTION_UNTIL_UTC)) {
    throw new Error("Temporary development-dependency exception expired; review before any new release");
  }
  if (lock?.lockfileVersion !== 3 || !lock.packages ||
      typeof lock.packages !== "object") {
    throw new Error("Unexpected package-lock format; audit exception requires reviewed lockfile");
  }
  if (!issues.some(([name]) => name === "picomatch")) {
    throw new Error("Exception only applies when the root picomatch advisory is present");
  }

  const seen = new Set();
  for (const [name, item] of issues) {
    const expected = EXPECTED[name];
    if (!expected) throw new Error("Unexpected npm audit finding: " + name);
    if (!item || item.name !== name ||
        !Array.isArray(item.via) || item.via.length === 0) {
      throw new Error("Unrecognized vulnerability evidence for " + name);
    }
    if (!["high", "moderate"].includes(item.severity)) {
      throw new Error("Unexpected vulnerability severity for " + name);
    }

    const dependencies = [];
    let directAdvisoryCount = 0;
    for (const via of item.via) {
      if (typeof via === "string") {
        dependencies.push(via);
        if (!expected.via.includes(via)) {
          throw new Error("Unapproved vulnerable dependency chain: " + name + " via " + via);
        }
      } else if (via && typeof via === "object" && !Array.isArray(via)) {
        if (name !== "picomatch" ||
            via.url !== ADVISORY_URL ||
            via.name !== "picomatch" ||
            via.severity !== "high") {
          throw new Error("Unapproved security advisory in " + name);
        }
        directAdvisoryCount++;
      } else {
        throw new Error("Unknown audit via record for " + name);
      }
    }

    if (name === "picomatch") {
      if (directAdvisoryCount !== 1 || dependencies.length) {
        throw new Error("picomatch must have only the reviewed direct advisory");
      }
    } else if (directAdvisoryCount !== 0 || dependencies.length < 1) {
      throw new Error("Unexpected direct security advisory for " + name);
    }

    const matches = Object.entries(lock.packages).filter(([location]) =>
      location === "node_modules/" + name ||
      location.endsWith("/node_modules/" + name)
    );
    if (!matches.length ||
        matches.some(([, pkg]) => pkg?.dev !== true ||
          pkg?.version !== expected.version)) {
      throw new Error("Reviewed dependency must be dev-only and version-pinned: " + name);
    }

    // The audit must point only to installed DEV dependency locations. Do not
    // accept findings on a new runtime or unreviewed nested copy.
    const locations = Array.isArray(item.nodes) ? item.nodes : [];
    if (!locations.length || locations.some(location =>
      !matches.some(([reviewed]) => reviewed === location))) {
      throw new Error("Unreviewed vulnerable node locations for " + name);
    }
    seen.add(name);
  }
  // If the graph changes, force an explicit re-review instead of treating
  // a different dependency tree as the same known issue.
  if (seen.size !== Object.keys(EXPECTED).length) {
    throw new Error("Vulnerable dependency chain changed; exception requires review");
  }

  return {
    accepted: true,
    reason: "One reviewed dev-only advisory (" + ADVISORY_URL + ")",
  };
}

function auditJson() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const p = spawnSync("npm", ["audit", "--json", "--audit-level=moderate"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    if (p.error || typeof p.status !== "number") {
      if (attempt === 3) throw new Error("npm audit execution failed after 3 attempts");
      continue;
    }
    let report;
    try {
      report = JSON.parse(p.stdout || "");
    } catch {
      if (attempt === 3) {
        throw new Error("npm audit returned invalid/missing JSON after 3 attempts");
      }
      continue;
    }
    if (!report?.metadata?.vulnerabilities ||
        !report?.vulnerabilities || report.auditReportVersion !== 2) {
      if (attempt === 3) {
        throw new Error("npm audit returned an error or incomplete advisory data");
      }
      continue;
    }
    if (p.status !== 0 && p.status !== 1) {
      throw new Error("npm audit failed unexpectedly, exit=" + p.status);
    }
    return { report, status: p.status };
  }
  throw new Error("npm audit could not return a valid advisory report");
}

if (require.main === module) {
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package-lock.json"), "utf8")
    );
    const { report, status } = auditJson();
    const verdict = validateKnownDevOnlyAdvisory(report, lock);
    if (!verdict.accepted) {
      if (status !== 0) throw new Error("Audit status disagrees with clean report");
      console.log("Full portal npm audit clean. No exception used.");
    } else {
      if (status !== 1) throw new Error("Vulnerability response had unexpected audit exit code");
      const msg = "TEMPORARY SECURITY EXCEPTION: " + verdict.reason +
        "; expires " + EXCEPTION_UNTIL_UTC +
        "; all other vulnerabilities remain CI-blocking. This does not patch picomatch.";
      console.warn("::warning::" + msg);
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
          "\n### Frontend development dependency security exception\n\n" + msg + "\n");
      }
    }
  } catch (e) {
    console.error("::error::Frontend dependency audit rejected: " + e.message);
    process.exitCode = 1;
  }
}

module.exports = {
  validateKnownDevOnlyAdvisory,
  EXCEPTION_UNTIL_UTC,
  ADVISORY_URL,
  EXPECTED,
};
