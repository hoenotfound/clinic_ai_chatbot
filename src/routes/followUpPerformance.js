const express = require("express");
const { hasCapability } = require("../utils/permissions");
const { getAccessibleContactIds } = require("../utils/accessControl");
const performance = require("../db/followUpPerformanceRepo");

const router = express.Router();
router.get("/", async (req, res) => {
  if (!hasCapability(req.user, "manage_tools")) {
    return res.status(403).json({ error: "You do not have access to follow-up performance." });
  }
  try {
    const filters = performance.parsePerformanceFilters(req.query);
    const allowedContacts = await getAccessibleContactIds(req.user);
    const result = await performance.getFollowUpPerformance(filters, allowedContacts);
    res.set("Cache-Control", "no-store");
    return res.json(result);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Unable to read follow-up performance:", error);
    return res.status(500).json({ error: "Unable to load follow-up performance." });
  }
});
module.exports = router;
