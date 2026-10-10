import { expect, test } from "@playwright/test";

const STAFF_USER = {
  id: 2,
  username: "sales-test",
  displayName: "Sales Test",
  role: "sales",
  permissions: {
    view_all_leads: true,
    view_assigned_leads: true,
    reply_to_assigned_leads: true,
    manage_assigned_leads: true,
    view_analytics: true,
    manage_tools: true,
    manage_settings: true,
    create_leads: true,
    manage_pipeline_stages: true,
    manage_lead_assignment: true,
  },
  businessProfile: null,
};

const ADMIN_USER = {
  ...STAFF_USER,
  id: 1,
  username: "admin-test",
  displayName: "Admin Test",
  role: "admin",
  permissions: {
    ...STAFF_USER.permissions,
    manage_users: true,
  },
};

const LONG_FAQ_QUESTION = "我明明不胖可是小腹一直很凸，而且站久了腰容易酸，裤子左右穿起来也不太一样，这种情况是不是跟骨盆或体态有关，应该先做什么评估比较适合我？这是一个特意很长的问题用来测试手机画面不会横向溢出。";

async function mockPortalApi(
  page,
  {
    loggedIn = false,
    user = STAFF_USER,
    pipelineData = null,
    conversations = [],
    conversationAttributionByContact = {},
    conversationMessagesByContact = {},
    metaAdsLeadPreview = { total: 0, leads: [] },
    branding = {
      clientName: "Test Clinic",
      clientLogoUrl: "",
      clientAppIcon180Url: "",
      clientAppIcon192Url: "",
      clientAppIcon512Url: "",
      loginTagline: "Staff portal",
    },
    businessConfig = null,
    onConfigUpdate = null,
    followUpStatus = null,
    followUpStatusFailures = 0,
    templateCatalog = null,
    followUpActivity = null,
    followUpActivityFailures = 0,
    followUpHealth = null,
    followUpPerformance = null,
  } = {}
) {
  let authenticated = loggedIn;
  let remainingFollowUpStatusFailures = followUpStatusFailures;
  let remainingActivityFailures = followUpActivityFailures;
  let advancedConfig = {
    businessName: "Test Clinic",
    clinicName: "Test Clinic",
    businessDescription: "A test clinic",
    aiAssistantName: "Ava",
    introMessage: "Hi, how can I help?",
    tone: "Warm and professional",
    faqs: [{ q: LONG_FAQ_QUESTION, a: "旧答案" }],
    guardrails: ["Rule A", "Rule B", "Rule C"],
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/auth/branding") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(branding),
      });
    }

    if (path === "/api/auth/branding/manifest.webmanifest") {
      return route.fulfill({
        status: 200,
        contentType: "application/manifest+json",
        body: JSON.stringify({
          name: branding.clientName,
          short_name: branding.clientName,
          start_url: "/login",
          display: "standalone",
          icons: [
            {
              src: branding.clientAppIcon192Url || "/app-icons/da-chatbot-192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: branding.clientAppIcon512Url || "/app-icons/da-chatbot-512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
          ],
        }),
      });
    }

    if (path === "/api/auth/me") {
      if (!authenticated) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not logged in." }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ username: user.username, user }),
      });
    }

    if (path === "/api/auth/login" && method === "POST") {
      authenticated = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ username: user.username, user }),
      });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      authenticated = false;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    }

    if (path === "/api/conversations" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(conversations),
      });
    }

    const conversationAttributionMatch = /^\/api\/conversations\/(\d+)\/attribution$/.exec(path);
    if (conversationAttributionMatch && method === "GET") {
      const contactId = Number(conversationAttributionMatch[1]);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          conversationAttributionByContact[contactId]
          || { lead: null, attribution: null }
        ),
      });
    }

    const conversationMessagesMatch = /^\/api\/conversations\/(\d+)\/messages$/.exec(path);
    if (conversationMessagesMatch && method === "GET") {
      const contactId = Number(conversationMessagesMatch[1]);
      const messages = conversationMessagesByContact[contactId] || [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          messages,
          hasMore: false,
          oldestId: messages[0]?.id || null,
          newestId: messages[messages.length - 1]?.id || null,
        }),
      });
    }

    if (path === "/api/pipeline/analytics/meta-ads/leads" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(metaAdsLeadPreview),
      });
    }

    if (path === "/api/pipeline/analytics/meta-ads" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          range: {
            from: url.searchParams.get("from") || "2026-09-05",
            to: url.searchParams.get("to") || "2026-10-04",
            dayCount: 30,
            timeZone: "Asia/Kuala_Lumpur",
          },
          level: url.searchParams.get("level") || "campaign",
          filters: {
            accountId: url.searchParams.get("accountId"),
            campaignId: url.searchParams.get("campaignId"),
            adsetId: url.searchParams.get("adsetId"),
            adId: url.searchParams.get("adId"),
          },
          money: {
            currency: "MYR",
            currencies: ["MYR"],
            mixedCurrency: false,
            crmValueCurrency: "MYR",
            estimatedRoasAvailable: true,
          },
          summary: {
            spend: 500,
            impressions: 25000,
            clicks: 500,
            crmLeads: 20,
            hotLeads: 8,
            appointments: 7,
            visits: 5,
            won: 3,
            estimatedWonValue: 2400,
            ctr: 2,
            cpc: 1,
            cpm: 20,
            leadToAppointmentRate: 35,
            leadToWonRate: 15,
            costPerLead: 25,
            costPerAppointment: 71.43,
            costPerVisit: 100,
            costPerWon: 166.67,
            estimatedRoas: 4.8,
          },
          attributionCoverage: {
            metaAttributedLeads: 20,
            matchedToSyncedAds: 20,
            unmatchedToSyncedAds: 0,
            matchedRate: 100,
          },
          spendCoverage: {
            complete: true,
            historyComplete: true,
            attributionComplete: true,
            relevantAccountIds: ["123"],
            uncoveredAccountIds: [],
            coverageFrom: "2026-09-05",
            coverageThrough: "2026-10-04",
          },
          rows: [{
            accountId: "123",
            accountName: "Test Clinic Ads",
            currency: "MYR",
            id: "100",
            name: "October Campaign",
            spend: 500,
            impressions: 25000,
            clicks: 500,
            crmLeads: 20,
            hotLeads: 8,
            appointments: 7,
            visits: 5,
            won: 3,
            estimatedWonValue: 2400,
            ctr: 2,
            cpc: 1,
            cpm: 20,
            leadToAppointmentRate: 35,
            leadToWonRate: 15,
            costPerLead: 25,
            costPerAppointment: 71.43,
            costPerVisit: 100,
            costPerWon: 166.67,
            estimatedRoas: 4.8,
            matchedLeads: 20,
            spendCoverageComplete: true,
          }],
          accounts: [{
            accountId: "123",
            accountName: "Test Clinic Ads",
            currency: "MYR",
            dataThrough: "2026-10-04",
            coverageFrom: "2026-09-05",
            coverageThrough: "2026-10-04",
            lastSuccessAt: "2026-10-04T00:30:00.000Z",
            lastError: null,
            backfillCompletedAt: "2026-10-03T00:00:00.000Z",
            backfillNextDate: null,
            syncing: false,
          }],
          analyticsBusinessType: "aesthetic_clinic",
        }),
      });
    }

    if (path === "/api/pipeline/analytics" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          filterOptions: {
            branches: [],
            channels: [],
            sources: [],
            campaigns: [],
            treatments: [],
            owners: [],
          },
          summary: {
            newLeads: 12,
            appointments: 5,
            visits: 4,
            won: 2,
            estimatedWonValue: 2800,
            conversionRate: 16.7,
          },
          comparison: {
            deltas: {
              newLeads: 9.1,
              appointments: 25,
              visits: 0,
              won: 100,
              conversionRate: 7.6,
            },
          },
          cohort: {
            appointmentRate: 41.7,
            showRate: 80,
            closeRate: 50,
          },
          funnel: [
            { label: "Leads", count: 12, fromPreviousRate: 100, dropOff: 0, fromLeadRate: 100 },
            { label: "Appointments", count: 5, fromPreviousRate: 41.7, dropOff: 7, fromLeadRate: 41.7 },
            { label: "Visits", count: 4, fromPreviousRate: 80, dropOff: 1, fromLeadRate: 33.3 },
            { label: "Won", count: 2, fromPreviousRate: 50, dropOff: 2, fromLeadRate: 16.7 },
          ],
          trend: [
            { day: "2026-09-25", newLeads: 2, appointments: 1, visits: 1, won: 0 },
            { day: "2026-09-26", newLeads: 4, appointments: 2, visits: 1, won: 1 },
            { day: "2026-09-27", newLeads: 1, appointments: 0, visits: 1, won: 0 },
            { day: "2026-09-28", newLeads: 5, appointments: 2, visits: 1, won: 1 },
            { day: "2026-09-29", newLeads: 3, appointments: 1, visits: 0, won: 0 },
            { day: "2026-09-30", newLeads: 6, appointments: 3, visits: 2, won: 1 },
          ],
          temperature: [],
          responseTimes: {
            automated: { samples: 0, medianSeconds: 0, p90Seconds: 0 },
            staff: { samples: 0, medianSeconds: 0, p90Seconds: 0 },
          },
          performance: {
            source: [],
            campaign: [],
            treatment: [],
            branch: [],
            channel: [],
            owner: [],
          },
          followUps: {
            leadsFollowedUp: 0,
            leadsReplied72h: 0,
            replyRate72h: 0,
            outcomeWindowDays: 7,
            leadsWithAppointmentAfter: 0,
            leadsWonAfter: 0,
          },
          lostReasons: [],
          systemHealth: {
            aiScoring: { attempts: 0, failed: 0 },
            delivery: { tracked: 0, failed: 0, failureRate: 0 },
          },
        }),
      });
    }

    if (path === "/api/pipeline" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(pipelineData || { stages: [], leads: [], owners: [] }),
      });
    }

    if (path === "/api/pipeline/configured-branches") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }

    if (
      path === "/api/config/automated-follow-up/translations" &&
      method === "POST"
    ) {
      const payload = request.postDataJSON() || {};
      const makeTranslations = (message) => ({
        en: message,
        ms: `BM: ${message}`,
        zh: `中文：${message}`,
      });
      if (Array.isArray(payload.messages)) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            translations: payload.messages.map(makeTranslations),
          }),
        });
      }
      const message = payload.message || "";
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ translations: makeTranslations(message) }),
      });
    }

    if (
      path === "/api/config/automated-follow-up/image" &&
      method === "POST"
    ) {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          url: "https://cdn.example.test/follow-up-step.jpg",
        }),
      });
    }

    if (
      path === "/api/config/automated-follow-up/video" &&
      method === "POST"
    ) {
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          key: "clients/test-clinic/messages/follow-up-config/follow-up.mp4",
          filename: "follow-up.mp4",
          compressed: false,
          transcoded: false,
          originalBytes: 5 * 1024 * 1024,
          storedBytes: 5 * 1024 * 1024,
        }),
      });
    }

    if (
      path === "/api/config/automated-follow-up/video-preview" &&
      method === "GET"
    ) {
      return route.fulfill({
        status: 200,
        contentType: "video/mp4",
        body: "fake-mp4-preview",
      });
    }

    if (path === "/api/config/automated-follow-up/template-catalog" && templateCatalog) {
      return route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify(templateCatalog),
      });
    }
    if (path === "/api/config/automated-follow-up/template-media-image" && method === "POST") {
      return route.fulfill({
        status: 201, contentType: "application/json",
        body: JSON.stringify({
          key: "clients/test-clinic/messages/follow-up-config/uploaded-image.jpg", format: "IMAGE",
        }),
      });
    }
    if (path === "/api/config/automated-follow-up/template-library-image" && method === "POST") {
      return route.fulfill({
        status: 201, contentType: "application/json",
        body: JSON.stringify({
          key: "clients/test-clinic/messages/follow-up-config/pricing-package.jpg",
          format: "IMAGE", mediaSourceId: "promo:1", previewUrl: "https://example.test/pricing.jpg",
        }),
      });
    }
    if (path === "/api/config/automated-follow-up/template-library-video" && method === "POST") {
      const { selectionId } = request.postDataJSON();
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          key: "clients/test-clinic/messages/follow-up-config/pelvis.mp4",
          videoCodecVerified: true, format: "VIDEO",
          mediaSourceId: selectionId, previewUrl: "https://example.test/verified-video.mp4",
        }),
      });
    }
    if (path === "/api/config/automated-follow-up/template-media-preview") {
      return route.fulfill({
        status: 200, contentType: "image/jpeg", body: "mock-preview",
      });
    }

    if (path === "/api/follow-up-performance" && method === "GET") {
      const filters = Object.fromEntries(url.searchParams.entries());
      const data = typeof followUpPerformance === "function"
        ? await followUpPerformance(filters)
        : (followUpPerformance || { summary: { sent:0,contacts:0,reply_matured:0,
          replied_matured:0,milestone_matured:0,appointments_matured:0,won_matured:0,
          replied_observed:0 },breakdown:[],daily:[] });
      return route.fulfill({ status:200,contentType:"application/json",body:JSON.stringify(data) });
    }

    if (path === "/api/follow-up-health" && method === "GET") {
      const filters = Object.fromEntries(url.searchParams.entries());
      const sample = typeof followUpHealth === "function" ? await followUpHealth(filters) :
        (followUpHealth || { breakdown: [], alerts: [], upcoming: [], eventCount: 0,
          failedCount: 0, attentionCount: 0, stalePendingCount: 0 });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sample) });
    }

    if (path === "/api/follow-up-activity" && method === "GET") {
      if (remainingActivityFailures > 0) {
        remainingActivityFailures -= 1;
        return route.fulfill({ status: 503, contentType: "application/json",
          body: JSON.stringify({ error: "Activity is temporarily unavailable." }) });
      }
      const filters = Object.fromEntries(url.searchParams.entries());
      const defaultActivity = { items: [], total: 0, page: Number(filters.page || 1), pageSize: 25,
        hasMore: false, summary: { sent: 0, pending: 0, failed: 0, skipped: 0, attention: 0 } };
      const payload = typeof followUpActivity === "function"
        ? await followUpActivity(filters)
        : (followUpActivity || defaultActivity);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(payload) });
    }

    if (path === "/api/config/automated-follow-up/free-entry-status" &&
        (followUpStatus !== null || remainingFollowUpStatusFailures > 0)) {
      if (remainingFollowUpStatusFailures > 0) {
        remainingFollowUpStatusFailures -= 1;
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "WhatsApp status temporarily unavailable." }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(followUpStatus),
      });
    }

    if (path === "/api/config") {
      const configResponse = businessConfig || {
          automatedFollowUp: {
            enabled: false,
            delayMinutes: 10,
            triggerMode: "all",
            message: "Following up",
            translations: {
              en: "Following up",
              ms: "Following up",
              zh: "Following up",
            },
            imageUrl: "",
            activatedAt: null,
          },
          commentAutomation: {
            enabled: false,
            facebookEnabled: false,
            instagramEnabled: false,
            publicReplyEnabled: false,
            privateReplyEnabled: false,
            publicReplyStyle: "ai",
            fixedPublicReply: "",
            skipEmojiOnly: true,
            skipNestedReplies: true,
            activatedAt: null,
          },
          leadScoring: {
            enabled: false,
            inactivityMinutes: 10,
            maxConversationMinutes: 60,
            maxMessages: 40,
            activatedAt: null,
          },
          leadDistribution: {
            enabled: false,
            mode: "round_robin",
          },
        };

      if (method === "PATCH") {
        const updates = request.postDataJSON();
        onConfigUpdate?.(updates);
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ...configResponse, ...updates }),
        });
      }

      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(configResponse),
      });
    }

    if (path === "/api/advanced-config" && method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: advancedConfig,
          fingerprint: "fixture-fingerprint",
          editableKeys: Object.keys(advancedConfig),
          history: [],
        }),
      });
    }

    if (path === "/api/advanced-config/preview" && method === "POST") {
      const payload = request.postDataJSON();
      const updates = payload?.config || {};
      const changes = Object.keys(updates)
        .filter((key) => JSON.stringify(advancedConfig[key]) !== JSON.stringify(updates[key]))
        .map((key) => {
          const before = advancedConfig[key];
          const after = updates[key];
          if (key === "faqs") {
            const beforeFaq = Array.isArray(before) ? before[0] : null;
            const afterFaq = Array.isArray(after) ? after[0] : null;
            return {
              key,
              before: `${Array.isArray(before) ? before.length : 0} items`,
              after: `${Array.isArray(after) ? after.length : 0} items`,
              details: {
                kind: "collection",
                added: [],
                removed: [],
                updated: [{
                  identity: afterFaq?.q || beforeFaq?.q || "",
                  changes: [{
                    field: "a",
                    before: beforeFaq?.a || "Empty",
                    after: afterFaq?.a || "Empty",
                    textDiff: {
                      kind: "text",
                      mode: "words",
                      segments: [
                        { type: "removed", text: beforeFaq?.a || "" },
                        { type: "added", text: afterFaq?.a || "" },
                      ],
                    },
                  }],
                }],
              },
            };
          }

          if (key === "guardrails") {
            return {
              key,
              before: `${Array.isArray(before) ? before.length : 0} items`,
              after: `${Array.isArray(after) ? after.length : 0} items`,
              details: {
                kind: "string_list",
                added: [],
                removed: [],
                orderChanged: true,
                beforeOrder: before || [],
                afterOrder: after || [],
              },
            };
          }

          return {
            key,
            before: String(before ?? "Empty"),
            after: String(after ?? "Empty"),
            ...(key === "tone"
              ? {
                  details: {
                    kind: "text",
                    mode: "words",
                    segments: [
                      { type: "removed", text: String(before || "") },
                      { type: "added", text: String(after || "") },
                    ],
                  },
                }
              : {}),
          };
        });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          valid: true,
          baseFingerprint: "fixture-fingerprint",
          changes,
          normalizedUpdates: updates,
        }),
      });
    }

    if (path === "/api/advanced-config/apply" && method === "POST") {
      const payload = request.postDataJSON();
      advancedConfig = { ...advancedConfig, ...(payload?.config || {}) };
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          config: advancedConfig,
          fingerprint: "fixture-fingerprint-2",
          changes: [{ key: "tone", before: "Warm and professional", after: "Short and friendly" }],
          history: [],
        }),
      });
    }

    if (path === "/api/config/comment-automation/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ facebook: null, instagram: null }),
      });
    }

    if (path === "/api/config/lead-distribution/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
    }

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });
}

