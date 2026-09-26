const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("sidebar uses coherent layouts across phone tablet laptop and desktop", () => {
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

  // Phone: smallest persistent rail, stacked icon + label, no horizontal spill.
  assert.match(cssSource, /\.app-sidebar\s*\{[\s\S]*?width:\s*4rem;[\s\S]*?overflow-x:\s*hidden/);
  assert.match(cssSource, /\.app-sidebar-nav-item,[\s\S]*?flex-direction:\s*column/);
  assert.match(cssSource, /font-size:\s*0\.5625rem/);

  // Tablet / small laptop / normal Mac browser widths.
  assert.match(cssSource, /@media \(min-width:\s*640px\) and \(max-width:\s*1599px\)/);
  assert.match(cssSource, /@media \(min-width:\s*640px\) and \(max-width:\s*1599px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?width:\s*4\.5rem/);

  // Short landscape screens remain usable without clipping navigation.
  assert.match(cssSource, /@media \(max-height:\s*640px\) and \(max-width:\s*1599px\)/);
  assert.match(sidebarSource, /overflow-y-auto/);

  // Wide desktop: width, direction and labels switch together.
  assert.match(cssSource, /@media \(min-width:\s*1600px\)/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?width:\s*15rem/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)[\s\S]*?flex-direction:\s*row/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)[\s\S]*?\.app-sidebar-compact-label\s*\{[\s\S]*?display:\s*none/);
  assert.match(cssSource, /@media \(min-width:\s*1600px\)[\s\S]*?\.app-sidebar-full-label\s*\{[\s\S]*?display:\s*inline/);
});
