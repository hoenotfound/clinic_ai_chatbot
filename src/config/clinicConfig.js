const defaultConfig = require("./clinicConfig.default");

/**
 * The live clinic config — every module that does
 * `require("../config/clinicConfig")` gets this exact same object
 * reference. That's deliberate: db/configRepo.js updates the *properties*
 * of this object in place (rather than replacing the export), so a save
 * from the portal's Settings page is picked up immediately everywhere it's
 * used (systemPrompt.js, server.js, etc.) with zero restart, since they all
 * read `clinicConfig.whatever` fresh on every message rather than caching
 * values at require-time.
 *
 * Starts out as a copy of the hardcoded defaults so the bot behaves
 * sensibly even in the brief window before configRepo.loadConfig() finishes
 * reading the real value from Postgres at startup.
 */
const clinicConfig = { ...defaultConfig };

module.exports = clinicConfig;
