// Read-only, descriptive recommendations derived from Phase 7 aggregates.
// No automated cadence, message, consent or billing changes.
export const MIN_MATURE_SENDS = 30;
export const MIN_REPLIES = 5;
const DIMENSIONS = [
  ["step", "Follow-up step"],
  ["service", "Recorded treatment"],
  ["media", "Media type"],
  ["channel", "Messaging channel"],
  ["hour", "Sending hour (Malaysia time)"],
];
const excluded = (row) => row.label === "Unspecified (not recorded)" || row.label === "Other / unknown media";
export const MAX_MISSING_SERVICE_SHARE = 0.2;
export const MAX_UNKNOWN_MEDIA_SHARE = 0.2;
const percent = (part, whole) => whole ? Math.round((1000 * part) / whole) / 10 : 0;

export function buildFollowUpIntelligence(report) {
  const summary = report?.summary || {};
  const rows = report?.breakdown || [];
  const total = Number(summary.sent || 0);
  const mature = Number(summary.reply_matured || 0);
  const replied = Number(summary.replied_matured || 0);
  const milestoneMature = Number(summary.milestone_matured || 0);
  const notes = [];
  if (!total) {
    return { ready: false, total, mature, replied, milestoneMature,
      notes: ["No accepted follow-ups in the selected period."], insights: [] };
  }
  if (mature < MIN_MATURE_SENDS || replied < MIN_REPLIES) {
    notes.push(`Reply comparisons are withheld: need at least ${MIN_MATURE_SENDS} sends with complete 72-hour windows and ${MIN_REPLIES} first replies (currently ${mature} sends and ${replied} replies).`);
  }
  if (milestoneMature < MIN_MATURE_SENDS) {
    notes.push(`7-day conversion comparisons are withheld: only ${milestoneMature} sends have complete observation windows.`);
  }
  if (mature && total > mature) {
    notes.push(`${total - mature} recent sends are not yet eligible for mature 72-hour reply metrics.`);
  }
  const byService = rows.filter(row => row.dimension === "service");
  const missing = byService.filter(row => row.label === "Unspecified (not recorded)").reduce((n, row) => n + Number(row.sent || 0), 0);
  if (missing) notes.push(`Service attribution is missing on ${missing} of ${total} accepted sends (${percent(missing, total)}%). Investigate recorded treatment labels before drawing conclusions by service.`);
  const missingShare = total ? missing / total : 0;
  if (missingShare > MAX_MISSING_SERVICE_SHARE) {
    notes.push(`Treatment comparisons are withheld because ${percent(missing, total)}% of accepted sends have no recorded service (maximum allowed: 20%).`);
  }
  const byMedia = rows.filter(row => row.dimension === "media");
  const unknown = byMedia.filter(row => row.label === "Other / unknown media").reduce((n, row) => n + Number(row.sent || 0), 0);
  if (unknown) notes.push(`Media type is unknown for ${unknown} of ${total} sends; verify stored media metadata.`);
  const unknownShare = total ? unknown / total : 0;
  if (unknownShare > MAX_UNKNOWN_MEDIA_SHARE) {
    notes.push(`Media comparisons are withheld because ${percent(unknown, total)}% of accepted sends have unknown media metadata (maximum allowed: 20%).`);
  }

  // Never claim a winning variant or optimize cadence based on observational rankings.
  const enoughOverall = mature >= MIN_MATURE_SENDS && replied >= MIN_REPLIES;
  const insights = DIMENSIONS.map(([dimension, title]) => {
    const groups = rows.filter(row => row.dimension === dimension && !excluded(row));
    const qualifying = enoughOverall && !(dimension === "service" && missingShare > MAX_MISSING_SERVICE_SHARE)
      && !(dimension === "media" && unknownShare > MAX_UNKNOWN_MEDIA_SHARE)
      ? groups.filter(row => Number(row.reply_matured || 0) >= MIN_MATURE_SENDS &&
          Number(row.replied_matured || 0) >= MIN_REPLIES)
      : [];
    return {
      dimension, title, qualifying: qualifying.length,
      groups: qualifying.map(row => ({
        label: row.label,
        mature: Number(row.reply_matured),
        replied: Number(row.replied_matured),
        rate: percent(row.replied_matured, row.reply_matured),
      })).sort((a, b) => a.label.localeCompare(b.label)),
      note: dimension === "service" && missingShare > MAX_MISSING_SERVICE_SHARE
        ? "Treatment comparison unavailable: more than 20% of sends lack treatment attribution."
        : dimension === "media" && unknownShare > MAX_UNKNOWN_MEDIA_SHARE
          ? "Media comparison unavailable: more than 20% of sends have unknown media metadata."
        : qualifying.length < 2
          ? "Not enough groups with mature responses to make a useful comparison."
          : "Rates are descriptive, not a ranking or proof of improvement; group sizes, customer mix and treatment interest may differ.",
    };
  });
  return { ready: enoughOverall, total, mature, replied, milestoneMature, notes, insights };
}
