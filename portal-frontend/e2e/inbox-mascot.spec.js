import { expect, test } from "@playwright/test";

test("Dashy preserves Inbox controls and offers personal appearance modes", async ({ page }) => {
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
  await page.getByLabel("Dashy size").selectOption("small");
  await expect.poll(async () => (await mascot.boundingBox()).width).toBe(65);
  await page.getByRole("button", { name: "Reset position" }).click();
  await expect(page.getByRole("button", { name: "Pause animation" })).toHaveCount(0);
  // Chromium touch events are real browser-dispatched pointer events, not synthetic React calls.
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) {
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
    await expect.poll(async () => { const r = await mascot.boundingBox(); return r.x >= 0 && r.y >= 0 && r.x + r.width <= viewport.height + 1 && r.y + r.height <= viewport.width + 1; }).toBe(true);
    await page.setViewportSize(viewport);
    // Model a software keyboard reducing visualViewport without resizing the layout viewport.
    await page.evaluate(() => {
      const fake = new EventTarget(); Object.assign(fake, { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: Math.floor(innerHeight * .6) });
      Object.defineProperty(window, "visualViewport", { configurable: true, value: fake });
      window.dispatchEvent(new Event("resize"));
    });
    await expect.poll(async () => { const r = await mascot.boundingBox(); return !r || r.y + r.height <= await page.evaluate(() => visualViewport.height + 1); }).toBe(true);
    await page.evaluate(() => { delete window.visualViewport; window.dispatchEvent(new Event("resize")); });
  }
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
  await page.clock.fastForward(65000);
  await page.evaluate(() => document.dispatchEvent(new Event("keydown")));
  await page.clock.fastForward(20000);
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await page.clock.fastForward(56000);
  const desktop = await page.evaluate(() => matchMedia("(min-width: 1024px)").matches);
  await expect(stage).toHaveAttribute("data-pose", desktop ? "roaming" : "idle");
  await page.evaluate(() => document.dispatchEvent(new Event("pointerdown")));
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await expect(thread.getByRole("button", { name: "Conversation actions" })).toBeVisible();
});
