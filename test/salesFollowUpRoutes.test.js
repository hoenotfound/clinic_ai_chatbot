const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const followUpRepo = require("../src/db/salesFollowUpRepo");
const salesRoutes = require("../src/routes/salesFollowUp");

test("Sales Follow-up shares Pipeline access scope without granting export or edit permission", async (t) => {
  const previousList = followUpRepo.listPending;
  const previousRecord = followUpRepo.recordOutcome;
  const previousRecent = followUpRepo.listRecentCorrections;
  const seen = [];
  followUpRepo.listPending = async (options) => {
    seen.push({ kind: "list", ...options });
    return [{ leadId: 17, owner: "Unassigned", temperature: "hot" }];
  };
  followUpRepo.recordOutcome = async (options) => {
    seen.push({ kind: "record", ...options });
    return { ok: true };
  };
  followUpRepo.listRecentCorrections = async (options) => {
    seen.push({ kind: "recent", ...options });
    return [];
  };
  t.after(() => {
    followUpRepo.listPending = previousList;
    followUpRepo.recordOutcome = previousRecord;
    followUpRepo.listRecentCorrections = previousRecent;
  });

  let user = { username: "sales-a", role: "sales" };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use("/sales-follow-up", salesRoutes);
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.on("error", reject);
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const base = "http://127.0.0.1:" + server.address().port + "/sales-follow-up";
  const get = (path) => fetch(base + path);
  const patch = () => fetch(base + "/17/outcome", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "contacted", expectedLastInboundId: 88,
      dueAt: "2026-11-01T10:00:00Z" })
  });

  // The built-in Sales role has view_all_leads but not admin export/assignment.
  assert.equal((await get("/")).status, 200);
  assert.equal(seen.at(-1).canViewAll, true);
  assert.equal((await get("/recent")).status, 200);
  assert.equal(seen.at(-1).canViewAll, true);
  assert.equal((await patch()).status, 200);
  assert.equal(seen.at(-1).canManageAll, true);
  assert.equal((await get("/export?period=weekly")).status, 403);

  // Disabling global visibility scopes ordinary sales staff to assignments.
  user = { username: "sales-b", role: "sales",
    permissions: { view_all_leads: false, view_assigned_leads: true } };
  assert.equal((await get("/")).status, 200);
  assert.equal(seen.at(-1).canViewAll, false);
  assert.equal((await patch()).status, 200);
  assert.equal(seen.at(-1).canManageAll, false);

  // Global viewing alone does not grant staff mutation rights.
  user = { username: "viewer", role: "sales",
    permissions: { manage_assigned_leads: false } };
  assert.equal((await get("/")).status, 200);
  assert.equal((await patch()).status, 403);
  assert.equal((await get("/recent")).status, 403);

  user = { username: "no-access", role: "sales",
    permissions: { view_all_leads: false, view_assigned_leads: false } };
  assert.equal((await get("/")).status, 403);
  assert.equal((await patch()).status, 403);
});
