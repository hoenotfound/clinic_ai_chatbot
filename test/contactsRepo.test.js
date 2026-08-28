const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");

test("creates a contact with a race-safe insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /ON CONFLICT \(whatsapp_number\) DO NOTHING/);
    assert.deepEqual(params, ["60123456789", "Patient"]);
    return {
      rows: [{ id: 8, whatsapp_number: "60123456789", whatsapp_profile_name: "Patient" }],
    };
  };

  const contact = await contactsRepo.getOrCreateContact("60123456789", " Patient ");
  assert.equal(contact.id, 8);
});
