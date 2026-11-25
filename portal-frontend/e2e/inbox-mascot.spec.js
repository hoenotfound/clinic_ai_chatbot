import { expect, test } from "@playwright/test";

async function mockEmptyDashyInbox(page) {
  await page.addInitScript(() => {
    class StubEventSource {
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    window.EventSource = StubEventSource;
  });
  const user = { username: "mascot-reviewer", role: "admin", permissions: {
    view_all_leads: true, view_assigned_leads: true, reply_to_assigned_leads: true,
    manage_assigned_leads: true,
  } };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const value = path === "/api/auth/me" ? { user, username: user.username }
      : path === "/api/auth/branding" ? { clientName: "Test Clinic", clientLogoUrl: "" }
      : path === "/api/conversations" ? [] : {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
}

test("Dashy preserves Inbox controls and offers personal appearance modes", async ({ page }) => {
  await mockEmptyDashyInbox(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/inbox");
  const mascot = page.getByTestId("inbox-mascot");
  await expect(mascot).toBeVisible();
  await expect.poll(() => mascot.locator("img").first().evaluate(img => img.naturalWidth)).toBe(160);
  await expect(mascot.locator(".da-mascot-drift")).toHaveCSS("animation-name", "none");
  const search = page.getByRole("searchbox", { name: /Search by name/ });
  const artBounds = await mascot.locator(".da-mascot-stage").boundingBox();
  const searchBounds = await search.boundingBox();
  expect(artBounds).not.toBeNull();
  expect(searchBounds).not.toBeNull();
  expect(artBounds.y >= searchBounds.y + searchBounds.height || artBounds.x >= searchBounds.x + searchBounds.width || artBounds.x + artBounds.width <= searchBounds.x).toBeTruthy();
  await search.fill("test");
  await expect(search).toHaveValue("test");
  const before = await mascot.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 - 100, before.y + before.height / 2 - 30, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Pause animation" })).toHaveCount(0);
  await expect.poll(async () => Math.abs((await mascot.boundingBox()).x - before.x)).toBeGreaterThan(20);
  const moved = await mascot.boundingBox();
  // Transparent corners must not consume clicks; the center remains draggable.
  expect(await mascot.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.left + 2, r.top + 2)); })).toBe(false);
  await page.reload();
  await expect(mascot).toBeVisible();
  await expect.poll(async () => Math.abs((await mascot.boundingBox()).x - moved.x)).toBeLessThan(2);
  await mascot.focus();
  await mascot.press("ArrowLeft");
  await expect.poll(async () => (await mascot.boundingBox()).x).toBeLessThan(moved.x - 5);
  await mascot.press("Enter");
  await expect(page.getByRole("button", { name: "Pause animation" })).toBeVisible();
  // Verify the real close button independently of dynamic theme mutations.
  await page.getByRole("button", { name: "Close Dashy controls" }).click();
  await expect(page.getByRole("group", { name: "Dashy controls" })).toHaveCount(0);
  await expect(mascot).toBeFocused();
  await mascot.press("Enter");
  await expect(page.getByRole("button", { name: "Pause animation" })).toBeVisible();
  await page.getByRole("radio", { name: "Dashy size small" }).check();
  await expect.poll(async () => (await mascot.boundingBox()).width).toBe(65);
  await page.getByRole("button", { name: "Reset position" }).click();
  await expect(page.getByRole("button", { name: "Pause animation" })).toHaveCount(0);
  const savedPosition = await mascot.boundingBox();
  await mascot.press("Enter");
  await page.getByRole("button", { name: "Minimise temporarily" }).click();
  await expect(page.getByRole("button", { name: "Restore Dashy" })).toBeVisible();
  await expect.poll(async () => (await mascot.boundingBox()).width).toBe(44);
  await expect(page).toHaveURL(/\/inbox/);
  await page.getByRole("button", { name: "Restore Dashy" }).press("Enter");
  await expect.poll(async () => (await mascot.boundingBox()).width).toBe(65);
  await expect.poll(async () => Math.abs((await mascot.boundingBox()).x - savedPosition.x)).toBeLessThan(2);
  await page.goto("/settings/appearance");
  const preview = page.getByLabel("Preview Dashy expression");
  for (const pose of ["greeting", "roaming", "searching", "thinking", "success", "alert", "welcome", "blocked", "confident", "idle"]) {
    await preview.selectOption(pose);
    await expect(page.locator(".da-mascot-stage")).toHaveAttribute("data-pose", pose);
    await expect.poll(() => page.locator(".da-mascot-image").evaluate(img => img.naturalWidth)).toBe(160);
  }
  await page.getByRole("radio", { name: /Stationary/ }).check();
  await page.goto("/inbox");
  await expect(mascot.locator(".da-mascot-stage")).toHaveAttribute("data-mode", "stationary");
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: /Hidden/ }).check();
  await page.goto("/inbox");
  await expect(mascot).toHaveCount(0);
  await page.reload();
  await expect(mascot).toHaveCount(0);
  await page.goto("/settings/appearance");
  await page.getByRole("radio", { name: /Animated/ }).check();
  await page.goto("/inbox");
  await expect(mascot).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, viewport: innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
});


