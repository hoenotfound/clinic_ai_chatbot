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
const excluded = (row) => row.label === "Unspecified (not recorded)" || row.label === "Other / unknown media" || row.label === "Text / no accepted media";
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
  const byMedia = rows.filter(row => row.dimension === "media");
  const unknown = byMedia.filter(row => row.label === "Other / unknown media").reduce((n, row) => n + Number(row.sent || 0), 0);
  if (unknown) notes.push(`Media type is unknown for ${unknown} of ${total} sends; verify stored media metadata.`);

  // Never claim a winning variant or optimize cadence based on observational rankings.
  const enoughOverall = mature >= MIN_MATURE_SENDS && replied >= MIN_REPLIES;
  const insights = DIMENSIONS.map(([dimension, title]) => {
    const groups = rows.filter(row => row.dimension === dimension && !excluded(row));
    const qualifying = enoughOverall ? groups.filter(row =>
      Number(row.reply_matured || 0) >= MIN_MATURE_SENDS &&
      Number(row.replied_matured || 0) >= MIN_REPLIES) : [];
    const display = [...qualifying].sort((a, b) =>
      Number(b.replied_matured || 0) / Number(b.reply_matured || 1) -
      Number(a.replied_matured || 0) / Number(a.reply_matured || 1));
    return {
      dimension, title, qualifying: qualifying.length,
      candidate: display[0] ? {
        label: display[0].label,
        mature: Number(display[0].reply_matured),
        replied: Number(display[0].replied_matured),
        rate: percent(display[0].replied_matured, display[0].reply_matured),
      } : null,
      note: qualifying.length < 2
        ? "Not enough independent groups with mature responses to make a useful comparison."
        : "Descriptive only. Differences may reflect lead mix, service interest or timing, not improvement caused by this variation.",
    };
  });
  return { ready: enoughOverall, total, mature, replied, milestoneMature, notes, insights };
}
