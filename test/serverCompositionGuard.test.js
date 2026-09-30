const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const serverSource = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../src/createApp.js"), "utf8");

test("server entry point delegates Express composition without moving message processing", () => {
  assert.match(serverSource, /async function processIncomingMessage\(/);
  assert.match(serverSource, /async function processIncomingBatch\(/);
  assert.match(serverSource, /const app = createApp\(\{/);
  assert.match(serverSource, /startApplication\(\{/);

  assert.doesNotMatch(serverSource, /const app = express\(\)/);
  assert.doesNotMatch(serverSource, /app\.use\(/);
  assert.doesNotMatch(serverSource, /app\.get\(/);
  assert.doesNotMatch(serverSource, /app\.post\(/);
});

test("application composition preserves security and readiness middleware ordering", () => {
  const portalParserAt = appSource.indexOf('app.use("/api", createPortalJsonParser())');
  const sessionAt = appSource.indexOf('cookieSession({');
  const rootHealthAt = appSource.indexOf('app.get("/", startupReadiness.rootReadinessHandler)');
  const readinessGateAt = appSource.indexOf("app.use(startupReadiness.requireReady)");
  const whatsappAt = appSource.indexOf('app.get("/webhook"');
  const opsAt = appSource.indexOf('app.use("/api/ops/readiness", opsReadinessRoutes)');
  const authAt = appSource.indexOf('app.use("/api/auth", authRoutes)');
  const protectedConversationsAt = appSource.indexOf(
    'app.use("/api/conversations", requireAuth, conversationsRoutes)'
  );
  const payloadHandlerAt = appSource.indexOf("app.use(payloadTooLargeErrorHandler)");
  const staticAt = appSource.indexOf("app.use(express.static(portalBuildPath))");

  assert.ok(portalParserAt >= 0, "portal JSON parser should remain installed");
  assert.ok(sessionAt > portalParserAt, "session middleware should stay after portal parsing");
  assert.ok(rootHealthAt > sessionAt, "health routes should remain after API session setup");
  assert.ok(readinessGateAt > rootHealthAt, "readiness must gate non-health traffic");
  assert.ok(whatsappAt > readinessGateAt, "webhook traffic must stay readiness-gated");
  assert.ok(opsAt > whatsappAt, "Ops endpoint should remain after webhook routes");
  assert.ok(authAt > opsAt, "Ops readiness must remain outside portal auth");
  assert.ok(protectedConversationsAt > authAt, "portal data routes must remain authenticated");
  assert.ok(payloadHandlerAt > protectedConversationsAt, "413 handler stays after parsed routes");
  assert.ok(staticAt > payloadHandlerAt, "portal static fallback stays last");
});

test("webhook parsers still verify raw signatures and portal routes stay protected", () => {
  assert.match(
    appSource,
    /createWebhookJsonParser\(verifyWebhookSignature\)/
  );
  assert.match(
    appSource,
    /createWebhookJsonParser\(verifyMetaWebhookSignature\)/
  );
  assert.match(appSource, /app\.post\("\/webhook", webhookJsonParser/);
  assert.match(appSource, /app\.post\("\/meta-webhook", metaWebhookJsonParser/);

  assert.match(
    appSource,
    /app\.set\("trust proxy", resolveTrustProxy\(process\.env\)\)/
  );
  assert.match(
    appSource,
    /verifyTokenMatches\(token, process\.env\.WHATSAPP_VERIFY_TOKEN\)/
  );
  assert.match(
    appSource,
    /verifyTokenMatches\(token, process\.env\.META_VERIFY_TOKEN\)/
  );
  assert.doesNotMatch(
    appSource,
    /token === process\.env\.(WHATSAPP_VERIFY_TOKEN|META_VERIFY_TOKEN)/
  );

  for (const route of [
    "conversations",
    "config",
    "contacts",
    "pipeline",
    "setup-status",
    "go-live",
  ]) {
    const pattern = new RegExp(
      `app\\.use\\("\\/api\\/${route.replace("-", "\\-")}", requireAuth,`
    );
    assert.match(appSource, pattern);
  }
});


test("urgent safety handling bypasses model generation and first-message intro copy", () => {
  const urgentBranchAt = serverSource.indexOf("if (urgentSafety) {");
  const aiCallAt = serverSource.indexOf("const rawAiReply = await ai.getReply");
  const replyAt = serverSource.indexOf("const reply = isFirstMessage && !urgentSafety");

  assert.ok(urgentBranchAt >= 0, "urgent deterministic branch should exist");
  assert.ok(aiCallAt > urgentBranchAt, "AI generation must be nested after the urgent branch");
  assert.ok(replyAt > aiCallAt, "reply composition should follow deterministic/model selection");
  assert.match(
    serverSource,
    /fallbackHandoffReply\([\s\S]*?\{ urgent: true \}/
  );
});