async function expectNoHorizontalPageOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectNoHorizontalElementOverflow(page, testId) {
  const element = page.getByTestId(testId);
  await expect(element).toBeVisible();
  const dimensions = await element.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

test("login page is usable without horizontal overflow", async ({ page }) => {
  await mockPortalApi(page);
  await page.goto("/login");

  await expect(page.getByRole("heading", { name: "Test Clinic" })).toBeVisible();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("client branding updates browser and dimensioned home-screen identity", async ({ page }) => {
  const clientLogoUrl = "https://cdn.example.test/neutro-logo.png";
  const clientAppIcon180Url = "https://cdn.example.test/neutro-180.png";
  const clientAppIcon192Url = "https://cdn.example.test/neutro-192.png";
  const clientAppIcon512Url = "https://cdn.example.test/neutro-512.png";
  await mockPortalApi(page, {
    branding: {
      clientName: "Neutro Sense TCM",
      clientLogoUrl,
      clientAppIcon180Url,
      clientAppIcon192Url,
      clientAppIcon512Url,
      loginTagline: "Staff portal",
    },
  });
  await page.goto("/login");

  await expect(page).toHaveTitle("Neutro Sense TCM | AI Chatbot Portal");
  await expect.poll(() =>
    page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute("href"))
  ).toBe("/api/auth/branding/favicon.png");
  await expect.poll(() =>
    page.evaluate(() => document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"))
  ).toBe("/api/auth/branding/apple-touch-icon.png");
  await expect.poll(() =>
    page.evaluate(() => document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content)
  ).toBe("Neutro Sense TCM");

  const installMetadata = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href"),
    faviconSizes: document.querySelector('link[rel="icon"]')?.getAttribute("sizes"),
    appleSizes: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("sizes"),
    themeColor: document.querySelector('meta[name="theme-color"]')?.content,
  }));
  expect(installMetadata.manifest).toBe("/api/auth/branding/manifest.webmanifest");
  expect(installMetadata.faviconSizes).toBe("192x192");
  expect(installMetadata.appleSizes).toBe("180x180");
  expect(installMetadata.themeColor).toBe("#0f172a");
});

test("home-screen metadata falls back to packaged DA icons without client install icons", async ({ page }) => {
  await mockPortalApi(page);
  await page.goto("/login");

  const metadata = await page.evaluate(() => ({
    favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href"),
    apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href"),
  }));
  expect(metadata.favicon).toBe("/api/auth/branding/favicon.png");
  expect(metadata.apple).toBe("/api/auth/branding/apple-touch-icon.png");
});

test("protected routes send logged-out staff back to login", async ({ page }) => {
  await mockPortalApi(page);

  for (const path of ["/inbox", "/pipeline", "/analytics", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  }
});

test("Automated follow-up saves a multi-step service-targeted sequence", async ({ page }) => {
  let savedPayload = null;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      services: [
        { name: "Pelvis 骨盆调理", description: "", priceRange: "", duration: "" },
        { name: "3D 小颜术", description: "", priceRange: "", duration: "" },
      ],
      serviceAliases: [],
      automatedFollowUp: {
        enabled: false,
        delayMinutes: 120,
        triggerMode: "all",
        message: "Just checking in.",
        translations: {
          en: "Just checking in.",
          ms: "Sekadar ingin membuat susulan.",
          zh: "想跟进一下。",
        },
        imageUrl: "",
        serviceOverrides: [],
        additionalSteps: [],
        activatedAt: null,
      },
      commentAutomation: {
        enabled: false,
        facebookEnabled: false,
        instagramEnabled: false,
        publicReplyEnabled: false,
        privateReplyEnabled: false,
        publicReplyStyle: "ai",
        fixedPublicReply: "",
        skipEmojiOnly: true,
        skipNestedReplies: true,
        activatedAt: null,
      },
      leadScoring: {
        enabled: false,
        inactivityMinutes: 10,
        maxConversationMinutes: 60,
        maxMessages: 40,
        activatedAt: null,
      },
      leadDistribution: {
        enabled: false,
        mode: "round_robin",
      },
    },
    onConfigUpdate: (payload) => {
      savedPayload = payload;
    },
  });

  await page.goto("/tools");
  await expect(page.getByRole("heading", { name: "Automated follow-up" })).toBeVisible();

  await expect(page.getByRole("switch", { name: "Follow-up quiet hours" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByLabel("Follow-up quiet hours start")).toHaveValue("00:00");
  await expect(page.getByLabel("Follow-up quiet hours end")).toHaveValue("07:00");

  await page.getByRole("button", { name: "+ Add follow-up" }).click();
  await expect(page.getByRole("button", { name: "Close" })).toBeVisible();

  const viewport = page.viewportSize();
  if (viewport && viewport.width < 1280) {
    const previewToggle = page.getByRole("button", {
      name: "Toggle follow-up preview",
    });
    await expect(previewToggle).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview Follow-up 2" })).not.toBeVisible();
    await previewToggle.click();
  }
  await expect(page.getByRole("button", { name: "Preview Follow-up 2" })).toBeVisible();

  await page
    .getByPlaceholder("Write the next follow-up message.")
    .fill("Still deciding? I can help with the details.");

  await page.getByRole("radio", { name: /AI personalized/ }).last().click();
  await page
    .getByPlaceholder(/Gently guide interested customers/)
    .fill("Continue from the unresolved concern and keep the follow-up low pressure.");

  await page.getByText(/Review translations · 0\/3 ready/).click();
  await page.getByRole("button", { name: "中文" }).last().click();
  await page.locator("details[open] textarea").last().fill("这是我手动调整的第二次跟进。");

  await page.getByRole("button", { name: "Manage" }).last().click();
  await page.getByRole("button", { name: "+ Add service message" }).last().click();
  await page
    .getByPlaceholder("Write a more relevant follow-up for customers interested in this service.")
    .last()
    .fill("For Pelvis 骨盆调理, I can help you understand which concern this suits.");

  const stepMediaGroup = page.getByRole("radiogroup", {
    name: "Follow-up 2 media type",
  });
  await stepMediaGroup.getByRole("radio", { name: "Image" }).click();
  const stepImageInput = page.getByLabel("Follow-up 2 media image upload");
  await stepImageInput.setInputFiles({
    name: "follow-up.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-jpeg"),
  });
  await expect(page.getByRole("button", { name: "Replace" }).last()).toBeVisible();

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();

  expect(savedPayload.automatedFollowUp.quietHours).toEqual({
    enabled: true,
    start: "00:00",
    end: "07:00",
  });
  expect(savedPayload.automatedFollowUp.additionalSteps).toHaveLength(1);
  expect(savedPayload.automatedFollowUp.additionalSteps[0]).toMatchObject({
    delayMinutes: 480,
    messageMode: "ai",
    aiInstruction: "Continue from the unresolved concern and keep the follow-up low pressure.",
    message: "Still deciding? I can help with the details.",
    imageUrl: "https://cdn.example.test/follow-up-step.jpg",
    serviceOverrides: [
      {
        serviceName: "Pelvis 骨盆调理",
        message: "For Pelvis 骨盆调理, I can help you understand which concern this suits.",
      },
    ],
  });
  expect(
    savedPayload.automatedFollowUp.additionalSteps[0].serviceOverrides[0]
      .translations.zh
  ).toContain("For Pelvis 骨盆调理");
  expect(
    savedPayload.automatedFollowUp.additionalSteps[0].translations.zh
  ).toBe("这是我手动调整的第二次跟进。");

  await expectNoHorizontalPageOverflow(page);
});

