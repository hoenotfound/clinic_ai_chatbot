const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("sidebar keeps compact labels stacked until very wide desktop", () => {
  const sidebarSource = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "components", "Sidebar.jsx"),
    "utf8"
  );
  const cssSource = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "index.css"),
    "utf8"
  );

  assert.match(sidebarSource, /className="app-sidebar /);
  assert.match(sidebarSource, /app-sidebar-nav-item/);
  assert.match(sidebarSource, /app-sidebar-compact-label/);
  assert.match(sidebarSource, /app-sidebar-full-label/);
  assert.doesNotMatch(sidebarSource, /min-\[1440px\]/);

  assert.match(cssSource, /\.app-sidebar\s*\{[\s\S]*?width:\s*4\.5rem/);
  assert.match(cssSource, /\.app-sidebar-nav-item,[\s\S]*?flex-direction:\s*column/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?width:\s*15rem/);
});
