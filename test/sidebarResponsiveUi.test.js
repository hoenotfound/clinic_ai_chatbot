const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("sidebar uses coherent compact expanded and mobile-overlay layouts", () => {
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
  assert.match(sidebarSource, /matchMedia\("\(max-width: 639px\)"\)/);
  assert.match(sidebarSource, /data-mobile-open=\{mobileOpen \? "true" : "false"\}/);\n  assert.match(sidebarSource, /data-inbox-thread=\{inboxThreadOpen \? "true" : "false"\}/);\n  assert.match(sidebarSource, /location\.pathname === "\\/inbox"/);
  assert.match(sidebarSource, /aria-label="Dismiss navigation"/);
  assert.match(sidebarSource, /aria-controls="portal-sidebar-primary-nav"/);
  assert.match(sidebarSource, /aria-label="Utility navigation"/);
  assert.match(sidebarSource, /className="app-sidebar-label truncate"/);
  assert.match(sidebarSource, /role="tooltip"/);
  assert.doesNotMatch(sidebarSource, /app-sidebar-compact-label/);
  assert.doesNotMatch(sidebarSource, /app-sidebar-full-label/);
  assert.doesNotMatch(sidebarSource, /min-\[1440px\]/);

  // Open Inbox threads use the full compact viewport instead of keeping the navigation rail visible.\n  assert.match(cssSource, /@media \(max-width:\s*1023px\)[\\s\\S]*?\.app-sidebar\[data-inbox-thread="true"\][\\s\\S]*?display:\s*none;/);\n\n  // Phone: 64px layout rail with a temporary 220px discoverable panel.
  assert.match(cssSource, /\.app-sidebar\s*\{[\s\S]*?width:\s*4rem;/);
  assert.match(cssSource, /@media \(max-width:\s*639px\)/);
  assert.match(cssSource, /\.app-sidebar-mobile-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?left:\s*13\.75rem;/);
  assert.match(cssSource, /\.app-sidebar\[data-mobile-open="true"\]::before[\s\S]*?width:\s*13\.75rem;/);
  assert.match(cssSource, /\.app-sidebar\[data-mobile-open="true"\] \.app-sidebar-label[\s\S]*?opacity:\s*1;/);

  // Toggle keeps a 44px hit target while the visible circle remains 24px.
  assert.match(cssSource, /\.app-sidebar-toggle\s*\{[\s\S]*?height:\s*2\.75rem;[\s\S]*?width:\s*2\.75rem;/);
  assert.match(cssSource, /\.app-sidebar-toggle-visual\s*\{[\s\S]*?height:\s*1\.5rem;[\s\S]*?width:\s*1\.5rem;/);

  // Tablet / laptop: 72px compact rail and 220px expanded sidebar.
  assert.match(cssSource, /@media \(min-width:\s*640px\)/);
  assert.match(cssSource, /@media \(min-width:\s*640px\)[\s\S]*?\.app-sidebar\s*\{[\s\S]*?width:\s*4\.5rem;/);
  assert.match(cssSource, /\.app-sidebar\[data-expanded="true"\]\s*\{[\s\S]*?width:\s*13\.75rem;/);
  assert.match(cssSource, /\.app-sidebar\[data-expanded="true"\] \.app-sidebar-label\s*\{[\s\S]*?opacity:\s*1;/);

  // Expanded navigation stays refined at 14px rather than inheriting 16px body text.
  assert.match(cssSource, /\.app-sidebar-nav-item,[\s\S]*?font-size:\s*0\.875rem;/);

  // Settings is kept in a dedicated utility navigation landmark.
  assert.match(sidebarSource, /const SETTINGS_ITEM = \{/);
  assert.match(sidebarSource, /<nav aria-label="Utility navigation">/);
  assert.match(sidebarSource, /item=\{SETTINGS_ITEM\}/);

  // Short landscape screens retain compact row heights and scrollable primary navigation.
  assert.match(cssSource, /@media \(max-height:\s*640px\)/);
  assert.match(sidebarSource, /overflow-y-auto/);

  // The old 1600px-only full sidebar and stacked micro-labels are gone.
  assert.doesNotMatch(cssSource, /@media \(min-width:\s*1600px\)/);
  assert.doesNotMatch(cssSource, /font-size:\s*0\.5625rem/);
  assert.doesNotMatch(cssSource, /flex-direction:\s*column/);
});
