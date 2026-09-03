const test = require("node:test");
const assert = require("node:assert/strict");

const {
  findWaitingStaffOwnedConversations,
  isStillWaitingForStaff,
} = require("../src/services/staffWaitingAlertService");

test("AI and automated assistant replies do not count as the staff response", async () => {
  let discoverySql = "";
  await findWaitingStaffOwnedConversations(
    {},
    async (sql) => {
      discoverySql = String(sql);
      return { rows: [] };
    }
  );

  assert.match(discoverySql, /m\.sent_by_username IS NOT NULL/);
  assert.match(discoverySql, /m\.is_automated_follow_up = false/);

  let revalidationSql = "";
  await isStillWaitingForStaff(
    12,
    45,
    async (sql) => {
      revalidationSql = String(sql);
      return { rows: [{ waiting: true }] };
    }
  );

  assert.match(revalidationSql, /outbound\.sent_by_username IS NOT NULL/);
  assert.match(revalidationSql, /outbound\.is_automated_follow_up = false/);
});