test("Sequence timeline navigates existing editors without changing schedule or losing drafts", async ({ page }) => {
  let savedPayload = null;
  const translations = (message) => ({
    en: message, ms: `BM: ${message}`, zh: `中文：${message}`,
  });
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "骨盆调理", description: "" }],
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        timingMode: "after_reply",
        message: "First reminder.",
        translations: translations("First reminder."),
        additionalSteps: [
          {
            delayMinutes: 480,
            timingMode: "after_reply",
            message: "Second reminder.",
            translations: translations("Second reminder."),
            serviceOverrides: [{
              serviceName: "骨盆调理",
              message: "Pelvic reminder.",
              translations: { en: "Pelvic reminder.", ms: "", zh: "" },
            }],
          },
          {
            delayMinutes: 1200,
            timingMode: "before_window_expiry",
            beforeWindowExpiryMinutes: 240,
            message: "Third testimonial.",
            translations: translations("Third testimonial."),
          },
        ],
        pricingReminder: { enabled: true, requirePricingInterest: false },
        freeEntry: { enabled: false },
      },
    },
    onConfigUpdate: (payload) => { savedPayload = payload; },
  });
  await page.goto("/tools");

  const timeline = page.getByRole("list", { name: "Follow-up sequence timeline" });
  await expect(timeline.getByRole("listitem")).toHaveCount(3);
  const first = timeline.getByRole("button", { name: "Edit Follow-up 1 from sequence overview" });
  const second = timeline.getByRole("button", { name: "Edit Follow-up 2 from sequence overview" });
  const third = timeline.getByRole("button", { name: "Edit Follow-up 3 from sequence overview" });
  await expect(first).toHaveAttribute("aria-current", "step");
  await expect(first).toContainText("Default translations: 3/3 configured");
  await expect(second).toContainText("Default translations: 3/3 configured");
  await expect(second).toContainText("Service translations: 1/3 configured");
  await expect(third).toContainText("before the 24-hour reply window closes");
  await page.getByText("Why might a step not send?").click();
  await expect(page.getByText(/A customer reply stops the remaining steps in the current sequence/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Pricing reminder dependency" }))
    .toContainText("5 minutes after the provider accepts Follow-up 3");

  // Keyboard activation must transfer focus into the editor, not merely scroll.
  await third.focus();
  await third.press("Enter");
  const thirdEditor = page.getByRole("region", { name: "Follow-up 3 editor" });
  const thirdMessage = thirdEditor.getByPlaceholder("Write the next follow-up message.");
  await expect(thirdEditor).toBeFocused();
  await expect(thirdMessage).toBeVisible();
  await expect(third).toHaveAttribute("aria-current", "step");
  await expect.poll(() => thirdEditor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const scrollArea = element.closest("main")?.getBoundingClientRect();
    return rect.top >= (scrollArea?.top ?? 0) - 4 &&
      rect.top < (scrollArea?.bottom ?? window.innerHeight) - 30;
  })).toBe(true);
  await thirdMessage.fill("Updated third testimonial.");
  await expect(third).toContainText("Default translations: 0/3 configured");

  await second.click();
  const secondEditor = page.getByRole("region", { name: "Follow-up 2 editor" });
  await expect(secondEditor.getByPlaceholder("Write the next follow-up message.")).toBeVisible();
  await expect(secondEditor).toBeFocused();
  await expect(second).toHaveAttribute("aria-current", "step");

  // Using the independent preview picker must not imply another editor is open.
  if ((page.viewportSize()?.width || 0) < 1280) {
    const previewToggle = page.getByRole("button", { name: "Toggle follow-up preview" });
    if (await previewToggle.getAttribute("aria-expanded") === "false") {
      await previewToggle.click();
    }
  }
  await page.getByRole("button", { name: "Preview Follow-up 3" }).click();
  await expect(second).toHaveAttribute("aria-current", "step");
  await expect(second).toContainText("Editing");
  await expect(third).not.toHaveAttribute("aria-current", "step");
  await expect(third).toContainText("Previewing only");
  await expect(secondEditor.getByPlaceholder("Write the next follow-up message.")).toBeVisible();

  await first.focus();
  await first.press("Enter");
  const firstEditor = page.getByRole("region", { name: "Follow-up 1 editor" });
  await expect(firstEditor).toBeVisible();
  await expect(firstEditor).toBeFocused();
  await expect(first).toHaveAttribute("aria-current", "step");
  await expect(thirdMessage).not.toBeVisible();

  await third.click();
  await expect(thirdEditor).toBeFocused();
  await expect(thirdMessage).toHaveValue("Updated third testimonial.");
  await expect(page.getByText("You have unsaved changes")).toBeVisible();

  await page.getByRole("tab", { name: "Pricing" }).click();
  await page.getByRole("tab", { name: "Sequence" }).click();
  await expect(thirdMessage).toHaveValue("Updated third testimonial.");

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();
  expect(savedPayload.automatedFollowUp.additionalSteps[0].delayMinutes).toBe(480);
  expect(savedPayload.automatedFollowUp.additionalSteps[1]).toMatchObject({
    timingMode: "before_window_expiry",
    beforeWindowExpiryMinutes: 240,
    delayMinutes: 1200,
    message: "Updated third testimonial.",
  });
  expect(savedPayload.automatedFollowUp.pricingReminder.enabled).toBe(true);
  expect(savedPayload.automatedFollowUp.freeEntry.enabled).toBe(false);
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog previews service packages, localized media and saved reminder controls", async ({ page }) => {
  // Serve stable mock thumbnails so image load failures cannot hide <img>
  // before assertions check which localized source is currently selected.
  await page.route("https://cdn.example.test/**", (route) => route.fulfill({
    status: 200, contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iCK8AAAAASUVORK5CYII=", "base64"),
  }));
  const promotion = {
    name: "October Pelvis Offer", linkedService: "骨盆调理", validFrom: "2026-10-01",
    validUntil: "2027-12-31", sendOnPriceQuery: false,
    packages: [
      {
        name: "Package A", imageUrl: "https://cdn.example.test/a.png",
        caption: "Package A trial RM388",
        mediaTranslations: {
          zh: { imageUrl: "https://cdn.example.test/a-zh.png", caption: "骨盆 A 配套 RM388" },
          ms: { caption: "BM Pelvis A RM388" },
        },
      },
      {
        name: "Package B", imageUrl: "https://cdn.example.test/b.png",
        caption: "Package B assessment RM588",
      },
    ],
  };
  await mockPortalApi(page, {
    loggedIn: true,
    user: ADMIN_USER,
    businessConfig: {
      services: [{ name: "骨盆调理" }],
      promotions: [promotion],
      automatedFollowUp: {
        enabled: true, delayMinutes: 120, message: "First",
        additionalSteps: [
          { delayMinutes: 480, message: "Second" },
          { delayMinutes: 1200, message: "Third" },
        ],
        pricingReminder: {
          enabled: true, requirePricingInterest: false,
          sendBothPelvicPackages: true, enableSocialChannels: true,
        },
      },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  await expect(readiness).toContainText("Pricing promotion readiness");
  const summary = readiness.getByLabel("Pricing readiness summary");
  await expect(summary).toContainText("Media configured for English (includes fallback)");
  await expect(summary).toContainText("Media configured for all 3 languages (includes fallback)");
  await expect(summary).toContainText("1/1");
  await expect(readiness).toContainText("Catalog entries needing attention");
  await expect(readiness).toContainText("Per-contact eligibility still applies");
  await expect(readiness.getByRole("link", { name: "Edit in Settings" })).toHaveAttribute("href", "/settings?tab=promotions");
  await readiness.getByRole("button", { name: "Review promotion catalog (1)" }).click();
  const catalog = readiness.getByRole("region", { name: "Promotion catalog previews" });
  await expect(catalog.getByRole("article", { name: "Promotion October Pelvis Offer" })).toBeVisible();
  const packageA = catalog.getByLabel("Package Package A");
  const packageB = catalog.getByLabel("Package Package B");
  const languagePreview = catalog.getByRole("group", { name: "Pricing catalog language preview" });
  await expect(packageA).toContainText("Package A trial RM388");
  await expect(packageB).toContainText("Package B assessment RM588");
  await expect(packageA).toContainText("中文: Localized");
  await expect(packageA).toContainText("BM: Using default");
  await expect(packageB).toContainText("中文: Using default");
  await expect(packageB).toContainText("English: Using default");
  await expect(packageA.getByRole("img", { name: "Pricing graphic for Package A" }))
    .toHaveAttribute("src", "https://cdn.example.test/a.png");

  await languagePreview.getByRole("button", { name: "中文" }).click();
  await expect(languagePreview.getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");
  await expect(packageA).toContainText("骨盆 A 配套 RM388");
  await expect(packageA.getByRole("img", { name: "Pricing graphic for Package A" }))
    .toHaveAttribute("src", "https://cdn.example.test/a-zh.png");
  await expect(packageB).toContainText("Package B assessment RM588");

  await languagePreview.getByRole("button", { name: "BM" }).click();
  await expect(packageA).toContainText("BM Pelvis A RM388");
  await expect(packageA.getByRole("img", { name: "Pricing graphic for Package A" }))
    .toHaveAttribute("src", "https://cdn.example.test/a.png");
  await expect(catalog).toContainText("Catalog media complete");
  await expect(readiness).toContainText("Complete media does not guarantee");
  await expect(page.getByRole("switch", { name: "Conditional pricing reminder" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Include Messenger and Instagram pricing reminders" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Send both pelvic package graphics" })).toHaveAttribute("aria-checked", "true");
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog flags duplicate current offers, ambiguous packages, media gaps and date states", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "骨盆调理" }, { name: "3D 小颜术" }],
      promotions: [
        {
          name: "Pelvis double graphic", linkedService: "骨盆调理",
          validFrom: "2026-01-01", validUntil: "2027-12-31",
          packages: [
            { name: "Package A", aliases: ["trial"], imageUrl: "https://cdn.example.test/shared.png", caption: "A caption" },
            { name: "Package B", aliases: ["trial"], imageUrl: "https://cdn.example.test/shared.png", caption: "B caption" },
          ],
        },
        {
          name: "Overlapping Pelvis Promo", linkedService: "骨盆调理",
          validFrom: "2026-01-01", validUntil: "2027-12-31",
          imageUrl: "https://cdn.example.test/other.png", caption: "Offer",
        },
        {
          name: "Incomplete Face Media", linkedService: "3D 小颜术", imageUrl: "", caption: "No graphic yet",
          validFrom: "2026-01-01", validUntil: "2027-12-31",
        },
        {
          name: "Upcoming Face", linkedService: "3D 小颜术",
          validFrom: "2099-01-01", validUntil: "2099-12-31",
          imageUrl: "https://cdn.example.test/future.png", caption: "Future",
        },
        {
          name: "Expired Face", linkedService: "3D 小颜术",
          validUntil: "2025-01-01", imageUrl: "https://cdn.example.test/old.png", caption: "Old",
        },
        {
          name: "Orphan Offer", linkedService: "Unknown treatment",
          imageUrl: "https://cdn.example.test/orphan.png", caption: "Orphan",
        },
      ],
      automatedFollowUp: { enabled: true, message: "First", pricingReminder: { enabled: true, sendBothPelvicPackages: true } },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  await expect(readiness.getByLabel("Pricing readiness summary")).toContainText("0/4");
  await expect(readiness).toContainText("promotion entries need review");
  await readiness.getByRole("button", { name: "Review promotion catalog (6)" }).click();
  const catalog = readiness.getByRole("region", { name: "Promotion catalog previews" });
  await expect(catalog).toContainText("More than one current promotion is linked to this treatment");
  await expect(catalog).toContainText("Packages share the name or alias 'trial'");
  await expect(catalog).toContainText("Package A and B share the same image");
  await expect(catalog).toContainText("has missing image or caption coverage");
  await expect(catalog).toContainText("Linked treatment is missing");
  await expect(catalog.getByRole("article", { name: "Promotion Upcoming Face" })).toContainText("Scheduled");
  await expect(catalog.getByRole("article", { name: "Promotion Expired Face" })).toContainText("Expired");
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog detects Chinese A/B graphic collisions despite distinct default images", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "骨盆调理" }],
      promotions: [{
        name: "Pelvic bilingual packages", linkedService: "骨盆调理",
        packages: [
          {
            name: "Package A", imageUrl: "https://cdn.example.test/default-a.jpg",
            caption: "Base A",
            mediaTranslations: {
              zh: { imageUrl: "https://cdn.example.test/zh-shared.jpg?version=1", caption: "中文 A" },
            },
          },
          {
            name: "Package B", imageUrl: "https://cdn.example.test/default-b.jpg",
            caption: "Base B",
            mediaTranslations: {
              zh: { imageUrl: "https://cdn.example.test/zh-shared.jpg?version=2", caption: "中文 B" },
            },
          },
        ],
      }],
      automatedFollowUp: {
        enabled: true, message: "First",
        additionalSteps: [{ message: "Second" }, { message: "Third" }],
        pricingReminder: { enabled: true, sendBothPelvicPackages: true },
      },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  const summary = readiness.getByLabel("Pricing readiness summary");
  await expect(summary).toContainText("Media configured for English (includes fallback)");
  await expect(summary).toContainText("1/1");
  await expect(summary).toContainText("Media configured for all 3 languages (includes fallback)");
  await expect(summary).toContainText("0/1");
  await readiness.getByRole("button", { name: "Review promotion catalog (1)" }).click();
  const catalog = readiness.getByRole("region", { name: "Promotion catalog previews" });
  await expect(catalog).toContainText("Package A and B share the same image for 中文");
  await expect(catalog).not.toContainText("Package A and B share the same image for English");
  const previews = catalog.getByRole("group", { name: "Pricing catalog language preview" });
  await previews.getByRole("button", { name: "中文" }).click();
  await expect(summary).toContainText("Media configured for 中文 (includes fallback)");
  await expect(summary).toContainText("0/1");
  await expect(catalog.getByLabel("Package Package A")).toContainText("中文 A");
  await expect(catalog.getByLabel("Package Package B")).toContainText("中文 B");
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog distinguishes Chinese-only configured media from missing English and BM", async ({ page }) => {
  await page.route("https://cdn.example.test/**", (route) => route.fulfill({
    status: 200, contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+iCK8AAAAASUVORK5CYII=", "base64"),
  }));
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "3D 小颜术" }],
      promotions: [{
        name: "Chinese only", linkedService: "3D 小颜术",
        packages: [{
          name: "Main package", imageUrl: "", caption: "",
          mediaTranslations: {
            zh: { imageUrl: "https://cdn.example.test/face-zh.png", caption: "中文价格介绍" },
          },
        }],
      }],
      automatedFollowUp: { enabled: true, message: "First", pricingReminder: { enabled: true } },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  const summary = readiness.getByLabel("Pricing readiness summary");
  await expect(summary).toContainText("Media configured for English (includes fallback)");
  await expect(summary).toContainText("0/1");
  await expect(summary).toContainText("Media configured for all 3 languages (includes fallback)");
  await expect(summary).toContainText("0/1");
  await readiness.getByRole("button", { name: "Review promotion catalog (1)" }).click();
  const catalog = readiness.getByRole("region", { name: "Promotion catalog previews" });
  const packageCard = catalog.getByLabel("Package Main package");
  await expect(packageCard).toContainText("English: Missing media");
  await expect(packageCard).toContainText("BM: Missing media");
  await expect(packageCard).toContainText("中文: Localized");
  await catalog.getByRole("group", { name: "Pricing catalog language preview" })
    .getByRole("button", { name: "中文" }).click();
  await expect(summary).toContainText("Media configured for 中文 (includes fallback)");
  await expect(summary).toContainText("1/1");
  await expect(summary).toContainText("Media configured for all 3 languages (includes fallback)");
  await expect(summary).toContainText("0/1");
  await expect(catalog).toContainText("Media configured for 中文");
  await expect(packageCard).toContainText("中文价格介绍");
  await expect(packageCard.getByRole("img", { name: "Pricing graphic for Main package" }))
    .toHaveAttribute("src", "https://cdn.example.test/face-zh.png");
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog warns on failed image previews without claiming the configured media is verified", async ({ page }) => {
  await page.route("https://cdn.example.test/**", (route) => route.fulfill({
    status: 404, contentType: "text/plain", body: "Missing image",
  }));
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "骨盆调理" }],
      promotions: [{
        name: "Broken graphic", linkedService: "骨盆调理",
        imageUrl: "https://cdn.example.test/broken.jpg", caption: "Pricing details",
      }],
      automatedFollowUp: { enabled: true, message: "First", pricingReminder: { enabled: true } },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  const summary = readiness.getByLabel("Pricing readiness summary");
  await expect(summary).toContainText("Media configured for English (includes fallback)");
  await expect(summary).toContainText("1/1");
  await readiness.getByRole("button", { name: "Review promotion catalog (1)" }).click();
  const catalog = readiness.getByRole("region", { name: "Promotion catalog previews" });
  await expect(catalog.getByRole("status")).toContainText("Image preview failed");
  await expect(catalog).toContainText("URL availability and delivery not verified");
  await expect(catalog).toContainText("Catalog media complete across all languages");
  await expect(summary).toContainText("1/1");
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing catalog empty state and unsaved-edit navigation protect existing follow-up settings", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    user: ADMIN_USER,
    businessConfig: {
      services: [{ name: "骨盆调理" }],
      promotions: [],
      automatedFollowUp: {
        enabled: true, delayMinutes: 120, message: "First",
        pricingReminder: { enabled: false },
      },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  const readiness = page.getByRole("region", { name: "Pricing promotion readiness" });
  await expect(readiness).toContainText("No pricing promotions configured");
  await expect(readiness).toContainText("Reminder off");
  await expect(readiness).not.toContainText("Unsaved draft");
  await expect(readiness.getByRole("button", { name: /promotion catalog/ })).toHaveCount(0);
  await page.getByRole("switch", { name: "Conditional pricing reminder" }).click();
  await expect(page.getByText("You have unsaved changes")).toBeVisible();
  await expect(readiness).toContainText("Unsaved draft");
  await expect(readiness).toContainText("Draft reminder: On · Saved reminder: Off");
  await expect(readiness).toContainText("Changes are not active until saved");
  await expect(readiness).not.toContainText("Configured on");
  page.once("dialog", (dialog) => dialog.dismiss());
  await readiness.getByRole("link", { name: "Edit in Settings" }).click();
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole("switch", { name: "Conditional pricing reminder" })).toHaveAttribute("aria-checked", "true");
  page.once("dialog", (dialog) => dialog.accept());
  await readiness.getByRole("link", { name: "Edit in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\?tab=promotions$/);
  await expect(page.getByRole("heading", { name: "Promotions" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("Pricing reminder explains the missing third follow-up without disabling existing controls", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        message: "First reminder.",
        additionalSteps: [{ delayMinutes: 480, message: "Second reminder." }],
        pricingReminder: {
          enabled: true, requirePricingInterest: false, sendBothPelvicPackages: true,
          enableSocialChannels: true,
        },
      },
    },
  });
  await page.goto("/tools");
  await expect(page.getByRole("list", { name: "Follow-up sequence timeline" }).getByRole("listitem")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Pricing reminder dependency" }))
    .toContainText("cannot send without Follow-up 3");

  const pricingShortcut = page.getByRole("button", { name: "View pricing settings" });
  await pricingShortcut.focus();
  await pricingShortcut.press("Enter");
  const pricingTab = page.getByRole("tab", { name: "Pricing" });
  await expect(pricingTab).toHaveAttribute("aria-selected", "true");
  await expect(pricingTab).toBeFocused();
  await expect(page.getByRole("region", { name: "Pricing reminder dependency" })).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Conditional pricing reminder" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Pricing is configured but cannot run without Follow-up 3" }))
    .toBeVisible();
  await expect(page.getByRole("switch", { name: "Conditional pricing reminder" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Include Messenger and Instagram pricing reminders" }))
    .toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("switch", { name: "Send both pelvic package graphics" }))
    .toHaveAttribute("aria-checked", "true");
  await expectNoHorizontalPageOverflow(page);
});

