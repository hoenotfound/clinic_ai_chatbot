"use strict";

const { createHmac, randomBytes, timingSafeEqual } = require("node:crypto");

const STRONG_INBOX_ETAG = /^"inbox-[a-f0-9]{64}"$/;
const REVISION_PROOF = /^v1\.[a-f0-9]{64}$/;

// A short-lived, per-process signature. There is no customer list cache, no
// migration, and no persistent key. A deployment/restart always invalidates
// existing fast-path proofs.
function createInboxRevisionGuard(secret = randomBytes(32)) {
  function makeProof({ etag, wal, user, permittedIds }) {
    if (!STRONG_INBOX_ETAG.test(String(etag || "")) ||
        !/^[0-9A-F]+\/[0-9A-F]+$/i.test(String(wal || "")) ||
        (permittedIds !== null && !Array.isArray(permittedIds))) return null;

    const id = Number(user?.id);
    const username = String(user?.username || "").trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !username) return null;

    const allowed = permittedIds === null ? null
      : [...new Set(permittedIds.map(Number))].sort((a, b) => a - b);
    if (allowed !== null && allowed.some(x => !Number.isSafeInteger(x) || x <= 0)) return null;
    // Existing authorization middleware still runs on every request. Include
    // current rights and the CURRENT assigned-contact set in every signature.
    const fields = [
      etag, String(wal), id, username, allowed,
      user?.role || null, user?.roles || null,
      user?.permissions || null, user?.features || null,
    ];
    const digest = createHmac("sha256", secret)
      .update(JSON.stringify(fields)).digest("hex");
    return `v1.${digest}`;
  }

  function matchesProof(submitted, fields) {
    if (!REVISION_PROOF.test(String(submitted || ""))) return false;
    const candidate = makeProof(fields);
    if (!candidate) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(submitted));
  }

  return { makeProof, matchesProof };
}

module.exports = { createInboxRevisionGuard };