test("Dashy gently hovers on desktop and touch screens and pauses for typing", async ({ page }) => {
  await mockEmptyDashyInbox(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/inbox");
  const mascot = page.getByTestId("inbox-mascot");
  const stage = mascot.locator(".da-mascot-stage");
  const drift = mascot.locator(".da-mascot-drift");
  await expect(mascot).toBeVisible();
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle");
  const compact = await page.evaluate(() => matchMedia("(max-width: 1023px), (pointer: coarse)").matches);
  await expect(drift).toHaveCSS("animation-duration", compact ? "4s" : "3.8s");
  const displacement = await drift.evaluate(el => {
    const animation = el.getAnimations().find(a => a.animationName === "da-mascot-idle");
    const duration = animation.effect.getTiming().duration;
    animation.pause();
    animation.currentTime = 0;
    const start = new DOMMatrix(getComputedStyle(el).transform);
    animation.currentTime = duration / 2;
    const middle = new DOMMatrix(getComputedStyle(el).transform);
    animation.play();
    return Math.abs(middle.m42 - start.m42);
  });
  expect(displacement).toBeCloseTo(compact ? 4 : 6, 1);
  const search = page.getByRole("searchbox", { name: /Search by name/ });
  await search.focus();
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle");
  // Dispatch a real editable-input key without starting a search request.
  await search.press("Shift");
  await expect(stage).toHaveAttribute("data-mode", "stationary");
  await expect(drift).toHaveCSS("animation-name", "none");
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle", { timeout: 6000 });
  // A long IME composition must remain still beyond the ordinary typing timeout.
  await search.dispatchEvent("compositionstart");
  await expect(drift).toHaveCSS("animation-name", "none");
  await page.waitForTimeout(2700);
  await expect(drift).toHaveCSS("animation-name", "none");
  await search.dispatchEvent("compositionend");
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle", { timeout: 6000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(drift).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle");
});

test("Dashy roams safely after inactivity on desktop and mobile and stops on interaction", async ({ page }) => {
  await mockEmptyDashyInbox(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await page.goto("/inbox");
  const mascot = page.getByTestId("inbox-mascot");
  const stage = mascot.locator(".da-mascot-stage");
  const drift = mascot.locator(".da-mascot-drift");
  await expect(mascot).toBeVisible();
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle");
  const original = await mascot.boundingBox();
  const compact = await page.evaluate(() => matchMedia("(max-width: 1023px), (pointer: coarse)").matches);
  await page.clock.fastForward(45000);
  await page.evaluate(() => document.dispatchEvent(new Event("pointerdown")));
  await page.clock.fastForward(20000);
  await expect(mascot).toHaveAttribute("data-roaming", "false");
  await page.clock.fastForward(41000);
  await expect(mascot).toHaveAttribute("data-roaming", "true");
  const flight = await mascot.evaluate(el => {
    const animation = el.getAnimations().find(a => a.effect.getTiming().duration >= 2000);
    if (!animation) return null;
    const frame = animation.effect.getKeyframes()[2];
    const matrix = new DOMMatrix(frame.transform);
    return { x: matrix.m41, y: matrix.m42, duration: animation.effect.getTiming().duration };
  });
  expect(flight).not.toBeNull();
  expect(flight.duration).toBe(compact ? 2000 : 2200);
  expect(Math.abs(flight.x)).toBeLessThanOrEqual(compact ? 35 : 72);
  expect(Math.abs(flight.y)).toBeLessThanOrEqual(compact ? 20 : 38);
  expect(Math.hypot(flight.x, flight.y)).toBeGreaterThan(0);
  await page.evaluate(() => document.dispatchEvent(new Event("pointerdown")));
  await expect(mascot).toHaveAttribute("data-roaming", "false");
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await expect.poll(async () => { const r = await mascot.boundingBox(); return Math.hypot(r.x - original.x, r.y - original.y); }).toBeLessThan(2);
  const search = page.getByRole("searchbox", { name: /Search by name/ });
  await search.focus();
  await page.clock.fastForward(61000);
  await expect(mascot).toHaveAttribute("data-roaming", "false");
  await search.evaluate(el => el.blur());
  // An active drag suspends the artwork even with animated mode enabled.
  const box = await mascot.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 - 12, { steps: 4 });
  await expect(mascot).toHaveAttribute("data-dragging", "true");
  await expect(drift).toHaveCSS("animation-name", "none");
  await page.mouse.up();
  await page.mouse.move(1, 1);
  await expect(mascot).toHaveAttribute("data-dragging", "false");
  await expect(drift).toHaveCSS("animation-name", "da-mascot-idle");
});