test("Automated follow-up sections preserve draft settings while switching tabs", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });
  await page.goto("/tools");

  await expect(page.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Sequence at a glance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Conditional pricing reminder" })).not.toBeVisible();

  await page.getByRole("switch", { name: "Follow-up quiet hours" }).click();
  await expect(page.getByText("You have unsaved changes")).toBeVisible();

  await page.getByRole("tab", { name: "Pricing" }).click();
  await expect(page.getByRole("heading", { name: "Conditional pricing reminder" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sequence at a glance" })).not.toBeVisible();

  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await expect(page.getByText("WhatsApp Free Messaging Only")).toBeVisible();
  await expect(page.getByText("Advanced eligibility and billing details")).toBeVisible();

  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Extended WhatsApp template activity" })).toBeVisible();

  await page.getByRole("tab", { name: "Sequence" }).click();
  await expect(page.getByRole("switch", { name: "Follow-up quiet hours" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("You have unsaved changes")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("Phase 7 performance tab shows mature reply rates, preliminary conversions and media breakdown", async ({ page }) => {
  const calls=[];
  const performance={
    summary:{ sent:5,contacts:3,reply_matured:4,replied_matured:2,
      replied_observed:3,milestone_matured:0,appointments_matured:0,visits_matured:0,
      won_matured:0,avg_reply_hours:2.4 },
    breakdown:[
      {dimension:"step",label:"FU1",sent:3,reply_matured:2,replied_matured:1,
        milestone_matured:0,appointments_matured:0,won_matured:0},
      {dimension:"step",label:"FU3",sent:2,reply_matured:2,replied_matured:1,
        milestone_matured:0,appointments_matured:0,won_matured:0},
      {dimension:"media",label:"Video",sent:2,reply_matured:2,replied_matured:1,
        milestone_matured:0,appointments_matured:0,won_matured:0},
      {dimension:"service",label:"3D",sent:5,reply_matured:4,replied_matured:2,
        milestone_matured:0,appointments_matured:0,won_matured:0},
    ],
    daily:[{dimension:"day",label:"2026-10-09",sent:5}],
  };
  await mockPortalApi(page,{loggedIn:true,followUpPerformance:(filters)=>{calls.push(filters);return performance;}});
  await page.goto("/tools");
  await page.getByRole("tab",{name:"Performance"}).click();
  const view=page.getByRole("region",{name:"Follow-up performance analytics"});
  await expect(view).toContainText("Follow-up performance");
  await expect(view).toContainText("50.0%");
  await expect(view).toContainText("72-hour reply rate");
  await expect(view).toContainText("7-day appointment rate");
  await expect(view).toContainText("7-day visit rate");
  await expect(view).toContainText("Avg reply · mature");
  await expect(view).toContainText("No accepted follow-ups in this group.");
  await expect(view).toContainText("By accepted media");
  await expect(view).toContainText("Video");
  await expect(view).toContainText("not proof of incremental lift");
  await view.getByRole("combobox",{name:"Performance channel"}).selectOption("instagram");
  await expect.poll(()=>calls.at(-1)?.channel).toBe("instagram");
  await expectNoHorizontalPageOverflow(page);
});

test("Phase 6 follow-up health reports failures and tentative next steps without sending", async ({ page }) => {
  const data = { eventCount: 5, failedCount: 1, attentionCount: 1, stalePendingCount: 1,
    dueNowCount: 2, dueNowPolicyReviewCount: 1,
    currentMediaAlertCount: 1,
    currentMediaAlerts: [{ contact_id: 46, channel: "instagram",
      detail: "Follow-up text was sent, but its optional image was not queued",
      current_service: "3D" }],
    breakdown: [
      { channel: "facebook", type: "follow_up", part: "message", step: 3, status: "sent", count: 1 },
      { channel: "facebook", type: "follow_up", part: "media", step: 3, status: "failed", count: 1 },
    ],
    alerts: [{ id: 21, channel: "facebook", contact_id: 44, type: "follow_up", step: 3,
      part: "media", status: "failed", created_at: "2026-10-09T10:00:00Z", detail: "Video rejected" }],
    upcoming: [{ contact_id: 45, channel: "instagram", step: 2,
      estimated_at: "2026-10-10T11:00:00Z", window_expires_at: "2026-10-10T16:00:00Z",
      policy_flags: ["human_takeover", "marketing_opt_out"] }],
  };
  await mockPortalApi(page, { loggedIn: true, followUpHealth: data });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Activity" }).click();
  const health = page.getByRole("region", { name: "Follow-up health monitoring" });
  await expect(health).toContainText("Follow-up monitoring");
  await expect(health).toContainText("Video rejected");
  await expect(health).toContainText("FU3 media");
  await expect(health).toContainText("Upcoming follow-up review queue");
  await expect(health).toContainText("not confirmed scheduled sends");
  await expect(health).toContainText("Due-now policy warnings");
  await expect(health).toContainText("Currently open missing-media attention");
  await expect(health).toContainText("Current lead interest (not historical): 3D");
  await expect(health).toContainText("Policy review required: human takeover, marketing opt-out");
  await expect(health).toContainText("This candidate is not permission to send");
  await expect(health.getByRole("link", { name: "Review in Inbox" }).first())
    .toHaveAttribute("href", "/inbox?contact=44");
  await expect(health.getByRole("link", { name: "Review in Inbox" }).nth(1))
    .toHaveAttribute("href", "/inbox?contact=46");
  await health.getByRole("combobox", { name: "Health channel" }).selectOption("instagram");
  await expect(health).toContainText("Follow-up monitoring");
  await expectNoHorizontalPageOverflow(page);
});

test("Follow-up Activity shows recorded outcomes, precise skips and navigable Inbox links across channels", async ({ page }) => {
  const calls = [];
  const events = [
    { event_id: "message:10", occurred_at: "2026-10-09T09:20:00Z", contact_id: 101,
      channel: "whatsapp", type: "sequence", step: 3, state: "sent", raw_status: "delivered", detail: "", media_type: "video" },
    { event_id: "pricing_decision:12", occurred_at: "2026-10-09T09:10:00Z", contact_id: 102,
      channel: "facebook", type: "pricing", step: 4, state: "skipped", raw_status: "missing_promotion", detail: "missing_promotion" },
    { event_id: "message:13", occurred_at: "2026-10-09T09:00:00Z", contact_id: 103,
      channel: "instagram", type: "sequence", step: 2, state: "failed", raw_status: "failed", detail: "API error" },
    { event_id: "pricing_decision:14", occurred_at: "2026-10-09T08:50:00Z", contact_id: 104,
      channel: "whatsapp", type: "pricing", step: 4, state: "attention", raw_status: "delivery_review", detail: "delivery_review" },
    { event_id: "message:15", occurred_at: "2026-10-09T08:20:00Z", contact_id: 105,
      channel: "whatsapp", type: "sequence", step: 1, state: "pending", raw_status: "pending", detail: "",
      media_type: "text", provider_evidence: "accepted" },
  ];
  await mockPortalApi(page, {
    loggedIn: true,
    followUpActivity: (filters) => {
      calls.push(filters);
      const matching = events.filter((e) =>
        (filters.channel === "all" || e.channel === filters.channel) &&
        (filters.type === "all" || e.type === filters.type) &&
        (filters.state === "all" || e.state === filters.state));
      return {
        items: matching, total: matching.length, page: Number(filters.page), pageSize: 25,
        hasMore: false, diagnostics: [{
          contact_id: 106, channel: "whatsapp",
          inbound_at: "2026-10-08T01:00:00Z", possible_quiet_overlap: true,
        }], summary: {
          sent: events.filter((e) => e.state === "sent").length,
          pending: events.filter((e) => e.state === "pending").length,
          failed: events.filter((e) => e.state === "failed").length,
          skipped: events.filter((e) => e.state === "skipped").length,
          attention: events.filter((e) => e.state === "attention").length,
        },
      };
    },
  });
  await page.goto("/tools");
  await expect.poll(() => calls.length).toBe(0); // lazy load; no unnecessary database query
  await page.getByRole("tab", { name: "Activity" }).click();
  const activity = page.getByRole("region", { name: "Follow-up delivery activity" });
  await expect(activity.getByRole("article")).toHaveCount(5);
  await expect(activity).toContainText("Follow-up 3");
  await expect(activity).toContainText("Video");
  await expect(activity).toContainText("Pricing reminder");
  await expect(activity).toContainText("Messenger");
  await expect(activity).toContainText("Instagram");
  await expect(activity).toContainText("Matching pricing promotion or media unavailable");
  await expect(activity).toContainText("Earlier pricing delivery is unconfirmed");
  await expect(activity).toContainText("Provider accepted this send; delivery receipt still pending");
  await expect(page.getByRole("region", { name: "Potential missed FU3 diagnostics" }))
    .toContainText("Nominal FU3 time overlaps the currently configured quiet hours");
  await expect(page.getByRole("link", { name: "Inspect conversation" }))
    .toHaveAttribute("href", "/inbox?contact=106");
  await expect(activity.getByRole("link", { name: "Open conversation" }).first())
    .toHaveAttribute("href", "/inbox?contact=101");
  await expect(page.getByRole("heading", { name: "Extended WhatsApp template activity" })).toBeVisible();
  await activity.getByRole("button", { name: "Failed" }).click();
  await expect.poll(() => calls.at(-1)?.state).toBe("failed");
  await expect(activity.getByRole("article")).toHaveCount(1);
  await expect(activity).toContainText("API error");
  await activity.getByRole("combobox", { name: "Activity channel" }).selectOption("instagram");
  await expect.poll(() => calls.at(-1)?.channel).toBe("instagram");
  await activity.getByRole("combobox", { name: "Activity period" }).selectOption("30");
  await expect.poll(() => calls.at(-1)?.days).toBe("30");
  await expectNoHorizontalPageOverflow(page);
});

test("Phase 5 shows separately failed Messenger video and Instagram image despite sent parent text", async ({ page }) => {
  const events = [
    { event_id: "message:700", occurred_at: "2026-10-09T10:00:00Z",
      contact_id: 70, channel: "facebook", type: "sequence", step: 3,
      state: "sent", raw_status: "sent", detail: "", media_type: "text", message_part: "follow_up" },
    { event_id: "message:701", occurred_at: "2026-10-09T10:01:00Z",
      contact_id: 70, channel: "facebook", type: "sequence", step: 3,
      state: "failed", raw_status: "failed", detail: "Video rejected by provider",
      media_type: "video", message_part: "media_companion", parent_message_id: 700 },
    { event_id: "message:710", occurred_at: "2026-10-09T09:00:00Z",
      contact_id: 71, channel: "instagram", type: "sequence", step: 2,
      state: "sent", raw_status: "sent", detail: "", media_type: "text", message_part: "follow_up" },
    { event_id: "message:711", occurred_at: "2026-10-09T09:01:00Z",
      contact_id: 71, channel: "instagram", type: "sequence", step: 2,
      state: "failed", raw_status: "failed", detail: "Image rejected by provider",
      media_type: "image", message_part: "media_companion", parent_message_id: 710 },
  ];
  await mockPortalApi(page, { loggedIn: true, followUpActivity: (filters) => {
    const scoped = events.filter((e) =>
      (filters.channel === "all" || e.channel === filters.channel) &&
      (filters.type === "all" || e.type === filters.type));
    const visible = scoped.filter((e) => filters.state === "all" || e.state === filters.state);
    return { items: visible, total: visible.length, page: 1, pageSize: 25,
      hasMore: false, diagnostics: [],
      summary: Object.fromEntries(["sent", "pending", "failed", "skipped", "attention"]
        .map((state) => [state, scoped.filter((e) => e.state === state).length])),
    };
  }});
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Activity" }).click();
  const activity = page.getByRole("region", { name: "Follow-up delivery activity" });
  await expect(activity.getByRole("article")).toHaveCount(4);
  await expect(activity).toContainText("Follow-up 3 · Separate media · Messenger · Video");
  await expect(activity).toContainText("Follow-up 2 · Separate media · Instagram · Image");
  await expect(activity).toContainText("Video rejected by provider");
  await expect(activity).toContainText("Image rejected by provider");
  await expect(activity).toContainText("its outcome does not prove the text's delivery status");
  const totals = activity.getByLabel("Follow-up activity totals");
  await expect(totals.getByRole("button", { name: "Sent / accepted" })).toContainText("2");
  await expect(totals.getByRole("button", { name: "Failed" })).toContainText("2");
  await activity.getByRole("button", { name: "Failed" }).click();
  await expect(activity.getByRole("article")).toHaveCount(2);
  await activity.getByRole("combobox", { name: "Activity channel" }).selectOption("facebook");
  await expect(activity.getByRole("article")).toHaveCount(1);
  await expect(activity).toContainText("Video rejected by provider");
  await expect(activity.getByRole("link", { name: "Open conversation" }))
    .toHaveAttribute("href", "/inbox?contact=70");
  await expectNoHorizontalPageOverflow(page);
});

test("Follow-up Activity distinguishes provider ID and unconfirmed claims and clears stale totals during refetch", async ({ page }) => {
  const calls = [];
  await mockPortalApi(page, { loggedIn: true,
    followUpActivity: async (filters) => {
      calls.push(filters);
      if (filters.channel === "instagram") await new Promise((resolve) => setTimeout(resolve, 550));
      return filters.channel === "instagram" ? {
        items: [], total: 0, page: 1, hasMore: false, diagnostics: [],
        summary: { sent: 0, pending: 0, failed: 0, skipped: 0, attention: 0 },
      } : {
        items: [
          { event_id: "message:200", occurred_at: "2026-10-09T09:20:00Z", contact_id: 200,
            channel: "whatsapp", type: "sequence", step: 1, state: "pending", raw_status: "pending",
            detail: "", provider_evidence: "provider_id", media_type: "image" },
          { event_id: "message:201", occurred_at: "2026-10-09T09:18:00Z", contact_id: 201,
            channel: "whatsapp", type: "sequence", step: 2, state: "pending", raw_status: "pending",
            detail: "", provider_evidence: "none", media_type: "text" },
        ],
        total: 2, page: 1, hasMore: false, diagnostics: [],
        summary: { sent: 0, pending: 2, failed: 0, skipped: 0, attention: 0 },
      };
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Activity" }).click();
  const activity = page.getByRole("region", { name: "Follow-up delivery activity" });
  await expect(activity).toContainText("Provider message ID recorded, but acceptance timestamp is unavailable");
  await expect(activity).toContainText("Send has no stored provider acceptance evidence");
  await expect(activity).toContainText("Image");
  const totals = activity.getByLabel("Follow-up activity totals");
  await expect(totals).toContainText("2");
  await activity.getByRole("combobox", { name: "Activity channel" }).selectOption("instagram");
  await expect(totals).not.toContainText("2");
  await expect(totals).toContainText("—");
  await expect.poll(() => calls.at(-1)?.channel).toBe("instagram");
  await expect(activity.getByText("No recorded events match these filters")).toBeVisible();
  await expect(totals).not.toContainText("2");
  await expectNoHorizontalPageOverflow(page);
});

test("Follow-up Activity handles API error and recovery without changing the saved sequence", async ({ page }) => {
  const writes = [];
  await mockPortalApi(page, { loggedIn: true, followUpActivityFailures: 1,
    onConfigUpdate: (data) => writes.push(data),
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Activity" }).click();
  const activity = page.getByRole("region", { name: "Follow-up delivery activity" });
  await expect(activity.getByRole("alert")).toContainText("Activity is temporarily unavailable");
  await activity.getByRole("button", { name: "Try again" }).click();
  await expect(activity.getByText("No recorded events match these filters")).toBeVisible();
  expect(writes).toHaveLength(0);
  await expectNoHorizontalPageOverflow(page);
});

test("Follow-up tab settings save without changing the separate follow-up controls", async ({ page }) => {
  const saved = [];
  await mockPortalApi(page, {
    loggedIn: true,
    onConfigUpdate: (payload) => saved.push(payload.automatedFollowUp),
  });
  await page.goto("/tools");

  await page.getByRole("tab", { name: "Pricing" }).click();
  await page.getByRole("switch", { name: "Conditional pricing reminder" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].pricingReminder.enabled).toBe(true);
  expect(saved[0].freeEntry.enabled).toBe(false);

  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await page.getByLabel("Approved template fallback language").selectOption("ms");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1].freeEntry.fallbackLanguage).toBe("ms");
  expect(saved[1].pricingReminder.enabled).toBe(true);

  await page.getByRole("tab", { name: "Activity" }).click();
  await page.getByRole("switch", { name: "Enable 24-hour follow-ups" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(3);
  expect(saved[2].enabled).toBe(true);
  expect(saved[2].pricingReminder.enabled).toBe(true);
  expect(saved[2].freeEntry.fallbackLanguage).toBe("ms");
  await expectNoHorizontalPageOverflow(page);
});

test("Follow-up pricing and WhatsApp tabs fill desktop width", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop-chromium", "desktop grid regression");
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPortalApi(page, { loggedIn: true });
  await page.goto("/tools");

  for (const [tab, id] of [
    ["Pricing", "follow-up-panel-pricing"],
    ["WhatsApp templates", "follow-up-panel-whatsapp"],
    ["Activity", "follow-up-panel-activity"],
  ]) {
    await page.getByRole("tab", { name: tab }).click();
    const sizes = await page.locator(`#${id}`).evaluate((node) => ({
      panelWidth: node.getBoundingClientRect().width,
      editorWidth: node.parentElement.parentElement.getBoundingClientRect().width,
    }));
    expect(sizes.panelWidth).toBeGreaterThan(sizes.editorWidth * 0.94);
    await expectNoHorizontalPageOverflow(page);
  }
});

test("Critical WhatsApp billing alarms remain visible outside collapsed diagnostics", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    followUpStatus: {
      enabledOnServer: true,
      enabledInTools: true,
      freeOnlyEnabled: true,
      billingSafety: { since_switch: 1 },
      freeOnlyGate: { status: "unknown" },
      strictSevenDayBlocked: false,
    },
  });
  await page.goto("/tools");
  await expect(page.getByRole("alert")).toContainText("WhatsApp billing alarm");
  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await expect(page.getByText("Advanced eligibility and billing details")).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("All WhatsApp sends are blocked");
});

test("Saving pricing changes opens invalid Follow-up 2 and keeps the unsaved edit", async ({ page }) => {
  let requests = 0;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [],
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        message: "Checking in with you.",
        additionalSteps: [{ delayMinutes: 1, message: "Another reminder." }],
        pricingReminder: { enabled: false },
      },
    },
    onConfigUpdate: () => { requests += 1; },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  await page.getByRole("switch", { name: "Conditional pricing reminder" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();

  await expect(page.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("alert").filter({ hasText: "Fix this setting before saving" }))
    .toContainText("Follow-up 2 needs a delay between 5 minutes and 23 hours.");
  await expect(page.locator("#follow-up-step-2").getByPlaceholder("Write the next follow-up message.")).toBeVisible();
  expect(requests).toBe(0);

  await page.getByRole("tab", { name: "Pricing" }).click();
  await expect(page.getByRole("switch", { name: "Conditional pricing reminder" })).toHaveAttribute("aria-checked", "true");
});

test("Saving from another tab reveals hidden invalid service targeting", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [{ name: "3D 小颜术", description: "", priceRange: "", duration: "" }],
      automatedFollowUp: {
        enabled: true,
        delayMinutes: 120,
        message: "Checking in with you.",
        additionalSteps: [{
          delayMinutes: 480,
          message: "Another reminder.",
          serviceOverrides: [{
            serviceName: "Retired pelvis treatment",
            message: "A targeted follow-up for an old treatment.",
          }],
        }],
      },
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "Pricing" }).click();
  await page.getByRole("switch", { name: "Conditional pricing reminder" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("tab", { name: "Sequence" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("alert").filter({ hasText: "Fix this setting before saving" }))
    .toContainText("Retired pelvis treatment is no longer in Services");
  const step = page.locator("#follow-up-step-2");
  await expect(step.getByText("This service no longer exists.")).toBeVisible();
  await expect(step.getByPlaceholder("Write a more relevant follow-up for customers interested in this service.")).toBeVisible();
});

test("Saving an invalid extended template redirects to WhatsApp templates", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [],
      automatedFollowUp: {
        enabled: false,
        delayMinutes: 120,
        message: "Checking in with you.",
        freeEntry: { enabled: true, templateName: "", slotsHours: [26, 50] },
      },
    },
  });
  await page.goto("/tools");
  await page.getByRole("switch", { name: "Enable 24-hour follow-ups" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("tab", { name: "WhatsApp templates" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("alert").filter({ hasText: "Fix this setting before saving" }))
    .toContainText("Enter an approved WhatsApp MARKETING template name");
  await expect(page.getByLabel("Free-entry template name")).toBeVisible();
});

test("Failed WhatsApp status check shows a visible warning and supports retry", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });
  // React's development StrictMode may request status more than once on mount.
  // Keep every initial request failing until the test explicitly allows a retry.
  let allowRecovery = false;
  await page.route("**/api/config/automated-follow-up/free-entry-status", (route) =>
    route.fulfill({
      status: allowRecovery ? 200 : 503,
      contentType: "application/json",
      body: JSON.stringify(allowRecovery
        ? {
            enabledOnServer: false, enabledInTools: false,
            freeOnlyEnabled: false, freeOnlyGate: { status: "idle" },
            sevenDayVerified: false, billingSafety: { since_switch: 0 },
          }
        : { error: "WhatsApp status temporarily unavailable." }),
    })
  );
  await page.goto("/tools");
  const warning = page.getByRole("alert").filter({ hasText: "WhatsApp eligibility and billing status could not be verified" });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Do not assume extended templates are active or free.");
  allowRecovery = true;
  await warning.getByRole("button", { name: "Retry check" }).click();
  await expect(warning).not.toBeVisible();
  await expect(page.getByRole("region", { name: "Follow-up activation overview" })).toContainText("Template server:");
});

test("WhatsApp template picker supports approved IMAGE and VIDEO headers with R2 attachment", async ({ page }) => {
  const saved = [];
  const persisted = {
    services: [
      { name: "骨盆调理", description: "", duration: "", priceRange: "" },
      { name: "3D 小颜术", description: "", duration: "", priceRange: "" },
    ],
    automatedFollowUp: {
      enabled: false, delayMinutes: 10, triggerMode: "all",
      message: "Following up", imageUrl: "",
      translations: { en: "Following up", ms: "Following up", zh: "Following up" },
    },
  };
  const template = (name, format, text, language = "zh_CN") => ({
    name, language, status: "APPROVED", category: "MARKETING",
    header: { format }, body: { text }, variableFields: [], sendable: true, buttons: [],
  });
  await mockPortalApi(page, {
    businessConfig: persisted,
    loggedIn: true,
    onConfigUpdate: (payload) => {
      saved.push(payload.automatedFollowUp);
      Object.assign(persisted, payload);
    },
    templateCatalog: {
      templates: [
        template("clinic_text_reminder", "TEXT", "We can answer your questions."),
        template("clinic_image_offer", "IMAGE", "See our approved offer image."),
        template("clinic_video_feedback", "VIDEO", "Hear from another customer."),
        template("clinic_video_feedback", "VIDEO", "Customer story", "en_US"),
        { ...template("clinic_utility_notice", "TEXT", "Your appointment."), category: "UTILITY" },
        { ...template("clinic_unapproved", "TEXT", "Do not send"), status: "REJECTED", sendable: false },
      ],
      reusableMedia: [
        { id: "promo:1", label: "Package A image", format: "IMAGE", imageId: 1, serviceName: "骨盆调理" },
        { id: "promo:2", label: "Wrong treatment image", format: "IMAGE", imageId: 2, serviceName: "3D 小颜术" },
        { id: "video:aaaaaaaaaaaaaaaaaaaaaaaa", label: "Pelvis feedback", format: "VIDEO", serviceName: "骨盆调理",
          mediaKey: "clients/test-clinic/messages/follow-up-config/pelvis.mp4" },
      ],
    },
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await expect(page.getByLabel("Free-entry template name")).toBeVisible();
  await page.getByLabel("Free-entry template name").selectOption("clinic_text_reminder");
  await expect(page.locator("#free-entry-default-template option", { hasText: "clinic_utility_notice" })).toHaveCount(0);
  await expect(page.locator("#free-entry-default-template option", { hasText: "clinic_unapproved" })).toHaveCount(0);
  await expect(page.getByLabel("Approved template preview").first()).toContainText("We can answer your questions.");

  await page.getByRole("button", { name: "Add treatment follow-up template" }).click();
  await page.getByLabel("Extended template treatment 1").selectOption("骨盆调理");
  const rule = page.getByLabel("Approved marketing template for rule 1");
  await rule.selectOption("clinic_video_feedback");
  await expect(page.getByText("Video attachment · required")).toBeVisible();
  await page.getByLabel("Extended template media library 1").selectOption("video:aaaaaaaaaaaaaaaaaaaaaaaa");
  await expect(page.getByText("Attached: pelvis.mp4")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].freeEntry.templateRules[0]).toMatchObject({
    templateName: "clinic_video_feedback",
    mediaKey: "clients/test-clinic/messages/follow-up-config/pelvis.mp4",
    mediaUrl: "",
    mediaSourceId: "video:aaaaaaaaaaaaaaaaaaaaaaaa",
    videoCodecVerified: true,
  });
  await expect(page.getByLabel("Template rule configuration readiness 1"))
    .toContainText("Template/media fields: Complete");
  await expect(page.getByLabel("Template rule configuration readiness 1"))
    .toContainText("marketing consent");

  await rule.selectOption("clinic_image_offer");
  await expect(page.getByText("Image attachment · required")).toBeVisible();
  await expect(page.getByText("Attached: pelvis.mp4")).toHaveCount(0);
  await expect(page.getByLabel("Extended template media library 1").locator('option[value="promo:2"]')).toHaveCount(0);
  await page.getByLabel("Extended template media library 1").selectOption("promo:1");
  await expect(page.getByText("Attached: pricing-package.jpg")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(2);
  expect(saved[1].freeEntry.templateRules[0]).toMatchObject({
    templateName: "clinic_image_offer",
    mediaKey: "clients/test-clinic/messages/follow-up-config/pricing-package.jpg",
    mediaUrl: "",
    mediaSourceId: "promo:1",
  });
  await page.reload();
  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await expect(page.getByText("Attached: pricing-package.jpg")).toBeVisible();
  await expect(page.getByLabel("Extended template treatment 1")).toHaveValue("骨盆调理");
  await page.getByRole("tab", { name: "Pricing" }).click();
  await page.getByRole("switch", { name: "Conditional pricing reminder" }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(3);
  expect(saved[2].freeEntry.templateRules[0]).toMatchObject({
    mediaSourceId: "promo:1",
    mediaKey: "clients/test-clinic/messages/follow-up-config/pricing-package.jpg",
  });
  await expectNoHorizontalPageOverflow(page);
});

test("WhatsApp template picker uploads new JPG or video and preserves selected media until saved", async ({ page }) => {
  const saved = [];
  const templates = ["IMAGE", "VIDEO"].map((format) => ({
    name: format === "VIDEO" ? "clinic_media_video" : "clinic_media_image",
    language: "zh_CN", status: "APPROVED", category: "MARKETING",
    header: { format }, body: { text: "Approved media text" }, variableFields: [], sendable: true,
  }));
  await mockPortalApi(page, {
    businessConfig: {
      services: [
        { name: "骨盆调理", description: "", duration: "", priceRange: "" },
        { name: "3D 小颜术", description: "", duration: "", priceRange: "" },
      ],
      automatedFollowUp: {
        enabled: false, delayMinutes: 10, triggerMode: "all",
        message: "Following up", imageUrl: "",
        translations: { en: "Following up", ms: "Following up", zh: "Following up" },
      },
    },
    loggedIn: true,
    templateCatalog: { templates, reusableMedia: [] },
    onConfigUpdate: (payload) => saved.push(payload.automatedFollowUp),
  });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await page.getByRole("button", { name: "Add treatment follow-up template" }).click();
  await page.getByLabel("Extended template treatment 1").selectOption("骨盆调理");
  await page.getByLabel("Approved marketing template for rule 1").selectOption("clinic_media_image");
  await page.getByLabel("Extended template image attachment 1").setInputFiles({
    name: "promo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake-jpeg"),
  });
  await expect(page.getByText("Attached: uploaded-image.jpg")).toBeVisible();
  await page.getByLabel("Approved marketing template for rule 1").selectOption("clinic_media_video");
  await page.getByLabel("Extended template video attachment 1").setInputFiles({
    name: "feedback.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-mp4"),
  });
  await expect(page.getByText("Attached: follow-up.mp4")).toBeVisible();
  await expect(page.getByLabel("Video codec status 1"))
    .toContainText("server rechecks the exact R2 video");
  await expect(page.getByLabel("Extended template media URL 1")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /I verified this video is H.264/ })).toHaveCount(0);
  await page.getByLabel("Extended template video attachment 1").setInputFiles({
    name: "feedback-safe.mp4", mimeType: "video/mp4", buffer: Buffer.from("fake-mp4"),
  });
  await expect(page.getByText("Attached: follow-up.mp4")).toBeVisible();
  await expect(page.getByText("You have unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].freeEntry.templateRules[0]).toMatchObject({
    templateName: "clinic_media_video",
    mediaKey: "clients/test-clinic/messages/follow-up-config/follow-up.mp4",
    videoCodecVerified: true,
  });
});

test("Delayed treatment image upload cannot attach to a changed rule", async ({ page }) => {
  const catalog = {
    templates: [{
      name: "clinic_image_offer", language: "zh_CN", status: "APPROVED",
      category: "MARKETING", header: { format: "IMAGE" }, body: { text: "An offer" },
      variableFields: [], sendable: true,
    }],
    reusableMedia: [],
  };
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      services: [
        { name: "骨盆调理", description: "", duration: "", priceRange: "" },
        { name: "3D 小颜术", description: "", duration: "", priceRange: "" },
      ],
    },
    templateCatalog: catalog,
  });
  let delayedRequest = null;
  await page.route("**/api/config/automated-follow-up/template-media-image",
    (route) => { delayedRequest = route; });
  await page.goto("/tools");
  await page.getByRole("tab", { name: "WhatsApp templates" }).click();
  await page.getByRole("button", { name: "Add treatment follow-up template" }).click();
  await page.getByLabel("Extended template treatment 1").selectOption("骨盆调理");
  await page.getByLabel("Approved marketing template for rule 1").selectOption("clinic_image_offer");
  await page.getByLabel("Extended template image attachment 1").setInputFiles({
    name: "pelvic-image.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake-jpeg"),
  });
  await expect.poll(() => Boolean(delayedRequest)).toBe(true);
  await page.getByLabel("Extended template treatment 1").selectOption("3D 小颜术");
  await delayedRequest.fulfill({
    status: 201, contentType: "application/json",
    body: JSON.stringify({
      key: "clients/test-clinic/messages/follow-up-config/pelvic-image.jpg",
      format: "IMAGE", previewUrl: "https://example.test/pelvic-image.jpg",
    }),
  });
  await expect(page.getByLabel("Extended template treatment 1")).toHaveValue("3D 小颜术");
  await expect(page.getByText("Attached: pelvic-image.jpg")).toHaveCount(0);
  await expect(page.getByLabel("Template rule configuration readiness 1")).toContainText("Incomplete");
});

