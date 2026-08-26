const { pool } = require("./db");
const clinicConfig = require("../config/clinicConfig");
const defaultConfig = require("../config/clinicConfig.default");

// Every top-level key the Settings page is allowed to read/write. Kept as a
// single list shared by loadConfig/updateConfig so there's one place to
// touch if a new config section is ever added.
const CONFIG_KEYS = [
  "clinicName",
  "aiAssistantName",
  "branches",
  "hours",
  "contact",
  "introMessage",
  "promotions",
  "services",
  "serviceAliases",
  "faqs",
  "closingPlaybook",
  "tone",
  "messagingStyle",
  "sop",
  "escalation",
  "guardrails",
];

/**
 * Loads the DB-backed config into the shared `clinicConfig` object,
 * mutating its properties in place (not replacing the object — see
 * config/clinicConfig.js for why that matters). Called once at server
 * startup, after initSchema(). On a brand-new database the clinic_config
 * table is empty, so this seeds it from the hardcoded defaults first —
 * same "auto-bootstrap on first run" pattern as bootstrapAdminUser().
 */
async function loadConfig() {
  const result = await pool.query("SELECT data FROM clinic_config WHERE id = 1");

  if (result.rows.length === 0) {
    await pool.query("INSERT INTO clinic_config (id, data) VALUES (1, $1)", [defaultConfig]);
    Object.assign(clinicConfig, defaultConfig);
    console.log("Seeded clinic_config table from config/clinicConfig.default.js.");
    return clinicConfig;
  }

  Object.assign(clinicConfig, result.rows[0].data);
  return clinicConfig;
}

/** Returns the live, in-memory config object (see config/clinicConfig.js). */
function getConfig() {
  return clinicConfig;
}

/**
 * Applies a partial update — only recognized top-level keys present in
 * `updates` are touched, everything else in the current config is left
 * alone. Updates both the in-memory object (so the AI picks it up on the
 * very next message, no restart) and the DB row (so it survives one).
 */
async function updateConfig(updates) {
  for (const key of CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      clinicConfig[key] = updates[key];
    }
  }

  await pool.query("UPDATE clinic_config SET data = $1, updated_at = now() WHERE id = 1", [
    clinicConfig,
  ]);

  return clinicConfig;
}

module.exports = { CONFIG_KEYS, loadConfig, getConfig, updateConfig };
