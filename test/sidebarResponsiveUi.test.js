const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("sidebar uses coherent compact and expanded layouts across phone tablet laptop and desktop", () => {
  const sidebarSource = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "components", "Sidebar.jsx"),
    "utf8"
  );
  const cssSource = fs.readFileSync(
    path.join(__dirname, "..", "portal-frontend", "src", "index.css"),
    "utf8"
  );

  assert.match(sidebarSource, /data-testid="app-sidebar"/);
  assert.match(sidebarSource, /SIDEBAR_STORAGE_KEY = "portal\.sidebar\.expanded"/);
  assert.match(sidebarSource, /matchMedia\("\(min-width: 1280px\)"\)/);
  assert.match(sidebarSource, /aria-label=\{sidebarExpanded \? "Collapse sidebar" : "Expand sidebar"\}/);
  assert.match(sidebarSource, /className="app-sidebar-label truncate"/);
  assert.match(sidebarSource, /role="tooltip"/);
  assert.doesNotMatch(sidebarSource, /app-sidebar-compact-label/);
  assert.doesNotMatch(sidebarSource, /app-sidebar-full-label/);
  assert.doesNotMatch(sidebarSource, /min-\[1440px\]/);

  // Phone: 64px icon-only rail. A saved desktop preference must not widen it.
  assert.match(cssSource, /\.app-sidebar\s*\{[\s\S]*?width:\s*4rem;/);
  assert.match(cssSource, /\.app-sidebar-brand-copy,[\s\S]*?\.app-sidebar-label,[\s\S]*?max-width:\s*0;[\s\S]*?opacity:\s*0;/);
  assert.match(cssSource, /@media \(max-width:\s*639px\)[\s\S]*?\.app-sidebar\[data-expanded="true"\]\s*\{[\s\S]*?width:\s*4rem;/);

  // Tablet / laptop: 72px compact rail, 220px expanded sidebar, with a visible toggle.
  assert.match(cssSource, /@media \(min-width:\s*640px\)/);
  assert.match(cssSource, /@media \(min-width:\s*640px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?width:\s*4\.5rem;/);
  assert.match(cssSource, /@media \(min-width:\s*640px\)[\s\S]*?\.app-sidebar-toggle\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(cssSource, /\.app-sidebar\[data-expanded="true"\]\s*\{[\s\S]*?width:\s*13\.75rem;/);
  assert.match(cssSource, /\.app-sidebar\[data-expanded="true"\] \.app-sidebar-label\s*\{[\s\S]*?opacity:\s*1;/);

  // Settings is kept in the utility area instead of the primary work navigation.
  assert.match(sidebarSource, /const SETTINGS_ITEM = \{/);
  assert.match(sidebarSource, /<div className="app-sidebar-utility/);
  assert.match(sidebarSource, /item=\{SETTINGS_ITEM\}/);

  // Short landscape screens retain compact row heights and scrollable primary navigation.
  assert.match(cssSource, /@media \(max-height:\s*640px\)/);
  assert.match(sidebarSource, /overflow-y-auto/);

  // The old 1600px-only full sidebar and stacked micro-labels are gone.
  assert.doesNotMatch(cssSource, /@media \(min-width:\s*1600px\)/);
  assert.doesNotMatch(cssSource, /font-size:\s*0\.5625rem/);
  assert.doesNotMatch(cssSource, /flex-direction:\s*column/);
});