test("Dashy controls use the local theme palette", async ({ page }) => {
  await mockEmptyDashyInbox(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/inbox");
  const mascot = page.getByTestId("inbox-mascot");
  await expect(mascot).toBeVisible();
  await mascot.press("Enter");
  const controls = page.getByRole("group", { name: "Dashy controls" });
  await expect(controls).toBeVisible();
  await expect(controls).toHaveCSS("background-color", "rgb(255, 255, 255)");
  // Exercise real local CSS inheritance, without toggling a stylesheet's
  // disabled flag (which did not remove its rules in iPhone WebKit).
  // Preserve and restore the original inline values and their priorities.
  const originalTextColor = await controls.evaluate(el => getComputedStyle(el).color);
  const palette = {
    "--color-surface": "#182521", "--color-text": "#f1f5f3",
    "--color-text-muted": "#c2d0c9", "--color-bg": "#101a17",
    "--color-border": "#40534b", "--color-primary": "#84c5b2",
  };
  const originalPalette = await controls.evaluate((el, values) => {
    const shell = el.closest(".wa-inbox-shell");
    if (!shell) throw new Error("Dashy controls must inherit from the Inbox shell");
    const previous = Object.keys(values).map(key => ({
      key, value: shell.style.getPropertyValue(key),
      priority: shell.style.getPropertyPriority(key),
    }));
    for (const [key, value] of Object.entries(values)) shell.style.setProperty(key, value);
    return previous;
  }, palette);
  await expect(controls).toHaveCSS("background-color", "rgb(24, 37, 33)");
  await expect(controls).toHaveCSS("color", "rgb(241, 245, 243)");
  await controls.evaluate((el, previous) => {
    const shell = el.closest(".wa-inbox-shell");
    if (!shell) throw new Error("Dashy controls must inherit from the Inbox shell");
    for (const { key, value, priority } of previous) {
      if (value) shell.style.setProperty(key, value, priority);
      else shell.style.removeProperty(key);
    }
  }, originalPalette);
  await expect(controls).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(controls).toHaveCSS("color", originalTextColor);
  // Menu dismissal and focus restoration are covered by the interaction test.
  // Avoid an unrelated pointer action immediately after a theme mutation.
});

test("Dashy touch dragging and viewport changes keep controls reachable", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP touch input requires Chromium");
  await mockEmptyDashyInbox(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/inbox");
  test.skip(!(await page.evaluate(() => navigator.maxTouchPoints > 0)), "Touch device");
  const mascot = page.getByTestId("inbox-mascot");
  await expect(mascot).toBeVisible();
  const original = await mascot.boundingBox();
  const client = await page.context().newCDPSession(page);
  try {
    const x = Math.round(original.x + original.width / 2), y = Math.round(original.y + original.height / 2);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 60, y: y - 20 }] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(async () => Math.abs((await mascot.boundingBox()).x - original.x)).toBeGreaterThan(20);
    await expect(page.getByRole("group", { name: "Dashy controls" })).toHaveCount(0);
  } finally { await client.detach(); }
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await expect(mascot).toBeVisible();
  await expect.poll(async () => { const r = await mascot.boundingBox(); return !!r && r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.height + 1 && r.y + r.height <= viewport.width + 1; }).toBe(true);
  await page.setViewportSize(viewport);
  await expect(mascot).toBeVisible();
  // Exercise the reduced visible viewport without replacing a native browser
  // object mid-session. The pure geometry unit test also covers a visual
  // viewport that changes independently of the layout viewport.
  const height = Math.floor(viewport.height * .6);
  await page.setViewportSize({ width: viewport.width, height });
  await expect.poll(async () => { const r = await mascot.boundingBox(); return !r || r.y + r.height <= height + 1; }).toBe(true);
  await page.setViewportSize(viewport);
  await expect(mascot).toBeVisible();
});

