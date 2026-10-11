const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const usersRepo = require("../src/db/usersRepo");
const { requireAuth } = require("../src/middleware/requireAuth");

test("review resolution requires Manage Assigned Leads, not merely read access", async (t) => {
  const originalUserLookup = usersRepo.getUserById;
  let mayManage = false;
  usersRepo.getUserById = async () => ({
    id: 1,
    username: "reviewer",
    role: "sales",
    auth_version: 0,
    is_active: true,
    permissions: {
      view_all_leads: true,
      view_assigned_leads: true,
      reply_to_assigned_leads: true,
      manage_assigned_leads: mayManage,
    },
  });
  t.after(() => { usersRepo.getUserById = originalUserLookup; });

  let resolutionCalls = 0;
  let readCalls = 0;
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: 1, authVersion: 0 };
    next();
  });
  const router = express.Router();
  router.patch("/:contactId/reviews/:reviewId/resolve", (_req, res) => {
    resolutionCalls += 1;
    res.json({ status: "resolved" });
  });
  router.patch("/:contactId/read-state", (_req, res) => {
    readCalls += 1;
    res.json({ status: "read" });
  });
  app.use("/api/conversations", requireAuth, router);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const patch = (uri) => fetch(`${origin}/api/conversations/201/${uri}`, {
    method: "PATCH",
  });
  const forbidden = await patch("reviews/37/resolve");
  assert.equal(forbidden.status, 403);
  assert.match((await forbidden.json()).error, /Managing assigned leads/i);
  assert.equal(resolutionCalls, 0, "view-only staff must never update reviews");

  const reading = await patch("read-state");
  assert.equal(reading.status, 200, "read metadata stays a view-only action");
  assert.equal(readCalls, 1);

  mayManage = true;
  const authorized = await patch("reviews/37/resolve");
  assert.equal(authorized.status, 200);
  assert.equal(resolutionCalls, 1);
});
