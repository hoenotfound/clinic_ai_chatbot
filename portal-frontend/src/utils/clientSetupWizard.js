const PLACEHOLDER_BUSINESS_NAMES = new Set([
  "Your Clinic",
  "Your Renovation Business",
  "Your Business",
]);

export const CLIENT_SETUP_STORAGE_VERSION = 1;
export const CLIENT_SETUP_CONFIG_STEPS = Object.freeze([
  "business",
  "locations",
  "operating",
  "offerings",
  "knowledge",
  "aiBehavior",
  "handoff",
  "promotions",
]);
export const CLIENT_SETUP_SCREENS = Object.freeze([
  "welcome",
  ...CLIENT_SETUP_CONFIG_STEPS,
  "review",
  "goLive",
]);

function text(value) {
  return String(value || "").trim();
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function emptyCompletion() {
  return {
    sections: [],
    requiredCompletedCount: 0,
    requiredTotal: 0,
    optionalConfiguredCount: 0,
    optionalTotal: 0,
    requiredComplete: false,
    incompleteRequired: [],
  };
}

export function isPlaceholderBusinessName(value) {
  return PLACEHOLDER_BUSINESS_NAMES.has(text(value));
}

export function getClientSetupCompletion(config = {}) {
  const status = config?.clientSetup;
  if (!status || !Array.isArray(status.sections)) return emptyCompletion();
  return {
    ...emptyCompletion(),
    ...status,
    sections: status.sections,
    incompleteRequired: Array.isArray(status.incompleteRequired)
      ? status.incompleteRequired
      : [],
  };
}

export function isFreshClientSetupCandidate(config = {}) {
  const setup = config?.industrySetup || {};
  const source = text(setup.source);
  const completion = getClientSetupCompletion(config);
  if (!isPlaceholderBusinessName(config.businessName || config.clinicName)) return false;
  if (source === "legacy") return false;
  const freshSelectable = source === "default" && setup.selectable === true && setup.locked !== true;
  const freshLocked = ["environment", "setup_status"].includes(source)
    && setup.locked === true
    && setup.selectable !== true;
  if (!freshSelectable && !freshLocked) return false;
  return !completion.requiredComplete;
}

export function getClientSetupStorageKey(username, businessType) {
  const safeUser = text(username) || "unknown";
  const safeType = text(businessType) || "generic";
  return `da-chatbot:client-setup:v${CLIENT_SETUP_STORAGE_VERSION}:${safeUser}:${safeType}`;
}

export function readClientSetupProgress(username, businessType, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(getClientSetupStorageKey(username, businessType));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CLIENT_SETUP_STORAGE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeClientSetupProgress(username, businessType, updates, storage = defaultStorage()) {
  if (!storage) return null;
  try {
    const current = readClientSetupProgress(username, businessType, storage) || {};
    const next = {
      version: CLIENT_SETUP_STORAGE_VERSION,
      started: true,
      dismissed: false,
      completed: false,
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    storage.setItem(getClientSetupStorageKey(username, businessType), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

export function validClientSetupScreen(value) {
  return CLIENT_SETUP_SCREENS.includes(value) ? value : "welcome";
}

export function shouldAutoStartClientSetup(config, progress) {
  if (getClientSetupCompletion(config).requiredComplete) return false;
  if (progress?.completed || progress?.dismissed) return false;
  if (progress?.started) return true;
  return isFreshClientSetupCandidate(config);
}
