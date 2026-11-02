"use strict";

const { createHash } = require("node:crypto");

// Hash only the fully authorization-filtered JSON response. The server still
// re-runs every staff authorization check before considering a 304 response.
// Nothing is cached across customers, staff, requests or server processes.
function inboxPayloadEtag(serialized) {
  return '"inbox-' + createHash("sha256").update(serialized).digest("hex") + '"';
}

function matchesInboxPayloadEtag(ifNoneMatch, etag) {
  if (typeof ifNoneMatch !== "string" || !etag) return false;
  // Never treat wildcard * as proof that this staff member has the current
  // snapshot. Only an exact strong validator may suppress the response body.
  return ifNoneMatch.split(",").some(part => part.trim() === etag);
}

module.exports = { inboxPayloadEtag, matchesInboxPayloadEtag };
