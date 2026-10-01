const crypto = require("crypto");
const express = require("express");
const configRepo = require("../db/configRepo");
const configImportHistoryRepo = require("../db/configImportHistoryRepo");
const { prepareConfigUpdatePayload } = require("./config");

const router = express.Router();
const EDITABLE_KEYS = Object.freeze([...configRepo.CONFIG_KEYS]);

function requireAdministrator(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      error: "Only administrators can use Advanced Config.",
    });
  }
  next();
}

function editableConfigView(config = {}) {
  return Object.fromEntries(
    EDITABLE_KEYS
      .filter((key) => Object.prototype.hasOwnProperty.call(config, key))
      .map((key) => [key, config[key]])
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function configFingerprint(config) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(editableConfigView(config))))
    .digest("hex");
}

function projectedConfig(currentConfig, updates) {
  const next = { ...currentConfig, ...updates };
  if (Object.prototype.hasOwnProperty.call(updates, "businessName")) {
    next.businessName = updates.businessName;
    next.clinicName = updates.businessName;
  } else if (Object.prototype.hasOwnProperty.call(updates, "clinicName")) {
    next.clinicName = updates.clinicName;
    next.businessName = updates.clinicName;
  }
  return next;
}

function comparable(value) {
  return JSON.stringify(stableValue(value));
}

function valueSummary(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") {
    const count = Object.keys(value).length;
    return `${count} field${count === 1 ? "" : "s"}`;
  }
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact) return "Empty";
    return compact.length > 72 ? `${compact.slice(0, 69)}…` : compact;
  }
  if (value === null || value === undefined) return "Empty";
  return String(value);
}

function buildConfigDiff(currentConfig, updates) {
  const next = projectedConfig(currentConfig, updates);
  return EDITABLE_KEYS
    .filter((key) => comparable(currentConfig[key]) !== comparable(next[key]))
    .map((key) => ({
      key,
      before: valueSummary(currentConfig[key]),
      after: valueSummary(next[key]),
    }));
}

function validationFailure(res, prepared) {
  return res.status(prepared.status || 400).json({
    error: prepared.error,
    unknownKeys: prepared.unknownKeys || undefined,
    invalidKeys: prepared.invalidKeys || undefined,
  });
}

function historyPayload(rows) {
  return (rows || []).map((row) => ({
    id: Number(row.id),
    editableConfig: row.editable_config || {},
    createdBy: row.created_by,
    reason: row.reason,
    restoredFromSnapshotId: row.restored_from_snapshot_id
      ? Number(row.restored_from_snapshot_id)
      : null,
    createdAt: row.created_at,
  }));
}

router.use(requireAdministrator);

router.get("/", async (req, res) => {
  try {
    const current = configRepo.getConfig();
    const history = await configImportHistoryRepo.listSnapshots(12);
    res.json({
      config: editableConfigView(current),
      fingerprint: configFingerprint(current),
      editableKeys: EDITABLE_KEYS,
      history: historyPayload(history),
    });
  } catch (err) {
    console.error("Failed to load Advanced Config:", err);
    res.status(500).json({ error: "Couldn't load Advanced Config." });
  }
});

router.post("/preview", async (req, res) => {
  try {
    const current = configRepo.getConfig();
    const prepared = prepareConfigUpdatePayload(req.body?.config, current);
    if (!prepared.ok) return validationFailure(res, prepared);

    res.json({
      valid: true,
      baseFingerprint: configFingerprint(current),
      changes: buildConfigDiff(current, prepared.updates),
      normalizedUpdates: prepared.updates,
    });
  } catch (err) {
    console.error("Failed to preview Advanced Config:", err);
    res.status(500).json({ error: "Couldn't validate this configuration." });
  }
});

router.post("/apply", async (req, res) => {
  try {
    const current = configRepo.getConfig();
    const suppliedFingerprint = String(req.body?.baseFingerprint || "");
    const currentFingerprint = configFingerprint(current);
    if (!suppliedFingerprint || suppliedFingerprint !== currentFingerprint) {
      return res.status(409).json({
        error: "Configuration changed after your preview. Validate it again before applying.",
        code: "CONFIG_PREVIEW_STALE",
      });
    }

    const prepared = prepareConfigUpdatePayload(req.body?.config, current);
    if (!prepared.ok) return validationFailure(res, prepared);

    const changes = buildConfigDiff(current, prepared.updates);
    if (changes.length === 0) {
      return res.status(409).json({
        error: "There are no configuration changes to apply.",
        code: "CONFIG_NO_CHANGES",
      });
    }

    await configImportHistoryRepo.createSnapshot({
      editableConfig: editableConfigView(current),
      createdBy: req.user.username,
      reason: "before_json_import",
    });

    const updated = await configRepo.updateConfig(prepared.updates);
    const history = await configImportHistoryRepo.listSnapshots(12);
    res.json({
      config: editableConfigView(updated),
      fingerprint: configFingerprint(updated),
      changes,
      history: historyPayload(history),
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("Failed to apply Advanced Config:", err);
    res.status(status).json({
      error: err?.message || "Couldn't apply this configuration.",
      code: err?.code || null,
    });
  }
});

router.post("/restore/:id", async (req, res) => {
  try {
    const snapshotId = Number(req.params.id);
    if (!Number.isSafeInteger(snapshotId) || snapshotId <= 0) {
      return res.status(400).json({ error: "Invalid configuration snapshot." });
    }

    const snapshot = await configImportHistoryRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      return res.status(404).json({ error: "Configuration snapshot not found." });
    }

    const current = configRepo.getConfig();
    const prepared = prepareConfigUpdatePayload(snapshot.editable_config, current);
    if (!prepared.ok) return validationFailure(res, prepared);

    const changes = buildConfigDiff(current, prepared.updates);
    if (changes.length === 0) {
      return res.status(409).json({
        error: "This snapshot already matches the current editable configuration.",
        code: "CONFIG_NO_CHANGES",
      });
    }

    await configImportHistoryRepo.createSnapshot({
      editableConfig: editableConfigView(current),
      createdBy: req.user.username,
      reason: "before_restore",
      restoredFromSnapshotId: snapshotId,
    });

    const updated = await configRepo.updateConfig(prepared.updates);
    const history = await configImportHistoryRepo.listSnapshots(12);
    res.json({
      config: editableConfigView(updated),
      fingerprint: configFingerprint(updated),
      changes,
      restoredSnapshotId: snapshotId,
      history: historyPayload(history),
    });
  } catch (err) {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error("Failed to restore Advanced Config:", err);
    res.status(status).json({
      error: err?.message || "Couldn't restore this configuration snapshot.",
      code: err?.code || null,
    });
  }
});

module.exports = router;
module.exports.EDITABLE_KEYS = EDITABLE_KEYS;
module.exports.buildConfigDiff = buildConfigDiff;
module.exports.configFingerprint = configFingerprint;
module.exports.editableConfigView = editableConfigView;
module.exports.projectedConfig = projectedConfig;
