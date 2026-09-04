const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sha256,
  validateAppliedMigrations,
} = require("../src/db/migrationRunner");

function migration(version, name) {
  const sql = `SELECT ${version}`;
  return { version, name, sql, checksum: sha256(Buffer.from(sql)) };
}

test("database migration history must be a contiguous prefix of the app migration plan", () => {
  const plan = [migration(1, "one"), migration(2, "two"), migration(3, "three")];

  assert.throws(
    () =>
      validateAppliedMigrations(
        [
          { version: 1, name: "one", checksum: plan[0].checksum },
          { version: 3, name: "three", checksum: plan[2].checksum },
        ],
        plan
      ),
    /migration history.*expected version 2/i
  );
});
