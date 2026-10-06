const express = require("express");
const webPushService = require("../services/webPushService");

const router = express.Router();

router.get("/status", async (req, res) => {
  try {
    res.json(await webPushService.statusForUser(req.user.id));
  } catch (err) {
    console.error("Failed to load Web Push status:", err);
    res.status(500).json({ error: "Couldn't load notification status." });
  }
});

router.post("/subscriptions", async (req, res) => {
  try {
    const result = await webPushService.saveSubscription({
      userId: req.user.id,
      subscription: req.body?.subscription,
      userAgent: req.get("user-agent"),
    });
    res.status(201).json(result);
  } catch (err) {
    if (err?.code === "WEB_PUSH_NOT_CONFIGURED") {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    if (err?.code === "INVALID_WEB_PUSH_SUBSCRIPTION") {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error("Failed to save Web Push subscription:", err);
    res.status(500).json({ error: "Couldn't enable notifications." });
  }
});

router.delete("/subscriptions", async (req, res) => {
  try {
    res.json(
      await webPushService.removeSubscription({
        userId: req.user.id,
        endpoint: req.body?.endpoint,
      })
    );
  } catch (err) {
    console.error("Failed to remove Web Push subscription:", err);
    res.status(500).json({ error: "Couldn't disable notifications." });
  }
});

router.post("/test", async (req, res) => {
  try {
    const result = await webPushService.sendTestToUser(req.user.id, req.body?.endpoint);
    if (!result.configured) {
      return res.status(503).json({
        error: result.reason || "Web Push is not configured.",
        code: "WEB_PUSH_NOT_CONFIGURED",
      });
    }
    if (result.sent < 1) {
      return res.status(409).json({
        error: "No active notification subscription was found for this account.",
      });
    }
    res.json(result);
  } catch (err) {
    console.error("Failed to send Web Push test:", err);
    res.status(500).json({ error: "Couldn't send the test notification." });
  }
});

module.exports = router;
