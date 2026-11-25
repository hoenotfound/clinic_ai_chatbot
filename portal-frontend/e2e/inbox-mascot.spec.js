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
  expect(artBounds.y + artBounds.height).toBeLessThanOrEqual(searchBounds.y + 1);
  await search.fill("test");
  await expect(search).toHaveValue("test");
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
  // A recent staff action postpones roaming even when the original timer expires.
  await page.clock.fastForward(20000);
  await page.evaluate(() => document.dispatchEvent(new Event("keydown")));
  await page.clock.fastForward(10000);
  await expect(stage).toHaveAttribute("data-pose", "idle");
  await page.clock.fastForward(17000);
  await expect(stage).toHaveAttribute("data-pose", "roaming");
  await page.evaluate(() => document.dispatchEvent(new Event("pointerdown")));
  await expect(stage).toHaveAttribute("data-pose", "idle");
  const mobile = await page.evaluate(() => innerWidth < 1024);
  if (mobile) {
    await expect(thread.getByTestId("inbox-mascot")).toBeVisible();
    await expect(thread.getByRole("button", { name: "Conversation actions" })).toBeVisible();
  }
});
