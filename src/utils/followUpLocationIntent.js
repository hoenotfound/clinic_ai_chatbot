"use strict";

// A customer expressly seeking a provider nearer their home outside the
// clinic's service area should not receive appointment-nudge follow-ups.
// Location alone is never enough: the same customer may plan to visit PJ.
// This function uses only the already-fetched recent inbound text, never a
// network lookup or a new recurring database query.
const REMOTE_HOME = /\b(?:johor(?:\s+bahru)?|sarawak|sabah|kuching|miri|jb|kota\s+kinabalu)\b/iu;
const WANTS_LOCAL = /(?:我想(?:要)?找|想找|寻找|尋找|prefer|looking\s+for|want\s+(?:to\s+find|a))[^\n。!?？]{0,55}(?:靠近|附近|离我近|離我近|这边|這邊|这里|這裡|nearby|nearer|closer|locally|near\s+me|dekat)|(?:\b(?:nearer|closer)\b.{0,28}\b(?:me|home|here)\b)|(?:\b(?:nak|mahu|cari)\b.{0,40}\bdekat\b)/iu;
const CAN_VISIT_PJ = /(?:会|會|要|打算|可以|愿意|願意).{0,14}(?:来|來|过来|過來|去|到)\s*(?:KL|PJ|吉隆坡|八打灵|八打靈)|(?:visit|come|travel|drive|go|coming)\s+(?:to\s+)?(?:PJ|KL|Petaling\s+Jaya|Kuala\s+Lumpur)/iu;

function customerRequestsNearbyAlternative(candidate = {}) {
  // Follow-up candidates contain newest-first inbound messages.
  const recent = Array.isArray(candidate.recent_inbound_messages)
    ? candidate.recent_inbound_messages
      .filter(x => typeof x === "string" && x.trim()).slice(0, 4) : [];
  if (!recent.length) return false;
  const latest = recent[0];
  if (CAN_VISIT_PJ.test(latest)) return false;
  return REMOTE_HOME.test(recent.join("\n")) && WANTS_LOCAL.test(latest);
}

module.exports = { customerRequestsNearbyAlternative };
