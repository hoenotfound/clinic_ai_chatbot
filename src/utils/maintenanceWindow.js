"use strict";

// Non-urgent hourly/daily jobs share five-minute clock boundaries. Defer at
// most five minutes; never apply this to customer sends or stored retry times.
const MAINTENANCE_WINDOW_MS = 5 * 60 * 1000;
function alignedMaintenanceDelay(intervalMs, nowMs = Date.now()) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(nowMs)) {
    throw new TypeError("Maintenance interval and clock must be finite");
  }
  return Math.ceil((nowMs + intervalMs) / MAINTENANCE_WINDOW_MS) * MAINTENANCE_WINDOW_MS - nowMs;
}
module.exports = { MAINTENANCE_WINDOW_MS, alignedMaintenanceDelay };
