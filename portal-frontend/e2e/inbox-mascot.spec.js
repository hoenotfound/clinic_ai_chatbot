import { expect, test } from "@playwright/test";

test("Inbox mascot is optional, loads original art and respects reduced motion", async ({ page }) => {
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
  const toggle = page.getByTestId("inbox-mascot-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => toggle.locator("img").first().evaluate(img => img.naturalWidth)).toBe(110);
  await expect(toggle.locator(".da-inbox-mascot-hover")).toHaveCSS("animation-name", "none");
  const search = page.getByRole("searchbox", { name: /Search by name/ });
  await expect(search).toBeVisible();
  await search.fill("test");
  await expect(search).toHaveValue("test");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle.locator("img")).toHaveCount(0);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(toggle.locator("img")).toHaveCount(5);
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth, viewport: innerWidth,
  }));
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport + 1);
});
