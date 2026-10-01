const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

test("Conversation Flow stays out of primary navigation while its route remains available", () => {
  const sidebar = read("portal-frontend/src/components/Sidebar.jsx");
  const app = read("portal-frontend/src/App.jsx");

  assert.doesNotMatch(sidebar, /to: "\/conversation-flow"/);
  assert.doesNotMatch(sidebar, /label: "Conversation Flow"/);
  assert.doesNotMatch(sidebar, /function FlowIcon/);

  assert.match(app, /path="\/conversation-flow"/);
  assert.match(app, /<ConversationFlow \/>/);
});
