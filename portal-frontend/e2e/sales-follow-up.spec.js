import { expect, test } from "@playwright/test";

function fakeUser({ exportPermission = false, manage = true } = {}) {
  return {
    id: 1, username: "sales-a", displayName: "Sales A", role: "sales",
    permissions: {
      view_assigned_leads: true, view_all_leads: false,
      manage_assigned_leads: manage,
      export_customer_data: exportPermission,
      manage_tools: false, manage_users: false, manage_settings: false
    },
    businessProfile: null
  };
}

async function mockFollowUps(page, { exportPermission = false, manage = true, outcomeError = false } = {}) {
  const calls = [];
  const lead = {
    leadId: 9, contactId: 20, customerName: "Customer A",
    treatment: "3D 小颜术", temperature: "hot", owner: "sales-a",
    whatsappNumber: "60123456789", whatsappUrl: "https://wa.me/60123456789",
    lastInboundId: 234, lastCustomerReplyAt: "2026-10-24T08:00:00.000Z",
    summary: "Asked about pricing and available dates",
    nextAction: "Ask for preferred appointment date"
  };
  const user = fakeUser({ exportPermission, manage });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    function json(body, status=200) {
      return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (path === "/api/auth/branding") return json({ clientName: "Neutro Sense", clientLogoUrl: "" });
    if (path === "/api/auth/me") return json({ username: user.username, user });
    if (path === "/api/config") return json({ businessName:"Neutro Sense", businessType:"tcm_clinic" });
    if (path === "/api/sales-follow-up" && method === "GET") {
      return json({ leads:[lead], counts:{ pending:1, hot:1, warm:0 }, inactivityHours:48 });
    }
    if (path === "/api/sales-follow-up/9/outcome" && method === "PATCH") {
      const body = request.postDataJSON();
      calls.push(body);
      return outcomeError ? json({ error:"The conversation or lead status has changed. Refresh before updating." },409) : json({ ok:true, leadId:9, status:body.status });
    }
    if (path === "/api/sales-follow-up/export" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "text/csv",
        headers: { "Content-Disposition": 'attachment; filename="sales-follow-up-monthly.csv"', "X-Export-Row-Count":"1" },
        body: 'Customer,WhatsApp Number\r\n"Customer A","60123456789"\r\n'
      });
    }
    return json({},200);
  });
  return calls;
}

test("personal WhatsApp link, manual outcome and stale-conversation ID are correctly wired", async ({ page }) => {
  const calls = await mockFollowUps(page);
  await page.goto("/sales-follow-up");
  await expect(page.getByRole("heading", { name:"Sales Follow-up" })).toBeVisible();
  await expect(page.getByText("Customer A")).toBeVisible();
  await expect(page.getByRole("link", { name:"Open WhatsApp" })).toHaveAttribute("href", "https://wa.me/60123456789");
  await expect(page.getByRole("button", {name: "Export CSV"})).toHaveCount(0);
  await page.getByRole("button", {name: "Update result"}).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", {name:"Save result"}).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({status:"contacted", expectedLastInboundId:234});
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  expect(hasHorizontalOverflow).toBe(false);
});

test("manager export and server-side conflict remain clear", async ({ page }) => {
  const calls = await mockFollowUps(page, { exportPermission:true, outcomeError:true });
  await page.goto("/sales-follow-up");
  await expect(page.getByRole("button", {name:"Export CSV"})).toBeVisible();
  await page.getByLabel("Download list:").selectOption("monthly");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", {name:"Export CSV"}).click()
  ]);
  expect(download.suggestedFilename()).toBe("sales-follow-up-monthly.csv");
  await page.getByRole("button", {name:"Update result"}).click();
  await page.getByRole("button", {name:"Save result"}).click();
  await expect.poll(() => calls.length).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/conversation or lead status has changed/i)).toBeVisible();
});