test("Automated follow-up switches cleanly between image and video attachments", async ({ page }) => {
  let savedPayload = null;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      services: [
        { name: "Pelvis 骨盆调理", description: "", priceRange: "", duration: "" },
      ],
      serviceAliases: [],
      automatedFollowUp: {
        enabled: false,
        delayMinutes: 120,
        triggerMode: "all",
        message: "Just checking in.",
        translations: {
          en: "Just checking in.",
          ms: "Sekadar ingin membuat susulan.",
          zh: "想跟进一下。",
        },
        imageUrl: "",
        videoKey: "",
        videoFilename: "",
        serviceOverrides: [],
        additionalSteps: [],
        activatedAt: null,
      },
      commentAutomation: {
        enabled: false,
        facebookEnabled: false,
        instagramEnabled: false,
        publicReplyEnabled: false,
        privateReplyEnabled: false,
        publicReplyStyle: "ai",
        fixedPublicReply: "",
        skipEmojiOnly: true,
        skipNestedReplies: true,
        activatedAt: null,
      },
      leadScoring: {
        enabled: false,
        inactivityMinutes: 10,
        maxConversationMinutes: 60,
        maxMessages: 40,
        activatedAt: null,
      },
      leadDistribution: {
        enabled: false,
        mode: "round_robin",
      },
    },
    onConfigUpdate: (payload) => {
      savedPayload = payload;
    },
  });

  await page.goto("/tools");
  await expect(page.getByRole("heading", { name: "Automated follow-up" })).toBeVisible();

  const mediaGroup = page.getByRole("radiogroup", {
    name: "Follow-up 1 media type",
  });

  await mediaGroup.getByRole("radio", { name: "Image" }).click();
  const imageInput = page.getByLabel("Follow-up 1 media image upload");

  await imageInput.setInputFiles({
    name: "follow-up.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-jpeg"),
  });
  await expect(page.getByRole("button", { name: "Remove image" })).toBeVisible();

  await mediaGroup.getByRole("radio", { name: "Video" }).click();
  await expect(mediaGroup.getByRole("radio", { name: "Video" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Add video" })).toBeVisible();
  const videoInput = page.getByLabel("Follow-up 1 media video upload");
  await videoInput.setInputFiles({
    name: "follow-up.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("fake-mp4"),
  });

  await expect(
    page.getByText(/MP4 only, up to 16MB/)
  ).toBeVisible();
  await expect(page.getByText(/automatically compressed/i)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Remove image" })).toHaveCount(0);
  await expect(page.getByText("follow-up.mp4", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();
  expect(savedPayload.automatedFollowUp).toMatchObject({
    imageUrl: "",
    videoKey: "clients/test-clinic/messages/follow-up-config/follow-up.mp4",
    videoFilename: "follow-up.mp4",
  });

  savedPayload = null;
  await mediaGroup.getByRole("radio", { name: "Image" }).click();
  await expect(mediaGroup.getByRole("radio", { name: "Image" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("button", { name: "Add image" })).toBeVisible();
  const replacementImageInput = page.getByLabel("Follow-up 1 media image upload");
  await replacementImageInput.setInputFiles({
    name: "follow-up-replacement.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("fake-jpeg-2"),
  });

  await expect(page.getByRole("button", { name: "Remove image" })).toBeVisible();
  await expect(page.getByText("follow-up.mp4", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();
  expect(savedPayload.automatedFollowUp).toMatchObject({
    imageUrl: "https://cdn.example.test/follow-up-step.jpg",
    videoKey: "",
    videoFilename: "",
  });

  await page.getByRole("button", { name: "Remove image" }).click();
  await expect(mediaGroup.getByRole("radio", { name: "No media" })).toHaveAttribute("aria-checked", "true");
  await mediaGroup.getByRole("radio", { name: "Video" }).click();
  await expect(page.getByRole("button", { name: "Add video" })).toBeVisible();

  await expectNoHorizontalPageOverflow(page);
});

test("staff can reach the main portal routes without page-level overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });

  for (const path of ["/inbox", "/pipeline", "/analytics", "/tools"]) {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace("/", "\\/") + "$"));
    await expect(page.getByRole("navigation").first()).toBeVisible();
    await expectNoHorizontalPageOverflow(page);
    if (path === "/analytics") {
      await expect(page.getByRole("img", { name: "New leads over time" })).toBeVisible();
      await expectNoHorizontalElementOverflow(page, "analytics-scroll");

      const viewport = page.viewportSize();
      if (viewport && viewport.width < 640) {
        const filterToggle = page.getByRole("button", { name: "Toggle analytics filters" });
        await expect(filterToggle).toBeVisible();
        await expect(filterToggle).toContainText("Last 30 days");
        await expect(page.getByLabel("Date range")).not.toBeVisible();

        await filterToggle.click();
        await expect(page.getByLabel("Date range")).toBeVisible();
        await page.getByLabel("Date range").selectOption("7");
        await expect(page.getByRole("button", { name: "Apply filters" })).toBeVisible();

        await filterToggle.click();
        await expect(filterToggle).toContainText("Unsaved");
        await expect(filterToggle).toContainText("Last 30 days");
        await expect(page.getByLabel("Date range")).not.toBeVisible();

        await filterToggle.click();
        await expect(page.getByLabel("Date range")).toBeVisible();
        await page.getByRole("button", { name: "Apply filters" }).click();

        await expect(filterToggle).toContainText("Last 7 days");
        await expect(filterToggle).not.toContainText("Unsaved");
        await expect(page.getByLabel("Date range")).not.toBeVisible();
      }
    }
  }
});


test("Meta Ads analytics renders spend-to-CRM metrics without horizontal page overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });
  await page.goto("/analytics");

  await page.getByRole("button", { name: "Meta Ads" }).click();
  const metaView = page.getByTestId("meta-ads-analytics");
  await expect(metaView).toBeVisible();
  await expect(page.getByText("Cost / Lead", { exact: true })).toBeVisible();
  await expect(page.getByText(/RM\s*25\.00/).first()).toBeVisible();
  const campaignNames = page.getByText("October Campaign", { exact: true });
  await expect.poll(async () => campaignNames.evaluateAll((nodes) =>
    nodes.filter((node) => node.getClientRects().length > 0).length
  )).toBe(1);
  await expect(page.getByText("100.0%", { exact: true })).toBeVisible();
  await expect(page.getByText("4.80×", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expectNoHorizontalElementOverflow(page, "meta-ads-analytics");
});

test("Meta Ads lead preview opens the correct attributed Inbox conversation", async ({ page }) => {
  const activeInbound = new Date().toISOString();
  await mockPortalApi(page, {
    loggedIn: true,
    conversations: [{
      contact_id: 42,
      channel: "whatsapp",
      name: "Alice Meta Lead",
      whatsapp_profile_name: "Alice Meta Lead",
      whatsapp_number: "60123456789",
      mode: "ai",
      needs_attention: false,
      needs_follow_up: false,
      is_unread: false,
      last_message: "Can I book the pelvis treatment?",
      last_message_role: "user",
      last_message_at: activeInbound,
      latest_inbound_at: activeInbound,
      latest_customer_message_at: activeInbound,
      lead_owner_username: "staff",
    }],
    conversationMessagesByContact: {
      42: [{
        id: 501,
        contact_id: 42,
        role: "user",
        content: "Can I book the pelvis treatment?",
        created_at: "2026-10-04T12:00:00.000Z",
      }],
    },
    conversationAttributionByContact: {
      42: {
        lead: {
          id: 7001,
          contactId: 42,
          temperature: "hot",
          treatmentInterest: "Pelvis",
          stageName: "Appointment",
          stageType: "open",
        },
        attribution: {
          source: "meta_ads",
          channel: "whatsapp",
          platform: "whatsapp",
          meta_ad_id: "300",
          meta_account_id: "123",
          campaign_id: "100",
          campaign_name: "October Campaign",
          adset_id: "200",
          adset_name: "Women KL",
          ad_name: "Pelvis Creative",
          enrichment_status: "enriched",
        },
      },
    },
    metaAdsLeadPreview: {
      total: 1,
      leads: [{
        leadId: 7001,
        contactId: 42,
        name: "Alice Meta Lead",
        channel: "whatsapp",
        temperature: "hot",
        treatmentInterest: "Pelvis",
        stageName: "Appointment",
        stageType: "open",
        reachedAppointment: true,
        reachedVisited: false,
        reachedWon: false,
        metaAdId: "300",
        campaignId: "100",
        campaignName: "October Campaign",
        adsetId: "200",
        adsetName: "Women KL",
        adName: "Pelvis Creative",
        lastMessage: "Can I book the pelvis treatment?",
        canOpenConversation: true,
      }],
    },
  });

  await page.goto("/analytics");
  await page.getByRole("button", { name: "Meta Ads" }).click();
  await page.getByRole("button", { name: "Show chatbot leads" }).click();

  await expect(page.getByText("Alice Meta Lead", { exact: true })).toBeVisible();
  await expect(page.getByText("Pelvis Creative", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open chat" }).click();

  await expect(page).toHaveURL(/\/inbox\?contact=42$/);
  const conversationThread = page.locator('section[aria-label="Conversation with Alice Meta Lead"]');
  await expect(conversationThread).toBeVisible();
  await expect(conversationThread.getByRole("heading", { name: "Alice Meta Lead", exact: true })).toBeVisible();
  await expect(page.getByText("Meta Ads", { exact: true })).toBeVisible();
  await expect(page.getByText("Pelvis Creative", { exact: true })).toBeVisible();
  const viewport = page.viewportSize();
  if (viewport && viewport.width >= 640) {
    await expect(page.getByText("October Campaign", { exact: true })).toBeVisible();
  }

  const sidebar = page.getByTestId("app-sidebar");
  await expect(page.getByPlaceholder("Reply…")).toBeVisible();
  if (viewport && viewport.width < 1024) {
    await expect(sidebar).not.toBeVisible();
    const threadBox = await conversationThread.boundingBox();
    expect(threadBox).not.toBeNull();
    expect(Math.round(threadBox.x)).toBe(0);

    await page.getByRole("button", { name: "Back to conversations" }).click();
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(sidebar).toBeVisible();
    await expect(page.getByLabel("Conversation inbox")).toBeVisible();
  } else {
    await expect(sidebar).toBeVisible();
  }
});

test("invalid Inbox contact links restore the conversation list and navigation", async ({ page }) => {
  const activeInbound = new Date().toISOString();
  await mockPortalApi(page, {
    loggedIn: true,
    conversations: [{
      contact_id: 42,
      channel: "whatsapp",
      name: "Alice Inbox Lead",
      whatsapp_profile_name: "Alice Inbox Lead",
      whatsapp_number: "60123456789",
      mode: "ai",
      needs_attention: false,
      needs_follow_up: false,
      is_unread: false,
      last_message: "Hello",
      last_message_role: "user",
      last_message_at: activeInbound,
      latest_inbound_at: activeInbound,
      latest_customer_message_at: activeInbound,
      lead_owner_username: "staff",
    }],
  });

  const sidebar = page.getByTestId("app-sidebar");
  for (const target of ["/inbox?contact=not-a-contact", "/inbox?contact=999999"]) {
    await page.goto(target);
    await expect(page).toHaveURL(/\/inbox$/);
    await expect(sidebar).toBeVisible();
    await expect(page.getByLabel("Conversation inbox")).toBeVisible();
  }
});

test("mobile Pipeline keeps controls compact and prioritizes lead cards", async ({ page }) => {
  const viewport = page.viewportSize();
  test.skip(!viewport || viewport.width >= 640, "phone-only layout");

  await mockPortalApi(page, {
    loggedIn: true,
    pipelineData: {
      stages: [
        { id: 1, name: "New Lead", stage_type: "new", color: "#3c8d7b" },
        { id: 2, name: "Contacted", stage_type: "contacted", color: "#3d8dad" },
      ],
      leads: [
        {
          id: 101,
          stage_id: 1,
          name: "Mobile Test Lead",
          temperature: "warm",
          is_closed: false,
          branch_name: "Petaling Jaya (PJ)",
          source: "facebook_organic",
          last_message_at: "2026-10-01T12:00:00.000Z",
          appointment_status: null,
          estimated_value: 0,
        },
      ],
      branches: ["Petaling Jaya (PJ)"],
      owners: [],
      services: [],
      noReplyHours: 24,
    },
  });
  await page.goto("/pipeline");

  const sidebar = page.getByTestId("app-sidebar");
  await expect(sidebar).toBeVisible();
  await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(64);

  await expect(page.getByRole("heading", { name: "Lead Pipeline" })).toBeVisible();
  const addLead = page.getByRole("button", { name: "+ Add" });
  const manageStages = page.getByRole("button", { name: "Manage pipeline stages" });
  await expect(addLead).toBeVisible();
  await expect(manageStages).toBeVisible();

  const search = page.getByLabel("Search leads");
  const filters = page.getByRole("button", { name: /^Filters/ });
  await expect(search).toBeVisible();
  await expect(filters).toBeVisible();
  const [searchBox, filtersBox, addLeadBox, manageStagesBox] = await Promise.all([
    search.boundingBox(),
    filters.boundingBox(),
    addLead.boundingBox(),
    manageStages.boundingBox(),
  ]);
  expect(searchBox).not.toBeNull();
  expect(filtersBox).not.toBeNull();
  expect(addLeadBox).not.toBeNull();
  expect(manageStagesBox).not.toBeNull();
  expect(Math.abs(searchBox.y - filtersBox.y)).toBeLessThanOrEqual(1);
  expect(Math.round(searchBox.height)).toBe(44);
  expect(Math.round(filtersBox.height)).toBe(44);
  expect(Math.round(addLeadBox.height)).toBe(44);
  expect(Math.round(manageStagesBox.height)).toBe(44);

  await expect(page.getByLabel("Filter by lead source")).not.toBeVisible();
  await expect(page.getByRole("button", { name: /All branches/ })).not.toBeVisible();
  const allLeads = page.getByRole("button", { name: /^All leads 1$/ });
  const hot = page.getByRole("button", { name: /^Hot 0$/ });
  const warm = page.getByRole("button", { name: /^Warm 1$/ });
  await expect(allLeads).toBeVisible();
  await expect(hot).toBeVisible();
  await expect(warm).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: true })).not.toBeVisible();
  for (const quickFilter of [allLeads, hot, warm]) {
    const box = await quickFilter.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box.height)).toBe(44);
  }

  await expect(page.getByRole("button", { name: /New Lead 1/ })).toBeVisible();
  const leadCard = page.getByRole("button", { name: /Mobile Test Lead/ });
  await expect(leadCard).toBeVisible();
  const leadBox = await leadCard.boundingBox();
  expect(leadBox).not.toBeNull();
  expect(leadBox.y).toBeLessThan(500);

  await filters.click();
  const dialog = page.getByRole("dialog", { name: "Pipeline filters" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Filter by branch")).toBeVisible();
  await expect(page.getByLabel("Filter by source")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Needs attention/ })).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(Math.round(dialogBox.x)).toBe(64);

  const closeFilters = page.getByRole("button", { name: "Close filters" });
  await expect(closeFilters).toBeFocused();
  const closeBox = await closeFilters.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(Math.round(closeBox.height)).toBe(44);
  expect(Math.round(closeBox.width)).toBe(44);

  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: /Show 1 leads/ })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeFilters).toBeFocused();

  // Crossing the 640px breakpoint while the sheet is open must release the
  // phone focus trap and restore focus to the still-visible Filters trigger.
  await page.setViewportSize({ width: 834, height: 1194 });
  await expect(dialog).not.toBeVisible();
  await expect(filters).toBeFocused();
  await expect(page.getByLabel("Filter by lead source")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Needs attention 0$/ })).toBeVisible();

  // Returning to phone width while filters remain open should reactivate the
  // modal trap and put focus back inside the sheet.
  await page.setViewportSize({ width: 430, height: 932 });
  await expect(dialog).toBeVisible();
  await expect(closeFilters).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(filters).toBeFocused();
  await expectNoHorizontalPageOverflow(page);
});


