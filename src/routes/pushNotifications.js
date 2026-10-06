const express = require("express");
const pushSubscriptionsRepo = require("../db/pushSubscriptionsRepo");
const webPush = require("../services/webPushNotificationService");

const router = express.Router();

router.get("/config", (req, res) => {
  const config = webPush.pushConfig(process.env);
  res.json({
    configured: config.configured,
    publicKey: config.configured ? config.publicKey : null,
  });
});

router.get("/subscriptions/status", async (req, res) => {
  const endpoint = String(req.query?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({ error: "Push subscription endpoint is required." });
  }
  try {
    const subscription = await pushSubscriptionsRepo.getActiveSubscriptionForUser(
      req.user.id,
      endpoint
    );
    return res.json({ active: Boolean(subscription) });
  } catch (err) {
    console.error("Failed to check Web Push subscription:", err);
    return res.status(500).json({ error: "Couldn't check notification status." });
  }
});

router.post("/subscriptions", async (req, res) => {
  const subscription = req.body?.subscription;
  const cleaned = pushSubscriptionsRepo.cleanSubscription(subscription);
  if (!cleaned) {
    return res.status(400).json({ error: "Invalid push subscription." });
  }

  try {
    const saved = await pushSubscriptionsRepo.upsertSubscription(
      req.user.id,
      subscription,
      req.get("user-agent")
    );
    return res.status(201).json({ ok: true, subscriptionId: saved?.id || null });
  } catch (err) {
    console.error("Failed to save Web Push subscription:", err);
    return res.status(500).json({ error: "Couldn't enable notifications." });
  }
});

router.delete("/subscriptions", async (req, res) => {
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({ error: "Push subscription endpoint is required." });
  }
  try {
    const removed = await pushSubscriptionsRepo.removeSubscription(
      req.user.id,
      endpoint
    );
    return res.json({ ok: true, removed });
  } catch (err) {
    console.error("Failed to remove Web Push subscription:", err);
    return res.status(500).json({ error: "Couldn't disable notifications." });
  }
});

router.post("/test", async (req, res) => {
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({ error: "Push subscription endpoint is required." });
  }
  try {
    const result = await webPush.sendUserTest(req.user.id, endpoint);
    if (result.status === "disabled") {
      return res.status(503).json({
        error: "Web Push is not configured on this deployment.",
        code: "WEB_PUSH_NOT_CONFIGURED",
      });
    }
    if (result.status === "no-subscribers") {
      return res.status(409).json({
        error: "Enable notifications on this device first.",
        code: "WEB_PUSH_NO_SUBSCRIPTION",
      });
    }
    return res.json({ ok: result.sent > 0, ...result });
  } catch (err) {
    console.error("Failed to send Web Push test notification:", err);
    return res.status(500).json({ error: "Couldn't send the test notification." });
  }
});

module.exports = router;
