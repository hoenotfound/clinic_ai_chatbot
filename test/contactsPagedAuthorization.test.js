"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const usersRepo = require("../src/db/usersRepo");
const { requireAuth } = require("../src/middleware/requireAuth");

async function withContactsServer(user, callback) {
  const original = usersRepo.getUserById;
  usersRepo.getUserById = async () => user;
  const app = express();
  app.use((req, _res, next) => {
    req.session = { userId: user.id, authVersion: 0 };
    next();
  });
  const contacts = express.Router();
  contacts.get("/paged", (_req, res) => res.json({ items: [], total: 0 }));
  contacts.get("/", (_req, res) => res.json([]));
  app.use("/api/contacts", requireAuth, contacts);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    usersRepo.getUserById = original;
  }
}

test("GET /api/contacts/paged permits all-leads viewers", async () => {
  await withContactsServer({
    id: 1, username: "admin1", role: "admin", auth_version: 0,
    permissions: { view_all_leads: true },
  }, async (base) => {
    const response = await fetch(base + "/api/contacts/paged");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], total: 0 });
  });
});

test("GET /api/contacts/paged permits assigned-leads viewers without granting export", async () => {
  await withContactsServer({
    id: 2, username: "staff1", role: "sales", auth_version: 0,
    permissions: {
      view_all_leads: false, view_assigned_leads: true,
      export_customer_data: false,
    },
  }, async (base) => {
    const response = await fetch(base + "/api/contacts/paged");
    assert.equal(response.status, 200);
    assert.equal((await fetch(base + "/api/contacts/export")).status, 403);
  });
});

test("paged directory denies accounts without lead-view permission", async () => {
  await withContactsServer({
    id: 3, username: "no-view", role: "sales", auth_version: 0,
    permissions: { view_all_leads: false, view_assigned_leads: false },
  }, async (base) => {
    assert.equal((await fetch(base + "/api/contacts/paged")).status, 403);
    assert.equal((await fetch(base + "/api/contacts/")).status, 403);
  });
});

test("paged directory rejects writes and nested paths", async () => {
  await withContactsServer({
    id: 4, username: "admin2", role: "admin", auth_version: 0,
  }, async (base) => {
    assert.equal((await fetch(base + "/api/contacts/paged", { method: "POST" })).status, 403);
    assert.equal((await fetch(base + "/api/contacts/paged/123")).status, 403);
  });
});
