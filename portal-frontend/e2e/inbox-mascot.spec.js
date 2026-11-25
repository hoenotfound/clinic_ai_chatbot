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
