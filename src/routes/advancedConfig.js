const crypto = require("crypto");
const express = require("express");
const configRepo = require("../db/configRepo");
const configImportHistoryRepo = require("../db/configImportHistoryRepo");
const { prepareConfigUpdatePayload } = require("./config");
const { protectedGuardrails } = require("../services/clientSetupService");

const router = express.Router();
const EDITABLE_KEYS = Object.freeze([
  "businessName",
  "businessDescription",
  "aiAssistantName",
  "branches",
  "serviceAreas",
  "hours",
  "contact",
  "introMessage",
  "promotions",
  "resultMedia",
  "services",
  "serviceAliases",
  "faqs",
  "closingPlaybook",
  "tone",
  "messagingStyle",
  "sop",
  "escalation",
  "guardrails",
]);

const COLLECTION_DIFF_SPECS = Object.freeze({
  branches: {
    identity: "name",
    fields: ["address", "phone", "whatsapp"],
  },
  promotions: {
    identity: "name",
    fields: ["linkedService", "sendOnPriceQuery", "packages", "caption", "validFrom", "validUntil", "imageUrl"],
  },
  resultMedia: {
    identity: "service",
    fields: ["enabled", "sendAfterPrice", "autoSendCount", "items"],
  },
  services: {
    identity: "name",
    fields: ["description", "priceRange", "duration"],
  },
  serviceAliases: {
    identity: "alias",
    fields: ["officialService"],
  },
  faqs: {
    identity: "q",
    fields: ["a"],
  },
});

const OBJECT_DIFF_SPECS = Object.freeze({
  hours: ["general", "closed"],
  contact: ["whatsapp", "instagram", "facebook", "tiktok"],
  escalation: ["outOfScopeTriggers", "handoffMessage", "handoffNote"],
});

const TEXT_DIFF_KEYS = new Set([
  "businessDescription",
  "introMessage",
  "closingPlaybook",
  "tone",
  "messagingStyle",
  "sop",
]);

function text(value) {
  return String(value || "").trim();
}

function cleanStrings(items) {
  return (Array.isArray(items) ? items : []).map(text).filter(Boolean);
}

