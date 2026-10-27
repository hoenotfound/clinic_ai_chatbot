const express = require("express");
const { hasCapability } = require("../utils/permissions");
const followUpRepo = require("../db/salesFollowUpRepo");
const customerExportRepo = require("../db/customerExportRepo");
const { csvCell, identifierCsvCell, malaysiaDateTime, malaysiaDateStamp } = require("../utils/csvExport");

const router = express.Router();

function canManageAll(req) {
  return hasCapability(req.user, "view_all_leads") &&
    (hasCapability(req.user, "manage_lead_assignment") || hasCapability(req.user, "export_customer_data"));
}

function canView(req) {
  return hasCapability(req.user, "view_assigned_leads") || hasCapability(req.user, "view_all_leads");
}

function publicError(res, error) {
  if (error.status && [400, 403, 404, 409].includes(error.status)) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error("Sales follow-up request failed:", error);
  return res.status(500).json({ error: "Couldn't load sales follow-ups." });
}

function csvForPending(rows, period, summary = null) {
  const headers = ["Customer", "WhatsApp Number", "Treatment", "Priority", "Salesperson", "Last Customer Reply (MYT)", "AI Summary", "Suggested Next Action", "WhatsApp Link", "Report"];
  const body = [
    headers.map(csvCell).join(","),
    ...rows.map(row => [
      csvCell(row.customerName),
      identifierCsvCell(row.whatsappNumber),
      csvCell(row.treatment),
      csvCell(row.temperature.toUpperCase()),
      csvCell(row.owner),
      csvCell(malaysiaDateTime(row.lastCustomerReplyAt)),
      csvCell(row.summary),
      csvCell(row.nextAction),
      csvCell(row.whatsappUrl),
      csvCell(period)
    ].join(","))
  ];
  if (summary) {
    body.push("", csvCell("Monthly outcome summary (unique leads)"));
    body.push([csvCell("Outcome"), csvCell("Leads")].join(","));
    for (const [status, count] of Object.entries(summary)) {
      body.push([csvCell(status), csvCell(count)].join(","));
    }
  }
  return "\uFEFF" + body.join("\r\n");
}

router.get("/", async (req, res) => {
  if (!canView(req)) return res.sendStatus(403);
  try {
    const leads = await followUpRepo.listPending({ username: req.user.username, canViewAll: canManageAll(req) });
    return res.json({ leads, counts: {
      pending: leads.length,
      hot: leads.filter(lead => lead.temperature === "hot").length,
      warm: leads.filter(lead => lead.temperature === "warm").length
    }, inactivityHours: 48 });
  } catch (error) { return publicError(res, error); }
});

router.get("/export", async (req, res) => {
  if (!hasCapability(req.user, "export_customer_data") || !canView(req)) return res.sendStatus(403);
  const period = req.query.period === "monthly" ? "monthly" : req.query.period === "weekly" ? "weekly" : null;
  if (!period) return res.status(400).json({ error: "Choose weekly or monthly." });
  try {
    // Never export cached UI data. Recheck eligibility and permissions at download time.
    const rows = await followUpRepo.listPending({ username: req.user.username, canViewAll: canManageAll(req) });
    const monthlySummary = period === "monthly" ? await followUpRepo.countMonthlyOutcomes({
      username: req.user.username, canViewAll: canManageAll(req)
    }) : null;
    await customerExportRepo.recordCustomerExport({
      username: req.user.username, preset: "sales_follow_up", scope: "current",
      rowCount: rows.length, filters: { period, inactivityHours: 48 }
    });
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="sales-follow-up-' + period + '-' + malaysiaDateStamp() + '.csv"',
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      "X-Export-Row-Count": String(rows.length)
    });
    return res.status(200).send(csvForPending(rows, period, monthlySummary));
  } catch (error) { return publicError(res, error); }
});

router.patch("/:leadId/outcome", async (req, res) => {
  if (!hasCapability(req.user, "manage_assigned_leads")) return res.sendStatus(403);
  try {
    const result = await followUpRepo.recordOutcome({
      leadId: req.params.leadId, status: req.body?.status,
      expectedLastInboundId: req.body?.expectedLastInboundId,
      dueAt: req.body?.dueAt, username: req.user.username,
      canManageAll: canManageAll(req)
    });
    return res.json(result);
  } catch (error) { return publicError(res, error); }
});

module.exports = router;
