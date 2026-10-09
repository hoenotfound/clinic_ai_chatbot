const express = require("express");
const { hasCapability } = require("../utils/permissions");
const { getAccessibleContactIds } = require("../utils/accessControl");
const activityRepo = require("../db/followUpActivityRepo");

const router = express.Router();

// This route is intentionally read-only and available only to staff with
// Tools access. Contact visibility follows the same assigned/all-leads policy
// as Inbox; it must not expose other staff members' customer activity.
router.get("/", async (req, res) => {
  if (!hasCapability(req.user, "manage_tools")) {
    return res.status(403).json({ error: "You do not have access to follow-up activity." });
  }
  try {
    const allowedContactIds = await getAccessibleContactIds(req.user);
    const filters = activityRepo.parseActivityFilters(req.query);
    if (!filters) return res.status(400).json({ error: "Invalid activity filters." });
    const activity = await activityRepo.listActivity(filters, allowedContactIds);
    const diagnostics = await activityRepo.listSchedulingDiagnostics(filters, allowedContactIds);
    res.set("Cache-Control", "no-store");
    return res.json({ ...activity, diagnostics });
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Failed to load follow-up activity:", error);
    return res.status(500).json({ error: "Could not load follow-up activity." });
  }
});

module.exports = router;
