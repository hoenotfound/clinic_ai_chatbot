const express = require("express");
const analyticsRepo = require("../db/analyticsRepo");
const {
  AnalyticsValidationError,
  normalizeAnalyticsQuery,
} = require("../utils/analyticsValidation");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const filters = normalizeAnalyticsQuery(req.query);
    res.json(await analyticsRepo.getAnalytics(filters));
  } catch (err) {
    if (err instanceof AnalyticsValidationError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error("Failed to load analytics:", err);
    return res.status(500).json({ error: "Something went wrong loading analytics." });
  }
});

module.exports = router;