function isIsoDate(value) {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isValidWhatsapp(value) {
  const input = text(value);
  if (!input) return true;
  if (/^https?:\/\/(?:api\.)?whatsapp\.com\//i.test(input)) return true;
  if (/^https?:\/\/wa\.me\/\d{8,15}(?:\?.*)?$/i.test(input)) return true;
  const compact = input.replace(/[\s()\-]/g, "");
  return /^\+?\d{8,15}$/.test(compact);
}

function validationError(error, invalidKeys = []) {
  return { ok: false, status: 400, error, invalidKeys };
}

function validateAdvancedConfigState(currentConfig, updates) {
  const next = projectedConfig(currentConfig, updates);

  if (
    Object.prototype.hasOwnProperty.call(updates, "businessDescription")
    && !text(next.businessDescription)
  ) {
    return validationError("Business description can't be empty.", ["businessDescription"]);
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "hours")
    && !text(next.hours?.general)
  ) {
    return validationError("Opening hours can't be empty.", ["hours"]);
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "contact")
    && !isValidWhatsapp(next.contact?.whatsapp)
  ) {
    return validationError(
      "Enter a valid WhatsApp number or WhatsApp link.",
      ["contact"]
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, "branches")
    && ["aesthetic_clinic", "tcm_clinic"].includes(currentConfig?.businessType)
    && (Array.isArray(next.branches) ? next.branches : []).some(
      (branch) => !text(branch?.address)
    )
  ) {
    return validationError(
      "Every clinic branch needs an address.",
      ["branches"]
    );
  }

  const proposedGuardrails = cleanStrings(next.guardrails);
  if (proposedGuardrails.length === 0) {
    return validationError("Keep at least one AI guardrail.", ["guardrails"]);
  }

  const requiredGuardrails = protectedGuardrails(currentConfig);
  const proposedGuardrailSet = new Set(proposedGuardrails);
  const missingProtectedGuardrails = requiredGuardrails.filter(
    (rule) => !proposedGuardrailSet.has(rule)
  );
  if (missingProtectedGuardrails.length > 0) {
    return validationError(
      "Built-in industry safety rules cannot be removed through Advanced Config.",
      ["guardrails"]
    );
  }

  const escalation = next.escalation || {};
  if (!text(escalation.handoffMessage)) {
    return validationError("The handoff message can't be empty.", ["escalation"]);
  }
  if (cleanStrings(escalation.outOfScopeTriggers).length === 0) {
    return validationError("Keep at least one handoff trigger.", ["escalation"]);
  }

  const serviceNames = new Set(
    (Array.isArray(next.services) ? next.services : [])
      .map((service) => text(service?.name).toLowerCase())
      .filter(Boolean)
  );
  for (const alias of Array.isArray(next.serviceAliases) ? next.serviceAliases : []) {
    const officialService = text(alias?.officialService);
    if (!text(alias?.alias) || !officialService) {
      return validationError(
        "Every service term needs both the customer wording and the service it maps to.",
        ["serviceAliases"]
      );
    }
    if (!serviceNames.has(officialService.toLowerCase())) {
      return validationError(
        "Every service term must map to a service currently configured.",
        ["serviceAliases"]
      );
    }
  }

  for (const faq of Array.isArray(next.faqs) ? next.faqs : []) {
    if (!text(faq?.q) || !text(faq?.a)) {
      return validationError(
        "Every FAQ needs both a question and an answer.",
        ["faqs"]
      );
    }
  }

  for (const promotion of Array.isArray(next.promotions) ? next.promotions : []) {
    if (promotion?.sendOnPriceQuery === true) {
      const linkedService = text(promotion?.linkedService);
      if (!linkedService || !serviceNames.has(linkedService.toLowerCase())) {
        return validationError(
          "Price-triggered promotions must link to a currently configured service.",
          ["promotions"]
        );
      }
      const packages = Array.isArray(promotion?.packages)
        ? promotion.packages
        : [];
      if (packages.length > 0) {
        if (packages.some((item) => !text(item?.name) || !text(item?.imageUrl) || !text(item?.caption))) {
          return validationError(
            "Every automatic promotion package needs a name, image, and caption.",
            ["promotions"]
          );
        }
      } else if (!text(promotion?.imageUrl) || !text(promotion?.caption)) {
        return validationError(
          "Price-triggered promotions need either package options or a single image and caption.",
          ["promotions"]
        );
      }
    }
    if (!isIsoDate(promotion?.validFrom) || !isIsoDate(promotion?.validUntil)) {
      return validationError("Promotion dates must be valid dates.", ["promotions"]);
    }
    const validFrom = promotion?.validFrom || null;
    const validUntil = promotion?.validUntil || null;
    if (validFrom && validUntil && validUntil < validFrom) {
      return validationError(
        `The end date for ${text(promotion?.name) || "a promotion"} cannot be before its start date.`,
        ["promotions"]
      );
    }
  }

  return { ok: true };
}

function displayValue(value) {
  if (value === null || value === undefined || value === "") return "Empty";
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean).join(" · ") || "Empty";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function groupDiffSegments(operations, valueKey) {
  const segments = [];
  for (const operation of operations) {
    const previous = segments[segments.length - 1];
    if (previous?.type === operation.type) {
      previous[valueKey].push(operation.value);
    } else {
      segments.push({ type: operation.type, [valueKey]: [operation.value] });
    }
  }
  return segments;
}

