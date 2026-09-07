const {
  DEFAULT_BUSINESS_TYPE,
  getIndustryProfile,
} = require("./industryProfiles");

/**
 * Live business config shared by every module that still imports the historical
 * `clinicConfig` path. The filename stays in place for backward compatibility
 * while the product is migrated to industry-neutral naming.
 *
 * db/configRepo.js mutates this object's properties in place, so Settings saves
 * and database loads are visible immediately to every already-required module
 * without restarting the process.
 *
 * Start with the legacy-safe clinic profile only for the brief pre-database
 * bootstrap window. The deployment's INITIAL_BUSINESS_TYPE is deliberately read
 * by configRepo only when it discovers a genuinely fresh database. That means a
 * typo or changed provisioning env cannot prevent an existing client's stored
 * profile from loading on restart.
 */
const clinicConfig = getIndustryProfile(DEFAULT_BUSINESS_TYPE);

module.exports = clinicConfig;