test("tablet and normal desktop Pipeline keep Needs attention as a quick filter", async ({ page }) => {
  const viewport = page.viewportSize();
  test.skip(!viewport || viewport.width < 640 || viewport.width >= 1800, "tablet/normal-desktop layout only");

  await mockPortalApi(page, {
    loggedIn: true,
    pipelineData: {
      stages: [{ id: 1, name: "New Lead", stage_type: "new", color: "#3c8d7b" }],
      leads: [{
        id: 102,
        stage_id: 1,
        name: "Attention Test Lead",
        temperature: "warm",
        is_closed: false,
        needs_attention: true,
        branch_name: "Petaling Jaya (PJ)",
        source: "facebook_organic",
        last_message_at: "2026-10-01T12:00:00.000Z",
      }],
      branches: ["Petaling Jaya (PJ)"],
      owners: [],
      services: [],
      noReplyHours: 24,
    },
  });
  await page.goto("/pipeline");

  const attention = page.getByRole("button", { name: /^Needs attention 1$/ });
  await expect(attention).toBeVisible();
  await attention.click();
  await expect(attention).toHaveClass(/bg-\[var\(--color-primary\)\]/);
  await expect(page.getByRole("button", { name: /Attention Test Lead/ })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});


test("Pipeline tablet portrait layout keeps compact navigation and visible working filters", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop-chromium", "targeted responsive viewport check");
  await page.setViewportSize({ width: 834, height: 1194 });

  await mockPortalApi(page, {
    loggedIn: true,
    pipelineData: {
      stages: [
        { id: 1, name: "New Lead", stage_type: "new", color: "#3c8d7b" },
        { id: 2, name: "Contacted", stage_type: "contacted", color: "#3d8dad" },
      ],
      leads: [{
        id: 103,
        stage_id: 1,
        name: "Tablet Portrait Lead",
        temperature: "hot",
        is_closed: false,
        needs_attention: true,
        branch_name: "Petaling Jaya (PJ)",
        source: "facebook_organic",
        last_message_at: "2026-10-01T12:00:00.000Z",
      }],
      branches: ["Petaling Jaya (PJ)"],
      owners: [],
      services: [],
      noReplyHours: 24,
    },
  });
  await page.goto("/pipeline");

  const sidebar = page.getByTestId("app-sidebar");
  await expect(sidebar).toBeVisible();
  await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(72);

  await expect(page.getByLabel("Filter by lead source")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Needs attention 1$/ })).toBeVisible();
  await expect(page.getByTestId("pipeline-branch-rail").getByRole("button", { name: /Petaling Jaya \(PJ\)/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /New Lead 1/ })).toBeVisible();
  await expect(page.getByTestId("pipeline-mobile-leads")).toBeVisible();
  await expect(page.locator("main.ui-kanban-scroll")).not.toBeVisible();

  const filters = page.getByRole("button", { name: /^Filters/ });
  await filters.click();
  await expect(page.getByRole("dialog", { name: "Pipeline filters" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^Cold 0$/ })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});


