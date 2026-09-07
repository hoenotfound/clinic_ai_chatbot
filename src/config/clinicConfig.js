const { getInitialConfig } = require("./industryProfiles");

/**
 * Live business config shared by every module that still imports the historical
 * `clinicConfig` path. The filename stays in place for backward compatibility
 * while the product is migrated to industry-neutral naming.
 *
 * db/configRepo.js mutates this object's properties in place, so Settings saves
 * and database loads are visible immediately to every already-required module
 * without restarting the process.
 *
 * Before Postgres has loaded, start from the selected initial industry profile.
 * Existing deployments with no INITIAL_BUSINESS_TYPE continue to default to the
 * aesthetic-clinic profile, preserving the current production behavior.
 */
const clinicConfig = getInitialConfig();

module.exports = clinicConfig;
