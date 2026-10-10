const express = require("express");
const { hasCapability } = require("../utils/permissions");
const { getAccessibleContactIds } = require("../utils/accessControl");
const health = require("../db/followUpHealthRepo");

const router = express.Router();

router.get("/", async (req, res) => {
  if (!hasCapability(req.user, "manage_tools")) {
    return res.status(403).json({ error: "You do not have access to follow-up health." });
  }
  try {
    const filters = health.parseHealthFilters(req.query);
    const allowedContacts = await getAccessibleContactIds(req.user);
    const result = await health.getFollowUpHealth(filters, allowedContacts);
    res.set("Cache-Control", "no-store");
    return res.json(result);
  } catch (error) {
    if (error.status === 400) return res.status(400).json({ error: error.message });
    console.error("Failed to read follow-up health:", error);
    return res.status(500).json({ error: "Unable to load follow-up health." });
  }
});

module.exports = router;