test("Pipeline wide desktop restores full metrics, categories and Kanban", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop-chromium", "targeted responsive viewport check");
  await page.setViewportSize({ width: 1920, height: 1080 });

  await mockPortalApi(page, {
    loggedIn: true,
    pipelineData: {
      stages: [
        { id: 1, name: "New Lead", stage_type: "new", color: "#3c8d7b" },
        { id: 2, name: "Contacted", stage_type: "contacted", color: "#3d8dad" },
      ],
      leads: [{
        id: 104,
        stage_id: 1,
        name: "Wide Desktop Lead",
        temperature: "hot",
        is_closed: false,
        needs_attention: true,
        branch_name: "Petaling Jaya (PJ)",
        source: "facebook_organic",
        estimated_value: 2500,
        last_message_at: "2026-10-01T12:00:00.000Z",
      }],
      branches: ["Petaling Jaya (PJ)"],
      owners: [],
      services: [],
      noReplyHours: 24,
    },
  });
  await page.goto("/pipeline");

  const sidebar = page.getByTestId("app-sidebar");
  await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(220);

  await expect(page.getByText("Active leads", { exact: true })).toBeVisible();
  await expect(page.getByText("Hot leads", { exact: true })).toBeVisible();
  await expect(page.getByText("Pipeline value", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter by lead source")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Filters/ })).not.toBeVisible();
  await expect(page.getByRole("button", { name: /^All leads 1$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Needs attention 1$/ })).toBeVisible();
  await expect(page.locator("main.ui-kanban-scroll")).toBeVisible();
  await expect(page.getByRole("button", { name: /Wide Desktop Lead/ })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});


test("sidebar uses responsive compact and expanded states and remembers the choice", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true });
  await page.goto("/inbox");

  const viewport = page.viewportSize();
  const sidebar = page.getByTestId("app-sidebar");
  const firstLabel = sidebar.locator(".app-sidebar-label").first();
  const toggle = sidebar.locator(".app-sidebar-toggle");

  await expect(sidebar).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect.poll(async () => {
    const box = await toggle.boundingBox();
    return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null;
  }).toEqual({ width: 44, height: 44 });
  await expectNoHorizontalPageOverflow(page);

  if (viewport.width < 640) {
    await expect(sidebar).toHaveAttribute("data-mobile-open", "false");
    await expect(toggle).toHaveAccessibleName("Open sidebar");
    await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(64);
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-mobile-open", "true");
    await expect(toggle).toHaveAccessibleName("Close sidebar");
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    await expect.poll(() => sidebar.locator(".app-sidebar-nav").evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(220);

    const backdrop = page.getByRole("button", { name: "Dismiss navigation" });
    await expect(backdrop).toBeVisible();
    await expect.poll(async () => {
      const box = await backdrop.boundingBox();
      return box ? Math.round(box.x) : null;
    }).toBe(220);
    await expectNoHorizontalPageOverflow(page);

    await backdrop.click();
    await expect(sidebar).toHaveAttribute("data-mobile-open", "false");
    await expect(toggle).toHaveAccessibleName("Open sidebar");
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-mobile-open", "true");
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveAttribute("data-mobile-open", "false");
    await expect(toggle).toHaveAccessibleName("Open sidebar");
    return;
  }

  if (viewport.width >= 1280) {
    await expect(sidebar).toHaveAttribute("data-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Collapse sidebar");
    await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(220);
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
    await expect(toggle).toHaveAccessibleName("Expand sidebar");
    await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(72);
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");

    await page.getByRole("link", { name: "Inbox" }).hover();
    await expect(page.getByRole("tooltip")).toHaveText("Inbox");

    await page.reload();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-expanded", "false");
    await expect.poll(() => page.getByTestId("app-sidebar").evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(72);
  } else {
    await expect(sidebar).toHaveAttribute("data-expanded", "false");
    await expect(toggle).toHaveAccessibleName("Expand sidebar");
    await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(72);
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("0");

    await toggle.click();
    await expect(sidebar).toHaveAttribute("data-expanded", "true");
    await expect(toggle).toHaveAccessibleName("Collapse sidebar");
    await expect.poll(() => sidebar.evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(220);
    await expect.poll(() => firstLabel.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");

    await page.reload();
    await expect(page.getByTestId("app-sidebar")).toHaveAttribute("data-expanded", "true");
    await expect.poll(() => page.getByTestId("app-sidebar").evaluate((node) => Math.round(node.getBoundingClientRect().width))).toBe(220);
  }

  await expect(page.getByRole("navigation", { name: "Utility navigation" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});


test("Advanced Config keeps a full long FAQ identity readable without horizontal overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true, user: ADMIN_USER });
  await page.goto("/settings/advanced-config");

  const editor = page.getByLabel("JSON configuration");
  await editor.fill(JSON.stringify({
    faqs: [{ q: LONG_FAQ_QUESTION, a: "新的完整答案，会先了解你的情况再建议合适的评估。" }],
  }, null, 2));
  await page.getByRole("button", { name: "Validate & review" }).click();

  const faqSection = page.getByTestId("config-change-faqs");
  await expect(faqSection).toBeVisible();
  await faqSection.locator("summary").first().click();
  await expect(faqSection.getByText(LONG_FAQ_QUESTION, { exact: true })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  await faqSection.getByText(LONG_FAQ_QUESTION, { exact: true }).click();
  await expect(faqSection.getByText("新的完整答案，会先了解你的情况再建议合适的评估。", { exact: true })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("Advanced Config shows pure guardrail reordering instead of counts only", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true, user: ADMIN_USER });
  await page.goto("/settings/advanced-config");

  const editor = page.getByLabel("JSON configuration");
  await editor.fill(JSON.stringify({ guardrails: ["Rule C", "Rule A", "Rule B"] }, null, 2));
  await page.getByRole("button", { name: "Validate & review" }).click();

  const guardrailSection = page.getByTestId("config-change-guardrails");
  await expect(guardrailSection).toBeVisible();
  await expect(guardrailSection.getByText("Order changed", { exact: true }).first()).toBeVisible();
  await guardrailSection.locator("summary").first().click();

  await expect(guardrailSection.getByText("Before", { exact: true })).toBeVisible();
  await expect(guardrailSection.getByText("After", { exact: true })).toBeVisible();
  await expect(guardrailSection.getByText("Rule C", { exact: true }).first()).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("admin can review meaningful Advanced Config diff and apply without horizontal overflow", async ({ page }) => {
  await mockPortalApi(page, { loggedIn: true, user: ADMIN_USER });
  await page.goto("/settings/advanced-config");

  await expect(page).toHaveURL(/\/settings\/advanced-config$/);
  await expect(page.getByRole("heading", { name: "Advanced Config" })).toBeVisible();
  await expect(page.getByLabel("JSON configuration")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  const editor = page.getByLabel("JSON configuration");
  await editor.fill(JSON.stringify({ tone: "Short and friendly" }, null, 2));
  await page.getByRole("button", { name: "Validate & review" }).click();

  await expect(page.getByRole("heading", { name: "Review changes" })).toBeVisible();
  await expect(page.getByText("1 section changed", { exact: false })).toBeVisible();
  await expect(page.getByText("Tone", { exact: true })).toBeVisible();
  await expect(page.getByText("Text changed", { exact: true })).toBeVisible();
  await expect(page.getByText("Short and friendly", { exact: true })).toBeHidden();

  await page.getByText("Tone", { exact: true }).click();
  await expect(page.getByText("Warm and professional", { exact: true })).toBeVisible();
  await expect(page.getByText("Short and friendly", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Apply changes" }).click();
  await expect(page.getByText("Configuration changes applied.")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});


test("Promotions keeps package setup compact, saves packages, and stays mobile-safe", async ({ page }) => {
  let savedPayload = null;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      businessDescription: "TCM test clinic",
      aiAssistantName: "Ava",
      introMessage: "Hi",
      tone: "Warm",
      services: [
        {
          name: "Pelvis 骨盆调理",
          description: "",
          priceRange: "",
          duration: "",
        },
      ],
      serviceAliases: [],
      promotions: [],
      branches: [],
      faqs: [],
      guardrails: [],
      escalation: {
        outOfScopeTriggers: [],
        handoffMessage: "",
        handoffNote: "",
      },
      hours: { general: "", closed: "" },
      contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
      messagingStyle: "",
      closingPlaybook: "",
      sop: "",
    },
    onConfigUpdate: (payload) => {
      savedPayload = payload;
    },
  });

  await page.goto("/settings?tab=promotions");

  await expect(page.getByRole("heading", { name: "Promotions" })).toBeVisible();
  await page.getByRole("button", { name: "+ Add promotion" }).click();

  await expect(page.getByText("Pelvis 骨盆调理", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Single offer", pressed: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Multiple packages", pressed: false })).toBeVisible();

  await page.getByRole("button", { name: "Multiple packages" }).click();
  await expect(page.getByRole("button", { name: "Multiple packages", pressed: true })).toBeVisible();
  await page.getByRole("button", { name: "+ Add package" }).click();

  await page.getByPlaceholder("Package A").fill("Package A");
  await page
    .getByPlaceholder("全身深层调理 + 骨盆全身体态调整（7合1）")
    .fill("全身深层调理 + 骨盆全身体态调整（7合1）");

  const aliasInput = page.getByPlaceholder("e.g. 子宫套餐, 7合1");
  await aliasInput.fill("7合1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("7合1", { exact: true })).toBeVisible();

  const promotionImageField = page
    .getByText("Promotion image", { exact: true })
    .locator("..");
  await expect(
    promotionImageField.getByText("Advanced · use image URL", { exact: true })
  ).toBeVisible();
  await expect(promotionImageField.getByPlaceholder("https://...")).toBeHidden();
  await promotionImageField
    .getByText("Advanced · use image URL", { exact: true })
    .click();
  await promotionImageField
    .getByPlaceholder("https://...")
    .fill("https://example.test/package-a.jpg");
  await page
    .getByText("Caption sent with this image", { exact: true })
    .locator("..")
    .locator("textarea")
    .fill("Package A promo caption");

  await page.getByRole("button", { name: "Close package", exact: true }).click();
  await expect(page.getByText("Package A", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("全身深层调理 + 骨盆全身体态调整（7合1）", { exact: true }).first()
  ).toBeVisible();

  await page.getByRole("button", { name: "Save promotions" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();
  expect(savedPayload.promotions).toEqual([
    {
      name: "Pelvis 骨盆调理 Promotion",
      linkedService: "Pelvis 骨盆调理",
      sendOnPriceQuery: true,
      packages: [
        {
          name: "Package A",
          title: "全身深层调理 + 骨盆全身体态调整（7合1）",
          aliases: ["7合1"],
          imageUrl: "https://example.test/package-a.jpg",
          caption: "Package A promo caption",
        },
      ],
      imageUrl: "",
      caption: "",
      validFrom: null,
      validUntil: null,
    },
  ]);

  await expectNoHorizontalPageOverflow(page);
});


test("Promotions blocks saving Multiple packages with no package options", async ({ page }) => {
  let savedPayload = null;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      businessDescription: "TCM test clinic",
      aiAssistantName: "Ava",
      introMessage: "Hi",
      tone: "Warm",
      services: [{ name: "Pelvis 骨盆调理", description: "", priceRange: "", duration: "" }],
      serviceAliases: [],
      promotions: [],
      branches: [],
      faqs: [],
      guardrails: [],
      escalation: { outOfScopeTriggers: [], handoffMessage: "", handoffNote: "" },
      hours: { general: "", closed: "" },
      contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
      messagingStyle: "",
      closingPlaybook: "",
      sop: "",
    },
    onConfigUpdate: (payload) => {
      savedPayload = payload;
    },
  });

  await page.goto("/settings?tab=promotions");
  await page.getByRole("button", { name: "+ Add promotion" }).click();
  await page.getByRole("button", { name: "Multiple packages" }).click();
  await page.getByRole("button", { name: "Save promotions" }).click();

  await expect(
    page.getByText("Add at least one package, or switch this promotion to Single offer.")
  ).toBeVisible();
  expect(savedPayload).toBeNull();
});

test("Promotions confirms before switching a populated package campaign to Single offer", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      businessDescription: "TCM test clinic",
      aiAssistantName: "Ava",
      introMessage: "Hi",
      tone: "Warm",
      services: [{ name: "Pelvis 骨盆调理", description: "", priceRange: "", duration: "" }],
      serviceAliases: [],
      promotions: [
        {
          name: "Pelvis 骨盆调理 Promotion",
          linkedService: "Pelvis 骨盆调理",
          sendOnPriceQuery: true,
          packages: [
            {
              name: "Package A",
              title: "7合1",
              aliases: ["A"],
              imageUrl: "https://example.test/a.jpg",
              caption: "A promo",
            },
            {
              name: "Package B",
              title: "子宫套餐",
              aliases: ["B"],
              imageUrl: "https://example.test/b.jpg",
              caption: "B promo",
            },
          ],
          imageUrl: "",
          caption: "",
          validFrom: null,
          validUntil: null,
        },
      ],
      branches: [],
      faqs: [],
      guardrails: [],
      escalation: { outOfScopeTriggers: [], handoffMessage: "", handoffNote: "" },
      hours: { general: "", closed: "" },
      contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
      messagingStyle: "",
      closingPlaybook: "",
      sop: "",
    },
  });

  await page.goto("/settings?tab=promotions");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Multiple packages", pressed: true })).toBeVisible();

  const dismissDialog = page.waitForEvent("dialog");
  const firstClick = page.getByRole("button", { name: "Single offer" }).click();
  const firstDialog = await dismissDialog;
  expect(firstDialog.message()).toContain("Changing to Single offer will remove 2 package options when you save.");
  await firstDialog.dismiss();
  await firstClick;
  await expect(page.getByRole("button", { name: "Multiple packages", pressed: true })).toBeVisible();

  const acceptDialog = page.waitForEvent("dialog");
  const secondClick = page.getByRole("button", { name: "Single offer" }).click();
  const secondDialog = await acceptDialog;
  await secondDialog.accept();
  await secondClick;
  await expect(page.getByRole("button", { name: "Single offer", pressed: true })).toBeVisible();
});


test("Promotions confirms before switching a populated Single offer to Multiple packages", async ({ page }) => {
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      businessDescription: "TCM test clinic",
      aiAssistantName: "Ava",
      introMessage: "Hi",
      tone: "Warm",
      services: [{ name: "3D 小颜术", description: "", priceRange: "", duration: "" }],
      serviceAliases: [],
      promotions: [
        {
          name: "3D 小颜术 Promotion",
          linkedService: "3D 小颜术",
          sendOnPriceQuery: true,
          packages: [],
          imageUrl: "https://example.test/3d.jpg",
          caption: "3D promo",
          validFrom: null,
          validUntil: null,
        },
      ],
      branches: [],
      faqs: [],
      guardrails: [],
      escalation: { outOfScopeTriggers: [], handoffMessage: "", handoffNote: "" },
      hours: { general: "", closed: "" },
      contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
      messagingStyle: "",
      closingPlaybook: "",
      sop: "",
    },
  });

  await page.goto("/settings?tab=promotions");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Single offer", pressed: true })).toBeVisible();

  const dialogPromise = page.waitForEvent("dialog");
  const clickPromise = page.getByRole("button", { name: "Multiple packages" }).click();
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain(
    "Changing to Multiple packages will remove the current single-offer image, caption, first follow-up offer, and first follow-up graphic when you save."
  );
  await dialog.dismiss();
  await clickPromise;

  await expect(page.getByRole("button", { name: "Single offer", pressed: true })).toBeVisible();
});


test("Service Terms supports bulk paste, duplicate skipping, conflict blocking, and mobile-safe save", async ({ page }) => {
  let savedPayload = null;
  await mockPortalApi(page, {
    loggedIn: true,
    businessConfig: {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      businessDescription: "TCM test clinic",
      aiAssistantName: "Ava",
      introMessage: "Hi",
      tone: "Warm",
      services: [
        { name: "骨盆调理", description: "", priceRange: "", duration: "" },
        { name: "9D 逆龄抗衰", description: "", priceRange: "", duration: "" },
      ],
      serviceAliases: [
        { alias: "骨盆", officialService: "骨盆调理" },
        { alias: "9D", officialService: "9D 逆龄抗衰" },
      ],
      promotions: [],
      branches: [],
      faqs: [],
      guardrails: [],
      escalation: { outOfScopeTriggers: [], handoffMessage: "", handoffNote: "" },
      hours: { general: "", closed: "" },
      contact: { whatsapp: "", instagram: "", facebook: "", tiktok: "" },
      messagingStyle: "",
      closingPlaybook: "",
      sop: "",
    },
    onConfigUpdate: (payload) => {
      savedPayload = payload;
    },
  });

  await page.goto("/settings?tab=aliases");

  await expect(page.getByRole("heading", { name: "Service Terms" })).toBeVisible();
  await expect(page.getByText("Quick add terms", { exact: true })).toBeVisible();
  await expect(page.getByText("2 terms across 2 services.", { exact: true })).toBeVisible();

  await page.getByLabel("Maps to service", { exact: true }).selectOption("骨盆调理");
  const bulkInput = page.locator("textarea").first();
  await bulkInput.fill("骨盘\n骨盆调整，pelvic adjustment\n骨盆");
  await page.getByRole("button", { name: "Add terms", exact: true }).first().click();

  await expect(
    page.getByText("Added 3 terms to 骨盆调理. Skipped 1 already-added duplicate.")
  ).toBeVisible();
  await expect(page.getByText("骨盘", { exact: true })).toBeVisible();
  await expect(page.getByText("骨盆调整", { exact: true })).toBeVisible();
  await expect(page.getByText("pelvic adjustment", { exact: true })).toBeVisible();

  await bulkInput.fill("9D");
  await page.getByRole("button", { name: "Add terms", exact: true }).first().click();
  await expect(
    page.getByText("“9D” is already mapped to “9D 逆龄抗衰”. Remove it there first if you want to remap it.")
  ).toBeVisible();

  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => savedPayload).not.toBeNull();

  expect(savedPayload.serviceAliases).toEqual([
    { alias: "骨盆", officialService: "骨盆调理" },
    { alias: "9D", officialService: "9D 逆龄抗衰" },
    { alias: "骨盘", officialService: "骨盆调理" },
    { alias: "骨盆调整", officialService: "骨盆调理" },
    { alias: "pelvic adjustment", officialService: "骨盆调理" },
  ]);

  await expectNoHorizontalPageOverflow(page);
});