function lcsOperations(beforeItems, afterItems) {
  const rows = beforeItems.length + 1;
  const cols = afterItems.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));

  for (let i = beforeItems.length - 1; i >= 0; i -= 1) {
    for (let j = afterItems.length - 1; j >= 0; j -= 1) {
      table[i][j] = beforeItems[i] === afterItems[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const operations = [];
  let i = 0;
  let j = 0;
  while (i < beforeItems.length && j < afterItems.length) {
    if (beforeItems[i] === afterItems[j]) {
      operations.push({ type: "same", value: beforeItems[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      operations.push({ type: "removed", value: beforeItems[i] });
      i += 1;
    } else {
      operations.push({ type: "added", value: afterItems[j] });
      j += 1;
    }
  }
  while (i < beforeItems.length) {
    operations.push({ type: "removed", value: beforeItems[i] });
    i += 1;
  }
  while (j < afterItems.length) {
    operations.push({ type: "added", value: afterItems[j] });
    j += 1;
  }
  return operations;
}

function tokenizeDiffText(value) {
  return String(value ?? "").match(/\s+|[\p{Script=Han}]|[\p{L}\p{N}_]+|[^\s]/gu) || [];
}

function buildWordDiff(before, after) {
  const beforeTokens = tokenizeDiffText(before);
  const afterTokens = tokenizeDiffText(after);
  if (beforeTokens.length > 700 || afterTokens.length > 700) return null;

  const operations = lcsOperations(beforeTokens, afterTokens);
  const grouped = [];
  for (const operation of operations) {
    const previous = grouped[grouped.length - 1];
    if (previous?.type === operation.type) {
      previous.text += operation.value;
    } else {
      grouped.push({ type: operation.type, text: operation.value });
    }
  }
  return { kind: "text", mode: "words", segments: grouped };
}

function buildLineDiff(before, after) {
  const beforeLines = String(before ?? "").replace(/\r\n/g, "\n").split("\n");
  const afterLines = String(after ?? "").replace(/\r\n/g, "\n").split("\n");

  if (beforeLines.length <= 2 && afterLines.length <= 2) {
    const wordDiff = buildWordDiff(before, after);
    if (wordDiff) return wordDiff;
  }

  if (beforeLines.length > 300 || afterLines.length > 300) {
    return {
      kind: "text",
      mode: "before_after",
      before: displayValue(before),
      after: displayValue(after),
    };
  }

  return {
    kind: "text",
    mode: "lines",
    segments: groupDiffSegments(lcsOperations(beforeLines, afterLines), "lines"),
  };
}

function stringListChangeDetails(before, after) {
  const beforeItems = cleanStrings(before);
  const afterItems = cleanStrings(after);
  const beforeSet = new Set(beforeItems);
  const afterSet = new Set(afterItems);
  const added = afterItems.filter((item) => !beforeSet.has(item));
  const removed = beforeItems.filter((item) => !afterSet.has(item));
  const orderChanged =
    added.length === 0
    && removed.length === 0
    && comparable(beforeItems) !== comparable(afterItems);

  if (added.length === 0 && removed.length === 0 && !orderChanged) return null;
  return {
    kind: "string_list",
    added,
    removed,
    ...(orderChanged
      ? {
          orderChanged: true,
          beforeOrder: beforeItems,
          afterOrder: afterItems,
        }
      : {}),
  };
}

function collectionIndex(items, identityKey) {
  const index = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const identity = text(item[identityKey]);
    if (!identity || index.has(identity)) return null;
    index.set(identity, item);
  }
  return index;
}

function collectionItemView(item, spec) {
  return Object.fromEntries(
    spec.fields.map((field) => [field, item?.[field] ?? null])
  );
}

function collectionFieldChanges(beforeItem, afterItem, fields) {
  const changes = [];
  for (const field of fields) {
    const before = beforeItem?.[field] ?? null;
    const after = afterItem?.[field] ?? null;
    if (comparable(before) === comparable(after)) continue;
    changes.push({
      field,
      before: displayValue(before),
      after: displayValue(after),
      ...(typeof before === "string" && typeof after === "string"
        ? { textDiff: buildLineDiff(before, after) }
        : {}),
    });
  }
  return changes;
}

function collectionChangeDetails(key, before, after) {
  const spec = COLLECTION_DIFF_SPECS[key];
  if (!spec || !Array.isArray(before) || !Array.isArray(after)) return null;

  const beforeIndex = collectionIndex(before, spec.identity);
  const afterIndex = collectionIndex(after, spec.identity);
  if (!beforeIndex || !afterIndex) return null;

  const added = [];
  const removed = [];
  const updated = [];

  for (const [identity, item] of afterIndex) {
    if (!beforeIndex.has(identity)) {
      added.push({
        identity,
        item: collectionItemView(item, spec),
      });
      continue;
    }

    const beforeItem = beforeIndex.get(identity);
    if (comparable(beforeItem) !== comparable(item)) {
      updated.push({
        identity,
        changes: collectionFieldChanges(beforeItem, item, spec.fields),
      });
    }
  }

  for (const [identity, item] of beforeIndex) {
    if (!afterIndex.has(identity)) {
      removed.push({
        identity,
        item: collectionItemView(item, spec),
      });
    }
  }

  if (added.length === 0 && removed.length === 0 && updated.length === 0) return null;
  return { kind: "collection", added, removed, updated };
}

function objectChangeDetails(key, before, after) {
  const fields = OBJECT_DIFF_SPECS[key];
  if (!fields || !before || !after || typeof before !== "object" || typeof after !== "object") {
    return null;
  }

  const changes = [];
  for (const field of fields) {
    const beforeValue = before[field] ?? null;
    const afterValue = after[field] ?? null;
    if (comparable(beforeValue) === comparable(afterValue)) continue;

    const listDetails = Array.isArray(beforeValue) && Array.isArray(afterValue)
      ? stringListChangeDetails(beforeValue, afterValue)
      : null;
    changes.push({
      field,
      before: displayValue(beforeValue),
      after: displayValue(afterValue),
      ...(listDetails ? { details: listDetails } : {}),
      ...(!listDetails && typeof beforeValue === "string" && typeof afterValue === "string"
        ? { textDiff: buildLineDiff(beforeValue, afterValue) }
        : {}),
    });
  }

  return changes.length > 0 ? { kind: "object", changes } : null;
}

function meaningfulChangeDetails(key, before, after) {
  if (COLLECTION_DIFF_SPECS[key]) return collectionChangeDetails(key, before, after);
  if (key === "guardrails" || key === "serviceAreas") return stringListChangeDetails(before, after);
  if (OBJECT_DIFF_SPECS[key]) return objectChangeDetails(key, before, after);
  if (TEXT_DIFF_KEYS.has(key) && typeof before === "string" && typeof after === "string") {
    return buildLineDiff(before, after);
  }
  return null;
}

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
    .map((key) => {
      const details = meaningfulChangeDetails(key, currentConfig[key], next[key]);
      return {
        key,
        before: valueSummary(currentConfig[key]),
        after: valueSummary(next[key]),
        ...(details ? { details } : {}),
      };
    });
}

function validationFailure(res, prepared) {
  return res.status(prepared.status || 400).json({
    error: prepared.error,
    unknownKeys: prepared.unknownKeys || undefined,
    invalidKeys: prepared.invalidKeys || undefined,
  });
}
function prepareAdvancedConfigPayload(input, currentConfig) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "Configuration must be a JSON object." };
  }

  const disallowedKeys = Object.keys(input).filter((key) => !EDITABLE_KEYS.includes(key));
  if (disallowedKeys.length > 0) {
    return {
      ok: false,
      status: 400,
      error: `Advanced Config does not allow: ${disallowedKeys.join(", ")}`,
      unknownKeys: disallowedKeys,
    };
  }

  const prepared = prepareConfigUpdatePayload(input, currentConfig);
  if (!prepared.ok) return prepared;

  const stateValidation = validateAdvancedConfigState(currentConfig, prepared.updates);
  if (!stateValidation.ok) return stateValidation;

  return prepared;
}

function historyPayload(rows) {
  return (rows || []).map((row) => ({
    id: Number(row.id),
    editableConfig: editableConfigView(row.editable_config || {}),
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
    const prepared = prepareAdvancedConfigPayload(req.body?.config, current);
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

    const prepared = prepareAdvancedConfigPayload(req.body?.config, current);
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
    const prepared = prepareAdvancedConfigPayload(
      editableConfigView(snapshot.editable_config || {}),
      current
    );
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
module.exports.prepareAdvancedConfigPayload = prepareAdvancedConfigPayload;
module.exports.validateAdvancedConfigState = validateAdvancedConfigState;
module.exports.collectionChangeDetails = collectionChangeDetails;
module.exports.meaningfulChangeDetails = meaningfulChangeDetails;
module.exports.buildLineDiff = buildLineDiff;
module.exports.tokenizeDiffText = tokenizeDiffText;
module.exports.isValidWhatsapp = isValidWhatsapp;