test("Dashy reacts to selected-thread messages, failures and verified booking sends", async ({ page }) => {
  await page.addInitScript(() => {
    const sources = new Set();
    window.dashyEmit = payload => {
      for (const source of sources) source.listeners.get("conversation_changed")?.({ data: JSON.stringify(payload) });
    };
    class StubEventSource {
      constructor() { this.listeners = new Map(); sources.add(this); setTimeout(() => this.onopen?.(), 0); }
      addEventListener(name, fn) { this.listeners.set(name, fn); }
      removeEventListener(name) { this.listeners.delete(name); }
      close() { sources.delete(this); }
    }
    window.EventSource = StubEventSource;
  });
  const user = { username: "mascot-reviewer", role: "admin", permissions: {
    view_all_leads: true, view_assigned_leads: true, reply_to_assigned_leads: true, manage_assigned_leads: true,
  } };
  const now = new Date().toISOString();
  const contact = { contact_id: 201, name: "Dashy Customer", whatsapp_profile_name: "Dashy Customer",
    whatsapp_number: "60121234567", channel: "whatsapp", mode: "human", takeover_by: user.username, takeover_at: now,
    last_message_at: now, latest_inbound_at: now, latest_customer_message_at: now, last_message: "Hello", last_message_role: "user",
    is_unread: false, has_unreplied: false, needs_attention: false };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let value = {};
    if (path === "/api/auth/me") value = { user, username: user.username };
    else if (path === "/api/auth/branding") value = { clientName: "Test Clinic", clientLogoUrl: "" };
    else if (path === "/api/conversations") value = [contact];
    else if (path === "/api/conversations/201/summary") value = contact;
    else if (path === "/api/conversations/201/attribution") value = { lead: null, attribution: null };
    else if (path === "/api/conversations/201/messages") value = route.request().method() === "POST"
      ? { id: 300, role: "assistant", content: "Appointment confirmed", created_at: now, delivered: true, bookingSynced: true }
      : { messages: [], hasMore: false };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await page.goto("/inbox?contact=201");
  const thread = page.getByRole("region", { name: "Conversation with Dashy Customer" });
  await expect(thread).toBeVisible();
  const mascot = page.getByTestId("inbox-mascot");
  await expect(mascot).toHaveCount(1);
  await expect(mascot).toBeVisible();
  const stage = mascot.locator(".da-mascot-stage");
  await expect(stage).toHaveAttribute("data-pose", "idle");
  const emit = payload => page.evaluate(payload => window.dashyEmit(payload), payload);
  await emit({ contactId: 201, reason: "message", messageId: 101 });
  await expect(stage).toHaveAttribute("data-pose", "greeting");
  await emit({ contactId: 201, deliveryStatus: "failed", messageId: 102 });
  await expect(stage).toHaveAttribute("data-pose", "alert");
  await emit({ contactId: 201, reason: "message", messageId: 103 });
  await expect(stage).toHaveAttribute("data-pose", "alert");
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await emit({ contactId: 201, deliveryStatus: "failed", messageId: 102 });
  await page.clock.runFor(300);
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await thread.locator("textarea").fill("Appointment confirmed");
  await thread.getByRole("button", { name: "Send message" }).click();
  await expect(stage).toHaveAttribute("data-pose", "success");
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await page.evaluate(() => document.activeElement?.blur());
  await page.clock.fastForward(50000);
  await page.evaluate(() => document.dispatchEvent(new Event("keydown")));
  await page.clock.fastForward(20000);
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await page.clock.fastForward(41000);
  // In a populated thread geometry may deliberately reject all flight paths.
  // The dedicated empty-Inbox test below asserts actual roaming on every device.
  const roaming = await mascot.getAttribute("data-roaming");
  await expect(stage).toHaveAttribute("data-pose", roaming === "true" ? "roaming" : "idle");
  await page.evaluate(() => document.dispatchEvent(new Event("pointerdown")));
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await expect(thread.getByRole("button", { name: "Conversation actions" })).toBeVisible();
});
